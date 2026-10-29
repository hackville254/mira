/**
 * Sélection de modèle « Auto » — bascule automatique dans l'ordre.
 *
 * ── Principe produit ──────────────────────────────────────────────────────────
 * Orvyx applique un rate-limit PAR MODÈLE : un modèle peut être saturé
 * (`429 Model busy`) alors qu'un autre est disponible. En mode Auto, on ne fige
 * donc PAS un modèle : on essaie les modèles Mira dans un ordre de préférence, et
 * dès que l'un est saturé on passe au suivant — sans intervention du client.
 *
 * ⚠️ FRONTIÈRE IMPORTANTE — ne jamais la confondre :
 *   - rate-limit / surcharge (par modèle)  → on BASCULE vers un autre modèle ;
 *   - budget USD épuisé (402 `insufficient_credits`, quota du compte) → on NE
 *     bascule PAS : c'est le PORTEFEUILLE du client qui est vide, changer de
 *     modèle ne le remplira pas. La carte « passer à une offre supérieure » doit
 *     rester affichée (voir `isQuotaError` dans `aiTypes`).
 *
 * ── Pourquoi un module dédié ─────────────────────────────────────────────────
 * `modelCascade`/`modelHealth` contiennent la logique PURE (ordre, cooldown,
 * décision de bascule). Ce module les COMPOSE et porte la définition de la clé
 * `auto`, partagée entre le sélecteur, le panneau et les tests — un seul endroit
 * décide « qu'est-ce que Auto », donc pas de divergence.
 */

import { loadMiraModels } from "./miraModels";
import { buildModelChain } from "./modelCascade";
import { rankModelChain } from "./modelHealth";

/**
 * Clé du modèle « Auto » dans le sélecteur.
 *
 * Ce n'est PAS un modèle : c'est un MODE. On l'adopte quand aucun choix n'a été
 * mémorisé (défaut) et on le retire dès que le client choisit un modèle précis
 * (son choix explicite prime, cf. règle produit « Auto par défaut, mémorisé »).
 */
export const AUTO_MODEL_KEY = "auto";

/** Vrai si la sélection désigne le mode Auto. */
export function isAutoModel(modelKey: string): boolean {
  return modelKey === AUTO_MODEL_KEY;
}

/** Un modèle candidat de la chaîne : clé d'UI + id réel transmis à l'API. */
export interface AutoModelCandidate {
  /** Clé d'UI (`mira-<id>`), pour la mémoire de santé et l'affichage. */
  key: string;
  /** Id réel envoyé au provider (ex. `deepseek-v4-flash-0731`). */
  modelId: string;
  /** Nom affiché (notice de bascule). */
  displayName: string;
}

/**
 * Construit la chaîne ordonnée des modèles candidats pour le mode Auto :
 * uniquement les modèles fournis par Mira, dans l'ordre de préférence, puis
 * réordonnés selon la santé observée (les modèles récemment saturés passent en
 * dernier — cf. `rankModelChain`).
 *
 * Renvoie `[]` si Mira n'a aucun catalogue (release déconnectée) : l'appelant
 * retombe alors sur le comportement « modèle inconnu ».
 */
export async function resolveAutoChain(): Promise<AutoModelCandidate[]> {
  const models = await loadMiraModels();
  if (models.length === 0) return [];

  const ordered = rankModelChain(models.map(m => m.key));
  return ordered
    .map(key => models.find(m => m.key === key))
    .filter((m): m is NonNullable<typeof m> => m != null)
    .map(m => ({ key: m.key, modelId: m.modelId, displayName: m.displayName }));
}

/**
 * Chaîne Auto à partir d'un catalogue DÉJÀ résolu (évite un second chargement).
 *
 * `primaryKey` (le premier modèle essayé) est placé en tête : on le tire de
 * l'état du run, pas d'une relecture du catalogue — le tour a déjà été lancé avec.
 */
export function buildAutoChainFrom(
  primaryKey: string,
  catalog: readonly AutoModelCandidate[],
): string[] {
  return buildModelChain(primaryKey, catalog.map(c => c.key));
}
