/**
 * Mira — Identité visuelle des modèles (et repli neutre).
 *
 * CE QUI A CHANGÉ : ce module NE CONTIENT PLUS de catalogue de providers. Il ne
 * reste ici que ce dont l'UI a besoin pour dessiner un modèle personnalisé sans
 * icône de marque, et les types partagés par les composants d'affichage.
 *
 * La liste réelle des modèles est fournie par `lib/agent/customModels.ts`
 * (déclarée par le client). Les identifiants `DEFAULT_*` sont réexportés depuis
 * le module neutre pour ne pas dupliquer le contrat.
 */
export { DEFAULT_MODEL_ID, DEFAULT_PROVIDER_ID } from "../../lib/ai/modelDefaults";
import { DEFAULT_MODEL_ID, DEFAULT_PROVIDER_ID } from "../../lib/ai/modelDefaults";

/** Catégorie d'API d'un modèle, telle qu'affichée dans le sélecteur. */
export interface AIModel {
  /** Clé du modèle personnalisé (`custom-…`). */
  id: string;
  /** Libellé affiché. */
  name: string;
  /** Format d'API, en clair (« OpenAI Chat Completions »…). */
  description: string;
  /** Teinte d'accent (graphiques d'usage). */
  color: string;
}

/** Groupe affiché dans le sélecteur : ici, les modèles du client. */
export interface AIProvider {
  id: string;
  name: string;
  /** Initiale(s) de repli quand aucune icône de marque n'est connue. */
  initial: string;
  /** Icône de marque (`null` = initiale colorée). */
  icon: string | null;
  invert: boolean;
  color: string;
  textColor: string;
  models: AIModel[];
}

/** Palette cyclique des accents (le choix est stable par clé de modèle). */
const ACCENT_PALETTE = [
  "#7c3aed", "#f97316", "#ef4444", "#10a37f", "#3b82f6",
  "#ec4899", "#eab308", "#06b6d4", "#84cc16", "#f43f5e",
];

/** Accent déterministe pour un modèle (même clé → même couleur, entre sessions). */
export function accentForModel(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (Math.imul(31, h) + key.charCodeAt(i)) | 0;
  return ACCENT_PALETTE[Math.abs(h) % ACCENT_PALETTE.length];
}

/** Le provider de repli, utilisé tant qu'aucun modèle n'est configuré. */
export const FALLBACK_PROVIDER: AIProvider = {
  id: DEFAULT_PROVIDER_ID,
  name: "No model",
  initial: "Ø",
  icon: null,
  invert: false,
  color: "#6b7280",
  textColor: "#ffffff",
  models: [{ id: DEFAULT_MODEL_ID, name: "No model configured", description: "", color: "#6b7280" }],
};
