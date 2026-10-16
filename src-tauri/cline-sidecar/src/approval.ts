/**
 * Origin — Pont d'outils et d'approbations côté sidecar.
 *
 * RÔLE
 * ----
 * Le moteur Cline exécuterait ses outils par défaut sans jamais consulter
 * Origin : écriture de fichiers directe, shell direct, aucune confirmation,
 * et — pire — des écritures invisibles pour les **checkpoints** de l'app
 * (undo all / keep all par tour).
 *
 * Ce module rétablit le contrôle d'Origin en n'interceptant QUE deux points,
 * volontairement :
 *
 *   1. **`requestToolApproval`** (capability du SDK) — chaque outil dont la
 *      politique n'est pas `autoApprove` déclenche cette fonction. On la
 *      transmet au front, qui applique `permissions.ts` et répond. C'est le
 *      garde-fou d'autorisation : rien ne s'exécute sans verdict explicite
 *      pour les outils sensibles.
 *
 *   2. **`onBeforeWrite`** (enveloppe des exécuteurs d'écriture) — AVANT
 *      qu'un outil n'écrive sur disque, on prévient le front avec le chemin
 *      touché. Le front appelle alors `touchTurn(path)`, ce qui alimente le
 *      checkpoint du tour : l'undo/keep reste IDENTIQUE au comportement
 *      historique, alors même que l'écriture est faite par Node (pas par Rust).
 *
 * POURQUOI ON ENVELOPPE LES EXÉCUTEURS NATIFS
 * -------------------------------------------
 * Réimplémenter l'écriture de fichiers serait une source de bugs (encodage,
 * insert_line, diffs, apply_patch, confinement cwd). On DÉLÈGUE donc à
 * `createDefaultExecutors()` du SDK et on ne fait qu'observer (hook) — on ne
 * duplique aucune logique d'exécution.
 *
 * PROTOCOLE (NDJSON sur stdin/stdout, cf. `index.ts`)
 * ---------------------------------------------------
 *   sidecar → front (bloquant) :
 *     { kind: "tool_approval", requestId, toolName, input, policy }
 *     { kind: "tool_write", requestId, paths: string[] }
 *
 *   front → sidecar (réponses) :
 *     { id, type: "tool_approval_response", requestId, approved, reason? }
 *     { id, type: "tool_write_response", requestId }
 *
 * Chaque demande porte un `requestId` unique : plusieurs demandes peuvent être
 * en vol (outils concurrents) sans se mélanger.
 *
 * SÉCURITÉ
 * --------
 *   - Le sidecar **n'exécute jamais** un outil sensible sans avoir reçu une
 *     approbation explicite du front (sauf politique `autoApprove` du SDK).
 *   - Le front applique la politique d'Origin (`permissions.ts`), qui inclut le
 *     confinement au workspace et le refus des commandes destructrices.
 *   - Aucun secret ne circule dans ces messages : uniquement noms d'outils,
 *     entrées (déjà destinées au modèle) et chemins.
 */

import type {
  ToolApprovalRequest,
  ToolApprovalResult,
} from "@cline/shared";
import {
  computePatchChanges,
  createDefaultExecutors,
  type ToolExecutors,
  type EditorExecutor,
  type ApplyPatchExecutor,
} from "@cline/core";

// ── Demandeur de canal (injecté par index.ts) ────────────────────────────────

/**
 * Demande au front (via stdout) une décision, et attend sa réponse (via
 * stdin). `index.ts` fournit l'implémentation : il écrit la ligne NDJSON et
 * enregistre un résolveur dans une table `requestId → resolve`.
 */
export type ApprovalTransport = {
  /** Demande d'approbation d'outil ; résout avec le verdict du front. */
  requestToolApproval: (req: ToolApprovalRequest) => Promise<ToolApprovalResult>;
  /** Notifie une écriture imminente ; résout quand le front a pris acte. */
  notifyWrite: (paths: string[]) => Promise<void>;
};

// ── Fabrication des exécuteurs enveloppés ────────────────────────────────────

/**
 * Construit les exécuteurs d'outils du SDK, avec interception des écritures.
 *
 * On part des exécuteurs natifs (`createDefaultExecutors`) et on n'enveloppe
 * QUE `editor` et `applyPatch` : ce sont les seuls outils qui modifient le
 * disque. `bash` peut aussi écrire indirectement, mais le contrôler fichier par
 * fichier serait illusoire (redirections, scripts) — c'est le rôle de
 * l'**approbation** (`requestToolApproval`) de couvrir ce cas.
 */
export function buildToolExecutors(
  transport: ApprovalTransport,
  cwd: string,
): Partial<ToolExecutors> {
  const base = createDefaultExecutors({ editor: { restrictToCwd: true }, applyPatch: { restrictToCwd: true } });

  const editor = wrapEditor(base.editor, transport, cwd);
  const applyPatch = wrapApplyPatch(base.applyPatch, transport, cwd);

  return {
    ...base,
    ...(editor ? { editor } : {}),
    ...(applyPatch ? { applyPatch } : {}),
  };
}

/**
 * Enveloppe l'exécuteur `editor` : prévient le front du chemin touché AVANT
 * l'écriture, puis délègue au natif. Le chemin rapporté est résolu en absolu
 * pour que le checkpoint Rust le localise sans ambiguïté.
 */
function wrapEditor(
  nativeEditor: ToolExecutors["editor"],
  transport: ApprovalTransport,
  cwd: string,
): EditorExecutor | undefined {
  if (!nativeEditor) return undefined;
  return async (input, execCwd, context) => {
    const path = resolvePath(String(input.path ?? ""), execCwd || cwd);
    if (path) await transport.notifyWrite([path]);
    return nativeEditor(input, execCwd, context);
  };
}

/**
 * Enveloppe l'exécuteur `apply_patch` : un patch peut toucher PLUSIEURS
 * fichiers. On calcule les changements sans rien écrire (`computePatchChanges`)
 * pour en extraire les chemins, on prévient le front, puis on délègue au natif.
 *
 * Si le calcul échoue (patch invalide), on ne bloque pas : le natif renverra
 * l'erreur d'exécution, qui est le bon canal pour la signaler au modèle.
 */
function wrapApplyPatch(
  nativeApplyPatch: ToolExecutors["applyPatch"],
  transport: ApprovalTransport,
  cwd: string,
): ApplyPatchExecutor | undefined {
  if (!nativeApplyPatch) return undefined;
  return async (input, execCwd, context) => {
    const root = execCwd || cwd;
    try {
      const { changes } = await computePatchChanges(input.input, root, { restrictToCwd: true });
      const paths = Object.keys(changes)
        .map((p) => resolvePath(p, root))
        .filter((p): p is string => Boolean(p));
      if (paths.length > 0) await transport.notifyWrite(paths);
    } catch {
      /* patch invalide : le natif émettra l'erreur d'exécution */
    }
    return nativeApplyPatch(input, execCwd, context);
  };
}

/** Résout un chemin (relatif → `cwd`) en absolu, sans toucher au disque. */
function resolvePath(path: string, cwd: string): string | null {
  const trimmed = path.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed)) return trimmed;
  return `${cwd.replace(/[\\/]+$/, "")}/${trimmed}`;
}
