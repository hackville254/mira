// ── Permissions & approbation (pattern Trae « Permission Approval » + Cline) ───
//
// Trae propose 3 modes : Manual (tout confirmer), Auto (un juge décide), Full
// Access (aucune confirmation). Cline formalise deux idées qu'on reprend :
//   - « Tiered permissions »     : lecture = auto, écriture = à confirmer ;
//   - « Conditional approval »   : on décide selon CE QUE fait l'action (chemin,
//     commande), pas seulement selon le nom de l'outil.
//
// Choix d'Origin : PAS de second modèle juge (pas de coût, pas de latence, pas de
// nouvelle surface d'injection de prompt). On décide par RÈGLES DÉTERMINISTES.
//
// Mode « full » : l'utilisateur a explicitement demandé « aucune confirmation »,
// comme Trae. On l'honore — sauf pour la garde anti-catastrophe ci-dessous, qui
// bloque en dur les commandes susceptibles de détruire la machine (le filet ne
// peut pas être désactivé, y compris par le modèle).

import type { PendingAction } from "./tools";

export type PermissionMode = "manual" | "auto" | "full";

export const PERMISSION_MODE_KEY = "origin-ai-permission-mode";
export const DEFAULT_PERMISSION_MODE: PermissionMode = "manual";

// ── « Always allow » — mémoire des commandes approuvées explicitement ─────────
//
// Bouton « Always allow » de la carte d'approbation : l'utilisateur autorise une
// COMMANDE EXACTE une fois pour toutes (pas un motif large, pas d'écriture).
// Portée volontairement étroite :
//   - **commande exacte** (égalité stricte, espaces normalisés) — jamais un
//     préfixe, qui ouvrirait l'exécution de variantes injectées (`rm -rf` via
//     `rm -rf ; ...` déjà couvert par la garde anti-catastrophe) ;
//   - **ne court-circuite JAMAIS la garde anti-catastrophe** (vérifiée en amont) ;
//   - **persistée** en localStorage : survit au redémarrage, comme Trae.
export const ALWAYS_ALLOW_COMMANDS_KEY = "origin-ai-always-allow-commands";
const MAX_ALWAYS_ALLOW = 200;

/** Normalise une commande pour comparaison (espaces multiples repliés). */
function normalizeCommand(cmd: string): string {
  return cmd.trim().replace(/\s+/g, " ");
}

/** Lit l'ensemble des commandes « toujours autorisées ». */
export function loadAlwaysAllowCommands(): Set<string> {
  try {
    const raw = localStorage.getItem(ALWAYS_ALLOW_COMMANDS_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === "string"));
  } catch {
    return new Set();
  }
}

/** Autorise définitivement une commande exacte (idempotent, borné). */
export function addAlwaysAllowCommand(cmd: string): void {
  const norm = normalizeCommand(cmd);
  if (!norm) return;
  try {
    const set = loadAlwaysAllowCommands();
    set.add(norm);
    // Borne : on évince les plus anciennes (insertion-ordre du Set).
    const list = [...set].slice(-MAX_ALWAYS_ALLOW);
    localStorage.setItem(ALWAYS_ALLOW_COMMANDS_KEY, JSON.stringify(list));
  } catch {
    /* localStorage indisponible → best-effort, non bloquant */
  }
}

/** Révoque une commande précédemment autorisée. */
export function removeAlwaysAllowCommand(cmd: string): void {
  try {
    const set = loadAlwaysAllowCommands();
    set.delete(normalizeCommand(cmd));
    localStorage.setItem(ALWAYS_ALLOW_COMMANDS_KEY, JSON.stringify([...set]));
  } catch {
    /* ignore */
  }
}

/** Décision d'approbation pour une action donnée. */
export type ApprovalDecision =
  | { decision: "approve" }              // exécuter sans demander
  | { decision: "ask" }                  // afficher la carte de confirmation
  | { decision: "block"; reason: string }; // refuser d'office

// ── Garde anti-catastrophe (NON désactivable, même en Full Access) ─────────────
//
// Volontairement étroite : uniquement des motifs dont l'exécution détruit
// irréversiblement le système ou le disque. Ce n'est PAS le filtre de sécurité
// général (qui vit dans security.ts) — c'est le dernier filet anti-désastre.

const CATASTROPHIC_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /:\(\)\s*\{.*\};\s*:/, reason: "fork bomb" },
  { re: /\brm\s+(-[a-z-]*\s+)*-[a-z]*[rf][a-z]*\s+(-[a-z-]+\s+)*\/\*?(\s|$)/i, reason: "rm -rf /" },
  { re: /\bmkfs(\.[a-z0-9]+)?\b/i, reason: "formatage de système de fichiers (mkfs)" },
  { re: /\bdd\b[^\n]*\bof=\/dev\//i, reason: "écriture brute sur un périphérique (dd of=/dev/…)" },
  { re: />\s*\/dev\/[sh]d[a-z]/i, reason: "écriture brute sur un disque" },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/i, reason: "arrêt / redémarrage de la machine" },
  { re: /\bchmod\s+(-R\s+)?777\s+\/(\s|$)/i, reason: "chmod 777 sur la racine" },
  { re: /\b:>\s*\/dev\/[sh]d[a-z]/i, reason: "écrasement de disque" },
];

/** Vrai si la commande est jugée catastrophique (refus inconditionnel). */
export function isCatastrophicCommand(command: string): string | null {
  const cmd = command.trim();
  for (const { re, reason } of CATASTROPHIC_PATTERNS) {
    if (re.test(cmd)) return reason;
  }
  return null;
}

// ── Contexte de décision ───────────────────────────────────────────────────────

export interface ApprovalContext {
  mode: PermissionMode;
  /** Racine du workspace courant (les écritures hors de cette racine sont sensibles). */
  workspace?: string | null;
}

/** L'action est-elle une écriture (par opposition à une simple lecture) ? */
function isWriteAction(action: PendingAction): boolean {
  return action.type === "write_file" || action.type === "edit";
}

/** Chemin ciblé par l'action, le cas échéant. */
function actionPath(action: PendingAction): string | null {
  if (action.type === "write_file" || action.type === "edit") return action.path;
  return null;
}

/** Normalise pour comparaison : séparateurs uniformes, minuscules, sans « / » final. */
function normalizePath(p: string): string {
  let s = p.replace(/\\/g, "/").toLowerCase();
  s = s.replace(/\/{2,}/g, "/");
  if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

/** L'écriture est-elle confinée dans le workspace ? (hors workspace = sensible) */
function isInsideWorkspace(path: string, workspace: string | null | undefined): boolean {
  if (!workspace) return false;
  const p = normalizePath(path);
  const w = normalizePath(workspace);
  return p === w || p.startsWith(w + "/");
}

// ── Décision principale ────────────────────────────────────────────────────────

/**
 * Décide du sort d'une action d'agent selon le mode courant.
 *
 * - `manual` : tout ce qui modifie le système (écriture, exécution, question) est
 *   confirmé ; les lectures passent (elles ne modifient rien).
 * - `auto`   : on auto-approuve les opérations SÛRES (lecture, écriture DANS le
 *   workspace, édition) ; on demande pour tout le reste (écriture hors workspace,
 *   commandes shell, question à l'utilisateur).
 * - `full`   : aucune confirmation — sauf garde anti-catastrophe.
 *
 * Dans TOUS les modes, une commande catastrophique est bloquée.
 */
export function decideApproval(action: PendingAction, ctx: ApprovalContext): ApprovalDecision {
  // La garde anti-catastrophe prime sur le mode : même en Full Access.
  if (action.type === "bash_run") {
    const catastrophic = isCatastrophicCommand(action.command);
    if (catastrophic) {
      return { decision: "block", reason: `Commande refusée (${catastrophic}) : risque de destruction du système.` };
    }
  }

  if (ctx.mode === "full") {
    // Trae : « all security checks are disabled, no approval is triggered ».
    // La garde ci-dessus reste le seul filet.
    return { decision: "approve" };
  }

  // « Always allow » : l'utilisateur a déjà autorisé CETTE commande exacte via la
  // carte d'approbation. On l'honore dans tous les modes non-`full`. Placé APRÈS
  // la garde anti-catastrophe (qui n'est donc jamais court-circuitée) et APRÈS
  // le court-circuit `full` (inutile de consulter l'allowlist).
  if (action.type === "bash_run" && loadAlwaysAllowCommands().has(normalizeCommand(action.command))) {
    return { decision: "approve" };
  }

  // Une question à l'utilisateur n'est jamais auto-approuvée : elle DOIT lui être
  // posée (l'approuver reviendrait à annuler la question).
  if (action.type === "ask_user") {
    return { decision: "ask" };
  }

  const write = isWriteAction(action);

  if (ctx.mode === "manual") {
    // Lecture = sûre ; écriture/exec = confirmation.
    return write || action.type === "bash_run" ? { decision: "ask" } : { decision: "approve" };
  }

  // mode === "auto"
  if (write) {
    const path = actionPath(action);
    // Écriture dans le workspace → auto-approuvée ; hors workspace → on demande.
    if (path && isInsideWorkspace(path, ctx.workspace)) return { decision: "approve" };
    return { decision: "ask" };
  }

  // bash_run → toujours demandé en auto (une commande peut tout faire).
  return { decision: "ask" };
}

/** Libellé + description d'un mode (pour l'UI sélecteur et les réglages). */
export const PERMISSION_MODE_INFO: Record<PermissionMode, { label: string; desc: string }> = {
  manual: { label: "Manual Approval", desc: "You confirm every write and command" },
  auto:   { label: "Auto Approval",   desc: "Auto for edits in the project, asks otherwise" },
  full:   { label: "Full Access",     desc: "Runs directly, without confirmation" },
};

/** Lit le mode depuis localStorage (avec repli sûr sur `manual`). */
export function loadPermissionMode(): PermissionMode {
  try {
    const raw = localStorage.getItem(PERMISSION_MODE_KEY);
    if (raw === "manual" || raw === "auto" || raw === "full") return raw;
  } catch {
    /* localStorage indisponible (SSR/tests) → défaut */
  }
  return DEFAULT_PERMISSION_MODE;
}

/** Persiste le mode. */
export function savePermissionMode(mode: PermissionMode): void {
  try {
    localStorage.setItem(PERMISSION_MODE_KEY, mode);
  } catch {
    /* ignore */
  }
}
