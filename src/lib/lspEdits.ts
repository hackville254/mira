// ── Éditions LSP ──────────────────────────────────────────────────────────────
// Types + helpers partagés pour appliquer les `TextEdit` renvoyés par un serveur
// LSP (formatage, rename, code actions). Les positions LSP sont en 0-based
// (ligne ET colonne) et les colonnes comptent en unités UTF-16, comme le doc CM6.

/** Position LSP 0-based. */
export interface LspPosition { line: number; character: number }

export interface LspRange { start: LspPosition; end: LspPosition }

/** Remplacement de texte sur une plage (réponse standard LSP `TextEdit`). */
export interface LspTextEdit { range: LspRange; newText: string }

/** Édition possiblement multi-fichiers (`textDocument/rename`, code actions). */
export interface LspWorkspaceEdit {
  changes?: Record<string, LspTextEdit[]>;
  documentChanges?: Array<{ textDocument: { uri: string }; edits: LspTextEdit[] }>;
}

/** Édition par fichier (chemin absolu), prête à être appliquée. */
export interface FileEdits { path: string; edits: LspTextEdit[] }

/** Convertit une position LSP en offset de caractère dans `text`. */
export function lspPosToOffset(text: string, pos: LspPosition): number {
  const lines = text.split('\n');
  const li = Math.min(Math.max(pos.line, 0), lines.length - 1);
  let offset = 0;
  for (let i = 0; i < li; i++) offset += lines[i].length + 1;
  return offset + Math.min(Math.max(pos.character, 0), lines[li].length);
}

/** Convertit un offset de caractère en position LSP. */
export function offsetToLspPos(text: string, offset: number): LspPosition {
  const clamped = Math.min(Math.max(offset, 0), text.length);
  const before = text.slice(0, clamped);
  const nl = before.lastIndexOf('\n');
  return { line: before.split('\n').length - 1, character: clamped - nl - 1 };
}

/**
 * Applique une liste de `TextEdit` à `text`. Les éditions sont triées de la fin
 * vers le début pour que les offsets restent valides pendant l'application.
 */
export function applyLspEdits(text: string, edits: LspTextEdit[]): string {
  const resolved = edits
    .map(e => ({
      from: lspPosToOffset(text, e.range.start),
      to: lspPosToOffset(text, e.range.end),
      insert: e.newText,
    }))
    .sort((a, b) => b.from - a.from);
  let out = text;
  for (const c of resolved) out = out.slice(0, c.from) + c.insert + out.slice(c.to);
  return out;
}

/**
 * Aplatit un `WorkspaceEdit` en éditions par fichier. `toPath` convertit un URI
 * `file://` en chemin local.
 */
export function flattenWorkspaceEdit(
  edit: LspWorkspaceEdit,
  toPath: (uri: string) => string,
): FileEdits[] {
  const byPath = new Map<string, LspTextEdit[]>();
  const push = (uri: string, edits: LspTextEdit[]) => {
    if (!edits || edits.length === 0) return;
    const p = toPath(uri);
    byPath.set(p, [...(byPath.get(p) ?? []), ...edits]);
  };
  if (edit.changes) {
    for (const [uri, edits] of Object.entries(edit.changes)) push(uri, edits);
  }
  if (edit.documentChanges) {
    for (const dc of edit.documentChanges) {
      if (dc && 'textDocument' in dc) push(dc.textDocument.uri, dc.edits);
    }
  }
  return [...byPath.entries()].map(([path, edits]) => ({ path, edits }));
}