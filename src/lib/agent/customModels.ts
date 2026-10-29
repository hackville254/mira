/**
 * Mira — Magasin des modèles PERSONNALISÉS (« Custom Model »).
 *
 * RÔLE
 * ----
 * L'application ne propose PLUS de catalogue de providers codé en dur : le
 * client déclare lui-même ses modèles (endpoint, clé, id de modèle, format
 * d'API). Ce module est l'UNIQUE source de vérité de cette liste, partagée par
 * le chat (sélecteur), les panneaux utilitaires (optimisation de prompt,
 * message de commit, édition inline), la gestion des clés (Settings → Models)
 * et la chaîne d'agent.
 *
 * POURQUOI UN STORE DÉDIÉ
 * -----------------------
 *   1. **Un seul format** stocké (`StoredCustomModel`) et plusieurs vues
 *      dérivées, calculées ici : l'UI ne réimplémente pas les règles.
 *   2. **Un point de validation unique** (`isValidUrl` + normalisation) : le
 *      backend Rust revalide de son côté (défense en profondeur), mais une
 *      saisie invalide ne doit jamais quitter l'app.
 *   3. **Sécurité des chaînes vides** : `baseUrl` vide est INTERDIT en amont
 *      (le SDK Cline appliquerait son défaut, donc l'appel partirait vers un
 *      endpoint qui n'est pas celui du client).
 *
 * SÉCURITÉ
 * --------
 *   - **La clé API NE VIT PAS ICI.** Elle reste dans le keychain OS via
 *     `secrets.ts` sous le compte `provider:<modelKey>`. Le store ne stocke
 *     que des métadonnées non sensibles (URL, id, libellés).
 *   - **L'id d'un modèle custom est préfixé** (`custom-<uuid>`) : impossible
 *     de collisionner avec un provider natif, et immédiatement reconnaissable
 *     par les appelants (`isCustomModelKey`).
 *   - **`localStorage` est traité comme non fiable** : toute entrée est
 *     revalidée au chargement ; une entrée corrompue est IGNORÉE (pas de
 *     propagation d'un état invalide dans l'UI ou la chaîne d'agent).
 */

// ── Format d'API ─────────────────────────────────────────────────────────────

/**
 * Format d'API parlé par l'endpoint du client. C'est CE champ qui décide du
 * protocole de transport utilisé — jamais le nom du provider.
 */
export type ApiFormat = "openai-chat" | "openai-responses" | "anthropic";

export const API_FORMAT_LABELS: Record<ApiFormat, string> = {
  "openai-chat": "OpenAI Chat Completions",
  "openai-responses": "OpenAI Responses API",
  "anthropic": "Anthropic Messages",
};

/**
 * Traduit notre format d'API en `clientType` du SDK d'agent.
 *
 * POURQUOI CE MAPPING
 * -------------------
 * Le moteur route le transport par `clientType` : `openai-compatible` parle le
 * protocole Chat Completions, `openai` (module natif) sait aussi servir le
 * protocole Responses, et `anthropic` parle Messages. On ne transmet donc
 * JAMAIS le libellé de l'UI au moteur : on le traduit ici, en un seul endroit.
 */
export function toClientType(format: ApiFormat): string {
  switch (format) {
    case "openai-chat":      return "openai-compatible";
    case "openai-responses": return "openai";
    case "anthropic":        return "anthropic";
  }
}

// ── Modèle stocké ────────────────────────────────────────────────────────────

/** Modèle personnalisé tel que persisté dans `localStorage`. */
export interface StoredCustomModel {
  /** Clé stable, préfixée `custom-` (sert aussi de compte keychain). */
  key: string;
  /** Libellé affiché dans le sélecteur et les listes. */
  displayName: string;
  /** Format d'API de l'endpoint. */
  apiFormat: ApiFormat;
  /** Endpoint complet (ou base à laquelle le suffixe est ajouté, cf. `fullUrl`). */
  baseUrl: string;
  /** `true` = `baseUrl` est l'URL FINALE (aucun suffixe ajouté). */
  fullUrl: boolean;
  /** Id du modèle tel que l'endpoint l'attend. */
  modelId: string;
  /** Famille de modèles (indice d'optimisation ; vide = défaut). */
  modelSeries: string;
  /** Fenêtre de contexte déclarée (tokens) ; `null` = défaut optimal. */
  contextInput: number | null;
  contextOutput: number | null;
  /** Plafond de tours d'outils ; `null` = défaut du moteur. */
  toolCallRounds: number | null;
}

/** Limite du libellé d'affichage (compteur 0/64 de la modale). */
export const DISPLAY_NAME_MAX = 64;

/** Préfixe des clés de modèles personnalisés. */
export const CUSTOM_KEY_PREFIX = "custom-";

const STORAGE_KEY = "mira-custom-models";

/** Valeurs par défaut d'un nouveau modèle (modale vierge). */
export const DEFAULT_TOOL_CALL_ROUNDS = 500;

// ── Validation d'URL (front) ─────────────────────────────────────────────────

/**
 * Valide l'URL d'endpoint saisie par le client.
 *
 * Contrat volontairement STRICT côté forme, large côté destination : le client
 * a le droit de pointer un endpoint auto-hébergé (LAN, tunnel…), donc on
 * n'impose PAS d'allowlist de domaine. On refuse en revanche ce qui est
 * manifestement invalide ou dangereux à transporter :
 *   - schéma autre que http/https (`file:`, `javascript:`… refusés) ;
 *   - host vide ;
 *   - espaces (une URL collée avec un retour ligne casserait l'appel) ;
 *   - longueur déraisonnable (borne anti-abus de stockage/transport).
 *
 * Le backend Rust revalide de toute façon (défense en profondeur) : cette
 * fonction sert à donner un retour IMMÉDIAT dans la modale.
 */
export function validateEndpointUrl(raw: string): { ok: true } | { ok: false; reason: string } {
  const url = raw.trim();
  if (!url) return { ok: false, reason: "URL is required." };
  if (url.length > 2048) return { ok: false, reason: "URL is too long." };
  if (/\s/.test(url)) return { ok: false, reason: "URL must not contain spaces." };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "Enter a valid absolute URL (e.g. https://api.example.com/v1)." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "Only http:// and https:// endpoints are supported." };
  }
  if (!parsed.hostname) return { ok: false, reason: "URL must include a host." };
  return { ok: true };
}

/**
 * Résout l'URL réellement appelée à partir des champs de la modale.
 *
 * Quand « Full URL » est actif, le client a saisi la route complète : on la
 * prend telle quelle. Sinon, on ajoute le suffixe propre au format d'API —
 * exactement comme le décrit l'UI (« /chat/completions will be appended »).
 * Si le client a déjà terminé par ce suffixe, on ne le double pas.
 */
export function resolveRequestUrl(base: string, format: ApiFormat, fullUrl: boolean): string {
  const root = base.trim().replace(/\/+$/, "");
  if (fullUrl) return root;
  const suffix =
    format === "anthropic" ? "/messages"
    : format === "openai-responses" ? "/responses"
    : "/chat/completions";
  return root.endsWith(suffix) ? root : root + suffix;
}

// ── Chargement / écriture ────────────────────────────────────────────────────

/** Coercition sûre : une valeur non finie ou ≤ 0 devient `null` (défaut). */
function asPositiveIntOrNull(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function asApiFormat(v: unknown): ApiFormat {
  return v === "openai-responses" || v === "anthropic" ? v : "openai-chat";
}

/**
 * Revalide une entrée brute venue du stockage.
 *
 * POURQUOI : `localStorage` est modifiable hors app (DevTools, migration,
 * corruption). Une entrée sans clé/sans URL exploitable est REJETÉE plutôt que
 * réparée à moitié : un modèle à demi valide produirait un appel cassé au
 * premier tour, bien plus difficile à diagnostiquer qu'une absence.
 */
function normalizeStored(raw: unknown): StoredCustomModel | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const key = typeof r.key === "string" ? r.key.trim() : "";
  const modelId = typeof r.modelId === "string" ? r.modelId.trim() : "";
  const baseUrl = typeof r.baseUrl === "string" ? r.baseUrl.trim() : "";
  if (!key.startsWith(CUSTOM_KEY_PREFIX) || !modelId || !baseUrl) return null;
  if (!validateEndpointUrl(baseUrl).ok) return null;
  const displayName = typeof r.displayName === "string" ? r.displayName.trim() : "";
  return {
    key,
    displayName: (displayName || modelId).slice(0, DISPLAY_NAME_MAX),
    apiFormat: asApiFormat(r.apiFormat),
    baseUrl,
    fullUrl: r.fullUrl === true,
    modelId,
    modelSeries: typeof r.modelSeries === "string" ? r.modelSeries : "",
    contextInput: asPositiveIntOrNull(r.contextInput),
    contextOutput: asPositiveIntOrNull(r.contextOutput),
    toolCallRounds: asPositiveIntOrNull(r.toolCallRounds),
  };
}

let cache: StoredCustomModel[] | null = null;

/** Liste des modèles personnalisés (revalidée, jamais d'entrée corrompue). */
export function loadCustomModels(): StoredCustomModel[] {
  if (cache) return cache;
  let parsed: unknown = null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    parsed = raw ? JSON.parse(raw) : [];
  } catch {
    parsed = [];
  }
  const list = Array.isArray(parsed)
    ? parsed.map(normalizeStored).filter((m): m is StoredCustomModel => m !== null)
    : [];
  cache = list;
  return list;
}

function persist(list: StoredCustomModel[]): void {
  cache = list;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // Quota plein / stockage indisponible : le cache mémoire reste valide pour
    // la session en cours, l'UI n'a pas à tomber pour autant.
  }
}

/** Ajoute (ou remplace, même clé) un modèle, et le renvoie. */
export function saveCustomModel(model: StoredCustomModel): StoredCustomModel {
  const normalized = normalizeStored(model);
  if (!normalized) throw new Error("Invalid custom model");
  const list = loadCustomModels();
  const idx = list.findIndex(m => m.key === normalized.key);
  const next = idx >= 0
    ? list.map((m, i) => (i === idx ? normalized : m))
    : [...list, normalized];
  persist(next);
  return normalized;
}

/** Supprime un modèle personnalisé (la clé keychain est retirée par l'appelant). */
export function removeCustomModel(key: string): void {
  persist(loadCustomModels().filter(m => m.key !== key));
}

/** Recherche un modèle personnalisé par sa clé. */
export function findCustomModel(key: string): StoredCustomModel | null {
  return loadCustomModels().find(m => m.key === key) ?? null;
}

/** Une clé désigne-t-elle un modèle personnalisé ? */
export function isCustomModelKey(key: string): boolean {
  return key.startsWith(CUSTOM_KEY_PREFIX);
}

/**
 * Clé d'un NOUVEAU modèle. On évite `crypto.randomUUID` seul (indisponible
 * dans certains contextes non sécurisés) : un repli horodaté suffit, la clé
 * n'a pas besoin d'être cryptographiquement imprévisible, seulement unique.
 */
export function newCustomModelKey(): string {
  const uid = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${CUSTOM_KEY_PREFIX}${uid}`;
}

/** Abonne l'appelant aux changements du store (même onglet uniquement). */
export function subscribeCustomModels(fn: () => void): () => void {
  const handler = () => fn();
  window.addEventListener("mira:custom-models-changed", handler);
  return () => window.removeEventListener("mira:custom-models-changed", handler);
}

/**
 * Notifie les abonnés APRÈS une écriture. Séparé de `persist` pour que les
 * appelants qui enchaînent plusieurs écritures (ex. suppression en lot)
 * puissent ne notifier qu'une fois.
 */
export function emitCustomModelsChanged(): void {
  window.dispatchEvent(new Event("mira:custom-models-changed"));
}
