/**
 * Outline — arbre des symboles du fichier courant.
 *
 * Deux sources, fusionnées par priorité :
 *  1. **LSP** `textDocument/documentSymbol` (précis, live) si un serveur est actif ;
 *  2. **fallback regex** (TS/JS, Rust, Python) sinon — le fichier est déjà en
 *     mémoire côté éditeur, donc c'est instantané et hors ligne.
 *
 * Le type `OutlineSymbol` est volontairement indépendant du format LSP pour que
 * l'UI ne dépende jamais des numéros `SymbolKind` du protocole.
 */
import { getLspServerId, ensureLspServer, getLspLanguageId } from './lsp';
import { lspDocumentSymbols, lspWorkspaceSymbols, type RawDocumentSymbol } from './lspCm6';

/** Catégorie de symbole, normalisée pour l'affichage (icône + libellé). */
export type OutlineKind =
  | 'file' | 'module' | 'namespace' | 'package'
  | 'class' | 'method' | 'property' | 'field'
  | 'constructor' | 'enum' | 'enumMember' | 'interface'
  | 'function' | 'variable' | 'constant' | 'string' | 'number'
  | 'boolean' | 'array' | 'object' | 'key' | 'null'
  | 'struct' | 'event' | 'operator' | 'typeParameter';

/** Un nœud de l'Outline. */
export interface OutlineSymbol {
  name: string;
  detail?: string;
  kind: OutlineKind;
  /** Ligne (1-based) du nom — cible du saut. */
  line: number;
  /** Ligne (1-based) de fin du bloc — pour l'indentation/le repli. */
  endLine: number;
  children: OutlineSymbol[];
}

// ── LSP ────────────────────────────────────────────────────────────────────────

/** Table `SymbolKind` (LSP) → `OutlineKind`. Valeurs stables du protocole. */
const SYMBOL_KIND: OutlineKind[] = [
  /* 0 (unused) */ 'variable',
  'file', 'module', 'namespace', 'package', 'class', 'method', 'property',
  'field', 'constructor', 'enum', 'interface', 'function', 'variable',
  'constant', 'string', 'number', 'boolean', 'array', 'object', 'key',
  'null', 'enumMember', 'struct', 'event', 'operator', 'typeParameter',
];

function kindFromNumber(n: number): OutlineKind {
  return SYMBOL_KIND[n] ?? 'variable';
}

function fromRaw(sym: RawDocumentSymbol): OutlineSymbol {
  return {
    name: sym.name,
    detail: sym.detail,
    kind: kindFromNumber(sym.kind),
    line: sym.selectionRange.start.line + 1,
    endLine: sym.range.end.line + 1,
    children: (sym.children ?? []).map(fromRaw),
  };
}

/**
 * Récupère les symboles d'un fichier via LSP. Renvoie `null` si aucun serveur
 * n'est disponible ou si le serveur ne fournit pas de symboles (→ fallback).
 */
export async function outlineFromLsp(
  filePath: string,
  rootPath: string,
): Promise<OutlineSymbol[] | null> {
  const serverId = getLspServerId(filePath);
  if (!serverId) return null;
  try {
    await ensureLspServer(serverId, rootPath);
    const raw = await lspDocumentSymbols(serverId, filePath);
    if (raw.length === 0) return null; // serveur muet → on tentera le fallback
    return raw.map(fromRaw);
  } catch {
    return null;
  }
}

/** Indique si un langage LSP est disponible (pour choisir la stratégie). */
export function hasLspForFile(filePath: string): boolean {
  return getLspServerId(filePath) !== null;
}

// ── Go to Symbol in Workspace ───────────────────────────────────────────────────

/** Résultat de recherche de symbole dans tout le workspace (Ctrl+T). */
export interface WorkspaceSymbolHit {
  name: string;
  kind: OutlineKind;
  containerName?: string;
  /** Chemin absolu du fichier contenant le symbole. */
  path: string;
  /** Chemin relatif au dossier du workspace (pour l'affichage). */
  relPath: string;
  /** Ligne (1-based) du symbole — cible du saut. */
  line: number;
  /** Colonne (1-based) du symbole sur la ligne. */
  col: number;
}

/** Convertit un URI `file://` en chemin absolu (décodage des échappements). */
function uriToPath(uri: string): string {
  let p = uri.replace(/^file:\/\//, '');
  try { p = decodeURIComponent(p); } catch { /* URI déjà décodée */ }
  // Windows : `/C:/…` → `C:/…`.
  if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
  return p.replace(/\\/g, '/');
}

/**
 * Interroge `workspace/symbol` (Go to Symbol in Workspace, Ctrl+T).
 *
 * Le serveur LSP interrogé est celui qui gère `refPath` (un fichier ouvert) :
 * `workspace/symbol` est une requête projet, donc n'importe quel fichier du
 * langage suffit à cibler le bon serveur. Renvoie `[]` si aucun serveur ne gère
 * ce fichier.
 */
export async function workspaceSymbolsFromLsp(
  rootPath: string,
  refPath: string,
  query: string,
): Promise<WorkspaceSymbolHit[]> {
  const serverId = getLspServerId(refPath);
  if (!serverId) return [];
  try {
    await ensureLspServer(serverId, rootPath);
    const raw = await lspWorkspaceSymbols(serverId, query);
    const hits: WorkspaceSymbolHit[] = [];
    for (const sym of raw) {
      const loc = sym.location;
      // `location` peut être `Location` ou `WorkspaceSymbol.location` (avec uri).
      if (!loc || typeof loc.uri !== 'string') continue;
      const path = uriToPath(loc.uri);
      const relPath = path.startsWith(rootPath)
        ? path.slice(rootPath.length).replace(/^[/\\]/, '')
        : path;
      hits.push({
        name: sym.name,
        kind: kindFromNumber(sym.kind),
        containerName: sym.containerName,
        path,
        relPath,
        line: loc.range.start.line + 1,
        col: loc.range.start.character + 1,
      });
    }
    return hits.slice(0, 200);
  } catch {
    return [];
  }
}

/** Identifiant de langage (pour le fallback regex). */
export function languageIdOf(filePath: string): string {
  return getLspLanguageId(filePath);
}

// ── Fallback : parsing regex léger ─────────────────────────────────────────────

interface FallbackRule {
  re: RegExp;
  kind: OutlineKind;
}

// Règles par langage : la 1re capture est le nom du symbole.
const TS_RULES: FallbackRule[] = [
  { re: /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class' },
  { re: /^(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: 'interface' },
  { re: /^(?:export\s+)?(?:declare\s+)?(?:type)\s+([A-Za-z_$][\w$]*)\s*[<=]/, kind: 'typeParameter' },
  { re: /^(?:export\s+)?(?:declare\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: 'enum' },
  { re: /^(?:export\s+)?(?:declare\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, kind: 'function' },
  { re: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function|\()/, kind: 'function' },
  { re: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/, kind: 'variable' },
];

const RUST_RULES: FallbackRule[] = [
  { re: /^(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_][\w]*)/, kind: 'struct' },
  { re: /^(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_][\w]*)/, kind: 'enum' },
  { re: /^(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_][\w]*)/, kind: 'interface' },
  { re: /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)/, kind: 'function' },
  { re: /^(?:pub(?:\([^)]*\))?\s+)?(?:const|static)\s+([A-Za-z_][\w]*)/, kind: 'constant' },
  { re: /^(?:pub(?:\([^)]*\))?\s+)?type\s+([A-Za-z_][\w]*)/, kind: 'typeParameter' },
  { re: /^(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_][\w]*)/, kind: 'module' },
];

const PY_RULES: FallbackRule[] = [
  { re: /^class\s+([A-Za-z_][\w]*)/, kind: 'class' },
  { re: /^(?:async\s+)?def\s+([A-Za-z_][\w]*)/, kind: 'function' },
];

function rulesFor(languageId: string): FallbackRule[] | null {
  if (languageId === 'typescript' || languageId === 'typescriptreact'
    || languageId === 'javascript' || languageId === 'javascriptreact') return TS_RULES;
  if (languageId === 'rust') return RUST_RULES;
  if (languageId === 'python') return PY_RULES;
  return null;
}

/**
 * Parse un document texte en liste (plate) de symboles via regex. Aucun parseur
 * complet : on ne cherche qu'en début de ligne, hors commentaires. Suffisant
 * pour un outline indicatif quand LSP est indisponible.
 */
export function outlineFromText(text: string, languageId: string): OutlineSymbol[] {
  const rules = rulesFor(languageId);
  if (!rules) return [];
  const lines = text.split('\n');
  const out: OutlineSymbol[] = [];
  if (lines.length > 100_000) return out; // garde-fou

  for (let i = 0; i < lines.length; i++) {
    // Ignore l'indentation : on teste la ligne « trimmed ».
    const line = lines[i].replace(/^\s+/, '');
    if (!line || line.startsWith('//') || line.startsWith('#') || line.startsWith('*')) continue;
    for (const rule of rules) {
      const m = rule.re.exec(line);
      if (m) {
        out.push({
          name: m[1],
          kind: rule.kind,
          line: i + 1,
          endLine: i + 1,
          children: [],
        });
        break;
      }
    }
  }
  return out;
}
