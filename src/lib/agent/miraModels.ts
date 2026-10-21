import { loadDevAiConfig } from "../secrets";
import { loadCachedCatalog } from "./account";

/**
 * Modèles fournis par Mira (catalogue de l'éditeur).
 *
 * Concept produit : Mira est payant et embarque SES PROPRES modèles — ceux de
 * l'équipe, facturés par Mira — en plus de ceux que le client peut apporter
 * lui-même via la modale « Custom Model ». Les deux cohabitent dans le même
 * sélecteur, exactement comme chez Trae.
 *
 * Définition : un modèle Mira est un provider dont l'endpoint ET la clé sont
 * fournis par Mira (jamais saisis par le client). Aujourd'hui ce provider est
 * alimenté par le fichier `.env` de développement (`ORVYX_AI_*`) ; demain, en
 * production, il viendra d'une configuration signée/servie côté backend.
 *
 * Sécurité : la clé n'est JAMAIS écrite ici ni dans un bundle. Elle est lue au
 * runtime via `loadApiKey()` (keychain OS), qui se rabat sur l'env en debug.
 */
export const MIRA_PROVIDER_ID = "orvyx";

/** Clé de modèle Mira : sert d'identifiant de provider ET de modèle. */
export const MIRA_MODEL_PREFIX = "mira-";

/**
 * Endpoint d'inférence du provider Mira, utilisé par le catalogue de
 * production. C'est une constante produit (fixée par Mira), pas une saisie
 * utilisateur : un poste ne peut pas détourner les modèles Mira vers une autre
 * destination. En dev, le `.env` fournit son propre endpoint, prioritaire.
 */
const MIRA_BASE_URL = "https://api.orvyx-ai.com/v1";

/** Modèle Mira, tel que consommé par le sélecteur. */
export interface MiraModel {
  /** Clé stable, unique, préfixée `mira-`. */
  key: string;
  /** Identifiant réel envoyé à l'API (ex. `deepseek-v4-flash-0731`). */
  modelId: string;
  /** Nom affiché dans le sélecteur. */
  displayName: string;
  /** Base URL de l'endpoint Mira. */
  baseUrl: string;
  /** Provider tel que le moteur d'agent le connaît (clé de résolution). */
  providerId: string;
}

/**
 * Métadonnées de présentation des modèles Mira.
 *
 * Le `.env` ne transporte que des identifiants techniques ; les libellés
 * lisibles vivent ici, côté produit. Un id absent de cette table reste
 * utilisable : son libellé est alors dérivé de l'id.
 */
const MIRA_MODEL_LABELS: Record<string, string> = {
  "deepseek-v4.1-flash": "DeepSeek V4.1 Flash",
  "glm-5.3-flash": "GLM 5.3 Flash",
  "deepseek-v4-flash-0731": "DeepSeek V4 Flash",
  "deepseek-v4-flash": "DeepSeek V4 Flash (stable)",
};

/**
 * Ordre d'affichage. Les ids connus passent d'abord, suivis de tout id
 * supplémentaire trouvé dans le `.env` (pour qu'un ajout côté config soit
 * immédiatement visible sans toucher au code).
 */
const MIRA_MODEL_ORDER = [
  "deepseek-v4.1-flash",
  "glm-5.3-flash",
  "deepseek-v4-flash",
  "deepseek-v4-flash-0731",
];

/** Dérive un libellé lisible depuis un id technique. */
function labelFromId(id: string): string {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map(part => (part.length <= 3 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(" ");
}

/** Découpe une liste d'ids séparés par des virgules, dédupliquée et nettoyée. */
function parseIds(raw: string | null): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const id = part.trim();
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Catalogue Mira courant, ou `[]` si Mira n'a aucun endpoint configuré
 * (build release sans connexion, ou `.env` absent).
 *
 * Deux sources, dans cet ordre :
 *   1. le `.env` de dev (`ORVYX_AI_*`) — confort de développement, jamais
 *      présent en release ;
 *   2. le catalogue synchronisé depuis le plan de contrôle (`account.ts`),
 *      mis en cache local — c'est la source en production.
 * La première qui fournit un endpoint ET des ids gagne.
 */
export async function loadMiraModels(): Promise<MiraModel[]> {
  const dev = await loadDevAiConfig();
  const baseUrl = dev.baseUrl?.trim();
  const ids = parseIds(dev.allowedModels);
  if (baseUrl && ids.length > 0) {
    return buildModels(ids, dev.model?.trim() ?? null, baseUrl);
  }

  // Repli production : catalogue issu du plan de contrôle. L'endpoint d'un
  // modèle Mira est celui du provider Mira (fixé par le produit), pas une URL
  // fournie par l'utilisateur.
  const cached = loadCachedCatalog();
  if (cached && cached.length > 0) {
    const cloudIds = cached.map(m => m.id);
    return buildModels(cloudIds, cloudIds[0] ?? null, MIRA_BASE_URL, cached);
  }
  return [];
}

/**
 * Construit les modèles à partir d'une liste d'ids et d'une base URL.
 *
 * `labels` permet au catalogue cloud d'imposer ses libellés ; sinon on retombe
 * sur la table locale puis sur une dérivation depuis l'id.
 */
function buildModels(
  ids: string[],
  primary: string | null,
  baseUrl: string,
  labels?: { id: string; display_name: string }[],
): MiraModel[] {
  // Le modèle « principal » reste en tête de liste.
  const ordered = primary && ids.includes(primary)
    ? [primary, ...ids.filter(id => id !== primary)]
    : [...ids].sort((a, b) => {
        const ia = MIRA_MODEL_ORDER.indexOf(a);
        const ib = MIRA_MODEL_ORDER.indexOf(b);
        return (ia === -1 ? Number.MAX_SAFE_INTEGER : ia) - (ib === -1 ? Number.MAX_SAFE_INTEGER : ib);
      });

  const cloudLabel = new Map((labels ?? []).map(m => [m.id, m.display_name]));
  return ordered.map((id): MiraModel => ({
    key: `${MIRA_MODEL_PREFIX}${id}`,
    modelId: id,
    displayName: cloudLabel.get(id) ?? MIRA_MODEL_LABELS[id] ?? labelFromId(id),
    baseUrl,
    providerId: MIRA_PROVIDER_ID,
  }));
}

/** Vrai si la clé désigne un modèle fourni par Mira. */
export function isMiraModelKey(key: string): boolean {
  return key.startsWith(MIRA_MODEL_PREFIX);
}

/**
 * Résout un modèle Mira à partir de sa clé (`mira-<id>`).
 *
 * Retourne `null` si la clé n'est pas un modèle Mira ou si le catalogue ne
 * contient plus cet id (config modifiée entre-temps) : l'appelant retombe
 * alors sur le comportement « modèle inconnu ».
 */
export async function resolveMiraModel(key: string): Promise<MiraModel | null> {
  if (!isMiraModelKey(key)) return null;
  const models = await loadMiraModels();
  return models.find(m => m.key === key) ?? null;
}
