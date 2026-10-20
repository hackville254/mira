/**
 * Détection des chemins de fichiers/dossiers cités en TEXTE BRUT dans un message
 * de l'agent.
 *
 * Problème corrigé : quand l'agent écrit « j'ai cloné le dépôt dans
 * /Users/moi/projets/api » ou « le fichier src/lib/config.ts », ce chemin
 * n'était qu'une suite de caractères : ni lien markdown, ni tool-call, donc
 * non cliquable. L'utilisateur ne pouvait pas ouvrir ce que l'agent venait de
 * créer. On le rend cliquable SANS biais : on n'ouvre rien d'arbitraire, on se
 * contente de repérer un motif de chemin plausible et de le proposer.
 *
 * Ce module est PUR (aucun accès disque, aucun effet de bord) : il ne décide que
 * de la *forme* d'un chemin. L'existence réelle et la nature (fichier/dossier)
 * sont vérifiées au moment du clic par l'appelant, seul à pouvoir interroger le
 * FS. C'est ce qui le rend testable et sûr.
 */

/**
 * Motifs acceptés — volontairement STRICTS pour éviter les faux positifs qui
 * transformeraient des mots ordinaires en faux liens :
 *  - chemin absolu POSIX : commence par `/` et contient au moins un `/` de
 *    séparation de segment (ex. `/etc/hosts`, `/Users/moi/a/b`);
 *  - chemin absolu Windows : `C:\...` ou `C:/...`;
 *  - chemin relatif explicite : `./x`, `../x`;
 *  - chemin relatif de projet : au moins un `/` séparateur et une extension de
 *    fichier connue, ou un segment final plausible (ex. `src/lib/db.ts`).
 *
 * On EXCLUT :
 *  - les URL (`http://`, `https://`) : gérées par le routage de liens ;
 *  - les schémas (`mailto:`, `data:`…) ;
 *  - ce qui contient des espaces internes (un chemin cité est sans espace, ou
 *    l'agent l'entoure de backticks) ;
 *  - les suites de `/` seules ou les nombres (« 1/2 »).
 */
const ABSOLUTE_POSIX = /^\/(?:[^/\s]+\/)*[^/\s]+$/;
const ABSOLUTE_WIN = /^[a-zA-Z]:[\\/](?:[^\\/\s]+[\\/])*[^\\/\s]+$/;
const EXPLICIT_RELATIVE = /^\.{1,2}[\\/](?:[^\\/\s]+[\\/])*[^\\/\s]+$/;
// Relatif de projet : au moins un séparateur et une extension de fichier
// terminale (ex. `src/lib/db.ts`), ou un segment final terminé par `/`.
const PROJECT_RELATIVE_FILE = /^(?:[^/\s\\]+[\\/])+[^/\s\\]+\.[a-zA-Z0-9]+$/;
const PROJECT_RELATIVE_DIR = /^(?:[^/\s\\]+[\\/])+$/;

/** Une extension terminale plausible : 1 à 12 caractères alphanumériques. */
function hasFileExtension(path: string): boolean {
  const lastSegment = path.split(/[\\/]/).filter(Boolean).pop() ?? "";
  return /\.[a-zA-Z0-9]{1,12}$/.test(lastSegment);
}

/**
 * Vrai si le token a la FORME d'un chemin de fichier ou de dossier.
 * Ne vérifie PAS l'existence sur disque.
 */
export function looksLikePath(token: string): boolean {
  const raw = token.trim();
  if (!raw) return false;

  // Refus des URL et schémas : ils ne sont pas des chemins locaux.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) return false;
  if (/^(mailto|tel|data|javascript|vbscript):/i.test(raw)) return false;
  // Un chemin n'a pas d'espace interne (l'agent le met en backticks sinon).
  if (/\s/.test(raw)) return false;
  // Évite « 1/2 », « et/ou » : au moins une lettre requise.
  if (!/[a-zA-Z]/.test(raw)) return false;

  if (ABSOLUTE_POSIX.test(raw)) return true;
  if (ABSOLUTE_WIN.test(raw)) return true;
  if (EXPLICIT_RELATIVE.test(raw)) return true;
  if (PROJECT_RELATIVE_FILE.test(raw) && hasFileExtension(raw)) return true;
  if (PROJECT_RELATIVE_DIR.test(raw)) return true;

  return false;
}

/**
 * Indice de nature d'un chemin, déduit de sa SEULE forme :
 *  - `dir` : se termine par un séparateur (l'agent écrit `src/components/`) ;
 *  - `file` : possède une extension terminale plausible ;
 *  - `unknown` : indiscernable sans interroger le disque (l'appelant tranchera).
 */
export type PathKind = "file" | "dir" | "unknown";

export function guessPathKind(token: string): PathKind {
  const raw = token.trim().replace(/[\\/]+$/, (m) => m); // conserve le séparateur final
  if (/[\\/]$/.test(raw)) return "dir";
  if (hasFileExtension(raw)) return "file";
  return "unknown";
}

/**
 * Extrait les chemins bruts d'un texte libre. Les doublons sont supprimés tout
 * en préservant l'ordre d'apparition. Sert aux tests et à un éventuel usage
 * « hors markdown » ; le rendu dans les messages passe par le plugin remark,
 * qui travaille nœud de texte par nœud de texte.
 */
export function extractPathTokens(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // Découpe sur les délimiteurs usuels : espaces, ponctuation d'encadrement.
  const candidates = text.split(/[\s,;:!?"'()\[\]{}<>«»]+/);
  for (const c of candidates) {
    // Retire la ponctuation terminale de phrase (point final, virgule…).
    const cleaned = c.replace(/[.,;:!?)»"']+$/, "");
    if (!cleaned) continue;
    if (!looksLikePath(cleaned)) continue;
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}
