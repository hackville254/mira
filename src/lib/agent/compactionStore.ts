import type { ModelMessage } from "ai";

// ── Résumé de compaction persisté par SESSION ──────────────────────────────────
//
// POURQUOI CE MODULE
// ------------------
// La compaction manuelle produit un résumé de l'historique ancien. Pour qu'elle
// serve vraiment, ce résumé doit :
//   1. être RÉINJECTÉ à chaque tour suivant (sinon le prochain message repart de
//      l'historique complet et le gain disparaît) ;
//   2. SURVIVRE à un rechargement de session (le fil est rechargé depuis la DB).
//
// Or on ne réécrit PAS le fil affiché (choix produit : l'utilisateur garde tout
// son historique visible). On stocke donc le résumé à part, indexé par session,
// et on l'injecte en TÊTE de l'historique modèle au moment de construire les
// messages envoyés au modèle.
//
// PORTÉE : par `sessionId`. Une session supprimée peut laisser une entrée
// orpheline — sans conséquence (lecture par clé), mais `clearCompactionSummary`
// est appelé à la suppression pour ne pas accumuler.

const KEY = (sessionId: string) => `origin-compaction-summary:${sessionId}`;

/** Résumé persisté d'une session, s'il existe. */
export interface StoredCompaction {
  /** Compte rendu structuré de l'historique ancien. */
  summary: string;
  /** Nombre de messages modèles couverts (information/affichage). */
  coveredCount: number;
  /** Horodatage de la compaction (logs/affichage). */
  at: number;
}

/** Lit le résumé persisté d'une session (`null` si aucun). */
export function readCompactionSummary(sessionId: string | null | undefined): StoredCompaction | null {
  if (!sessionId) return null;
  try {
    const raw = localStorage.getItem(KEY(sessionId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredCompaction;
    return parsed && typeof parsed.summary === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/** Écrit (ou remplace) le résumé persisté d'une session. */
export function writeCompactionSummary(sessionId: string, value: StoredCompaction): void {
  try { localStorage.setItem(KEY(sessionId), JSON.stringify(value)); }
  catch { /* quota indisponible : on dégrade sans casser le flux */ }
}

/** Supprime le résumé persisté (compaction annulée, session supprimée). */
export function clearCompactionSummary(sessionId: string | null | undefined): void {
  if (!sessionId) return;
  try { localStorage.removeItem(KEY(sessionId)); }
  catch { /* ignore */ }
}

/**
 * Préfixe un historique modèle avec le résumé de compaction s'il existe.
 *
 * Le résumé est injecté comme un couple `user` + `assistant` (échange
 * authentique, sûr pour tous les providers, cf. `historySummary.ts`). On
 * n'injecte RIEN si aucun résumé n'est stocké : l'historique est renvoyé tel quel
 * (même référence, pour ne pas casser les comparaisons `===` du pipeline).
 */
export function withCompactionSummary(
  messages: ModelMessage[],
  stored: StoredCompaction | null,
): ModelMessage[] {
  if (!stored || !stored.summary.trim()) return messages;
  const bridgeUser: ModelMessage = {
    role: "user",
    content:
      "Earlier context was compacted to save space. Here is the structured " +
      "summary of the conversation so far. Continue from it without repeating " +
      "completed work:\n\n" + stored.summary,
  };
  const bridgeAssistant: ModelMessage = {
    role: "assistant",
    content: "Understood. I have the summary of the earlier work and will continue from there.",
  };
  return [bridgeUser, bridgeAssistant, ...messages];
}
