/**
 * Logique *pure* du caractère `#` du ChatBox : les « context mentions » de Trae.
 *
 * ── Pourquoi ce module existe ────────────────────────────────────────────────
 * Trae (et le ChatBox de Mira) distingue deux symboles de saisie :
 *   - `/` : les **slash-commands** (modes, skills, workflows) — cf.
 *     `inputCommands.ts` ;
 *   - `#` : le **contexte** ajouté au message (« #File », « #Folder »,
 *     « #Workspace », « #Problems », « #Rule »…).
 * Ce module porte UNIQUEMENT la logique du `#` : détection de la requête en
 * cours de frappe, catalogue des types de contexte, filtrage, et sérialisation
 * vers le transport (`onSend`). Aucune dépendance React ni DOM : testable en
 * environnement `node`.
 *
 * ── Périmètre (validé produit) ───────────────────────────────────────────────
 * Types réellement **fonctionnels** dans Mira (pas de coquille vide) :
 *   - `#File`      → un fichier du workspace ;
 *   - `#Folder`    → un dossier du workspace (expansion en fichiers côté envoi) ;
 *   - `#Workspace` → le projet entier (arborescence + fichiers clés) ;
 *   - `#Problems`  → les diagnostics de l'onglet Problems ;
 *   - `#Rule`      → les règles projet (`.mira/rules`) ;
 *   - `#Code`      → la sélection courante de l'éditeur.
 * Types de Trae **non exposés** ici (nécessitent un serveur d'index/vectorisation
 * ou une extension réseau, hors périmètre) : `#Doc`, `#Web`, `#Past Chats`.
 */

// ── Types de contexte ─────────────────────────────────────────────────────────

/**
 * Les types de contexte proposés par le menu `#`.
 *
 * Volontairement restreints à ce que Mira sait *réellement* résoudre : un type
 * affiché mais inopérant serait un mensonge d'UI (cf. politique produit).
 */
export type ContextKind = "code" | "file" | "folder" | "workspace" | "problems" | "rule";

export interface ContextKindDescriptor {
  kind: ContextKind;
  /** Libellé affiché dans le menu, sans le `#`. */
  label: string;
  /** Description courte affichée sous le libellé. */
  description: string;
  /**
   * Vrai si la sélection exige un second écran (choix d'un fichier/dossier…).
   * Faux pour les types « atomiques » (Workspace, Problems) qui s'attachent
   * immédiatement.
   */
  needsPicker: boolean;
}

/**
 * Catalogue ordonné des types de contexte. L'ordre suit celui de Trae
 * (Code, File, Folder, Workspace, Problems, Rule) pour la familiarité.
 */
export const CONTEXT_KINDS: readonly ContextKindDescriptor[] = [
  { kind: "code",      label: "Code",       description: "Current editor selection",        needsPicker: false },
  { kind: "file",      label: "File",       description: "A file in the workspace",         needsPicker: true  },
  { kind: "folder",    label: "Folder",     description: "All files in a folder",           needsPicker: true  },
  { kind: "workspace", label: "Workspace",  description: "The whole project",               needsPicker: false },
  { kind: "problems",  label: "Problems",   description: "Errors & warnings of the project", needsPicker: false },
  { kind: "rule",      label: "Rule",       description: "Project rules (.mira/rules)",     needsPicker: true  },
] as const;

/** Résout un descripteur par son `kind` (ou `undefined` si inconnu). */
export function contextKindDescriptor(kind: ContextKind): ContextKindDescriptor | undefined {
  return CONTEXT_KINDS.find(k => k.kind === kind);
}

// ── Référence de contexte ─────────────────────────────────────────────────────

/**
 * Une référence de contexte attachée à un message.
 *
 * `path` n'est renseigné que pour les types « ciblés » (`file`, `folder`,
 * `rule`). Les types globaux (`workspace`, `problems`) et `code` n'en ont pas.
 * `label` est le texte affiché dans la chip (nom de fichier, nom de dossier…).
 */
export interface ContextRef {
  kind: ContextKind;
  /** Chemin absolu (fichier/dossier) ou identifiant logique du type ciblé. */
  path?: string;
  /** Libellé affiché sur la chip. */
  label: string;
}

/** Clé d'unicité d'une référence : (kind, path). Deux `#Workspace` sont identiques. */
export function contextRefKey(ref: ContextRef): string {
  return `${ref.kind}:${ref.path ?? ""}`;
}

/** Vrai si `ref` est déjà présente dans `list` (dédoublonnage à l'attache). */
export function hasContextRef(list: readonly ContextRef[], ref: ContextRef): boolean {
  const key = contextRefKey(ref);
  return list.some(r => contextRefKey(r) === key);
}

/** Ajoute `ref` si absente ; renvoie une NOUVELLE liste (jamais de mutation). */
export function addContextRef(list: readonly ContextRef[], ref: ContextRef): ContextRef[] {
  return hasContextRef(list, ref) ? [...list] : [...list, ref];
}

/** Retire la référence d'index `index` ; renvoie une NOUVELLE liste. */
export function removeContextRef(list: readonly ContextRef[], index: number): ContextRef[] {
  if (index < 0 || index >= list.length) return [...list];
  return list.filter((_, i) => i !== index);
}

// ── Détection de la requête `#` ───────────────────────────────────────────────

/**
 * Détecte une requête `#` en cours de frappe.
 *
 * Contrairement à `@` (qui cible toujours un fichier), `#` a deux étapes :
 *   1. taper `#` seul → menu des TYPES (`query === ""`) ;
 *   2. taper `#fol` → filtrage des types (`query === "fol"`).
 *
 * On renvoie donc la requête textuelle après `#`, ou `null` si aucune n'est
 * active. Le `#` doit être en début de texte ou précédé d'un espace, pour ne pas
 * capturer un `#` de couleur hexadécimale ou de titre Markdown collé à du texte.
 */
export function getHashQuery(text: string): string | null {
  const match = text.match(/(?:^|\s)#([^\s#]*)$/);
  return match ? match[1] : null;
}

/** Filtre les types de contexte pour l'autocomplétion (query après le `#`). */
export function filterContextKinds(query: string): ContextKindDescriptor[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...CONTEXT_KINDS];
  return CONTEXT_KINDS.filter(
    k => k.kind.includes(q) || k.label.toLowerCase().includes(q),
  );
}

// ── Sérialisation vers le transport ──────────────────────────────────────────

/**
 * Sérialise les références de contexte pour `onSend`.
 *
 * On émet un tableau plat `kind:path` (ou `kind` seul pour les types globaux),
 * afin que le parent (`AiPanel`) puisse résoudre chaque entrée sans dépendre de
 * la forme DOM. Séparateur `:` : les chemins absolus ne contiennent jamais `:`
 * en tête de segment sur Unix, et `C:\…` reste analysable en coupant au PREMIER
 * `:` puisqu'on relit le `kind` qui le précède.
 */
export function serializeContextRefs(refs: readonly ContextRef[]): string[] {
  return refs.map(r => (r.path ? `${r.kind}:${r.path}` : r.kind));
}

/**
 * Analyse une entrée sérialisée `kind:path` (ou `kind` seul).
 * Renvoie `null` si le type est inconnu — on ne devine jamais un type.
 */
export function parseContextRef(entry: string): ContextRef | null {
  const sep = entry.indexOf(":");
  const kindRaw = (sep === -1 ? entry : entry.slice(0, sep)) as ContextKind;
  if (!CONTEXT_KINDS.some(k => k.kind === kindRaw)) return null;
  const path = sep === -1 ? undefined : entry.slice(sep + 1);
  const label = path ? (path.split(/[\\/]/).pop() ?? path) : (contextKindDescriptor(kindRaw)?.label ?? kindRaw);
  return { kind: kindRaw, path, label };
}

/** Icône (nom de composant lucide) associée à un type, résolue côté UI. */
export type ContextIconName = "code" | "file" | "folder" | "workspace" | "problems" | "rule";

export function contextIconName(kind: ContextKind): ContextIconName {
  return kind;
}
