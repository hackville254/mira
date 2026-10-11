/**
 * Minimal TextMate grammar → CodeMirror 6 StreamLanguage converter.
 *
 * LEVEL 1 CONSTRAINT
 * ------------------
 * We deliberately do NOT embed Oniguruma (`vscode-textmate` + WASM) — that
 * would add megabytes to the bundle. Instead we translate the subset of
 * TextMate patterns that maps cleanly onto the JavaScript RegExp engine:
 *   - `match` rules (single line)
 *   - `begin`/`end` rules (multi-line blocks)
 *   - nested `patterns`
 *   - `captures` → sub-scope tokens
 *
 * Grammars that rely on Oniguruma-only features (lookbehind, \G anchors,
 * recursive includes with exotic constructs) will degrade gracefully to the
 * nearest working subset instead of failing. This is acceptable for syntax
 * colouring, which is best-effort by nature.
 *
 * The output is a `StreamLanguage` instance consumed by `@codemirror/language`.
 */

import { StreamLanguage, type StreamParser } from '@codemirror/language';

/** A raw pattern as found in a TextMate grammar. */
interface TmPattern {
  match?: string;
  begin?: string;
  end?: string;
  name?: string;
  contentName?: string;
  captures?: Record<string, { name?: string }>;
  beginCaptures?: Record<string, { name?: string }>;
  endCaptures?: Record<string, { name?: string }>;
  patterns?: TmPattern[];
  include?: string;
}

interface TmGrammar {
  scopeName?: string;
  patterns?: TmPattern[];
  repository?: Record<string, TmPattern>;
}

/** Token tag names understood by CodeMirror's highlighting. */
type CmToken =
  | 'comment' | 'keyword' | 'string' | 'number' | 'bool' | 'null'
  | 'variableName' | 'typeName' | 'propertyName' | 'function' | 'operator'
  | 'punctuation' | 'className' | 'labelName' | 'atom' | 'regexp' | 'meta';

/**
 * Map a TextMate scope (e.g. `keyword.control.rust`) to a CodeMirror token
 * tag. We match on the leading segments, longest-prefix first.
 */
function scopeToToken(scope: string | undefined): CmToken | null {
  if (!scope) return null;
  const s = scope.toLowerCase();

  if (s.startsWith('comment')) return 'comment';
  if (s.startsWith('string.regexp')) return 'regexp';
  if (s.startsWith('string')) return 'string';
  if (s.startsWith('constant.numeric')) return 'number';
  if (s.startsWith('constant.language') && (s.includes('true') || s.includes('false'))) return 'bool';
  if (s.startsWith('constant.language')) return 'atom';
  if (s.startsWith('constant')) return 'atom';
  if (s.startsWith('keyword.operator')) return 'operator';
  if (s.startsWith('keyword')) return 'keyword';
  if (s.startsWith('storage.type')) return 'typeName';
  if (s.startsWith('storage')) return 'keyword';
  if (s.startsWith('entity.name.function')) return 'function';
  if (s.startsWith('entity.name.type') || s.startsWith('entity.name.class')) return 'className';
  if (s.startsWith('entity.name.tag')) return 'labelName';
  if (s.startsWith('entity.name')) return 'className';
  if (s.startsWith('entity')) return 'variableName';
  if (s.startsWith('variable.parameter')) return 'variableName';
  if (s.startsWith('variable')) return 'variableName';
  if (s.startsWith('support.function')) return 'function';
  if (s.startsWith('support.type') || s.startsWith('support.class')) return 'typeName';
  if (s.startsWith('support')) return 'variableName';
  if (s.startsWith('meta')) return 'meta';
  if (s.startsWith('punctuation')) return 'punctuation';
  if (s.startsWith('invalid')) return 'keyword';
  return null;
}

/** Resolve `#name` includes against the grammar `repository`. */
function resolveIncludes(patterns: TmPattern[], repo: Record<string, TmPattern>): TmPattern[] {
  const out: TmPattern[] = [];
  for (const p of patterns) {
    if (p.include && p.include.startsWith('#')) {
      const key = p.include.slice(1);
      const target = repo[key];
      if (target?.patterns) out.push(...target.patterns);
      else if (target) out.push(target);
    } else if (p.include) {
      // External includes (`source.js`, `$self`, ...) are ignored at Level 1.
      continue;
    } else {
      out.push(p);
    }
  }
  return out;
}

/** Compile a TextMate regex into a JS RegExp anchored at the current offset. */
function compileRegex(pattern: string): RegExp | null {
  try {
    // TextMate patterns are implicitly anchored at the test position. We use
    // the sticky flag so the match must start exactly where we are.
    return new RegExp(pattern, 'y');
  } catch {
    // Oniguruma-only constructs: try a best-effort sanitisation.
    try {
      const sanitized = pattern
        .replace(/\(\?<[=!]/g, '(?:') // lookbehind → non-capturing
        .replace(/\\A/g, '^')
        .replace(/\\z/g, '$')
        .replace(/\\G/g, '');
      return new RegExp(sanitized, 'y');
    } catch {
      return null;
    }
  }
}

interface CompiledPattern {
  match?: RegExp;
  begin?: RegExp;
  end?: RegExp;
  name?: string;
  contentName?: string;
  captures: { index: number; token: CmToken }[];
  beginCaptures: { index: number; token: CmToken }[];
  endCaptures: { index: number; token: CmToken }[];
  patterns: CompiledPattern[];
}

function compileCaptures(
  caps: Record<string, { name?: string }> | undefined
): { index: number; token: CmToken }[] {
  if (!caps) return [];
  return Object.entries(caps)
    .map(([k, v]) => ({ index: Number(k), token: scopeToToken(v.name) }))
    .filter((c): c is { index: number; token: CmToken } => c.token !== null && !Number.isNaN(c.index));
}

function compilePatterns(patterns: TmPattern[], repo: Record<string, TmPattern>): CompiledPattern[] {
  const resolved = resolveIncludes(patterns, repo);
  const out: CompiledPattern[] = [];
  for (const p of resolved) {
    const cp: CompiledPattern = {
      name: p.name,
      contentName: p.contentName,
      captures: compileCaptures(p.captures),
      beginCaptures: compileCaptures(p.beginCaptures),
      endCaptures: compileCaptures(p.endCaptures),
      patterns: p.patterns ? compilePatterns(p.patterns, repo) : [],
    };
    if (p.match) {
      const r = compileRegex(p.match);
      if (!r) continue;
      cp.match = r;
    } else if (p.begin && p.end) {
      const rb = compileRegex(p.begin);
      const re = compileRegex(p.end);
      if (!rb || !re) continue;
      cp.begin = rb;
      cp.end = re;
    } else {
      continue; // nothing usable
    }
    out.push(cp);
  }
  return out;
}

/** State carried across lines: the stack of open `begin`/`end` blocks. */
interface TmState {
  stack: CompiledPattern[];
}

/**
 * Try to match patterns at `pos` in `line`. Returns the consumed length and the
 * token to emit, or null if nothing matched. Handles one level of capture
 * granularity (outermost token wins for colouring).
 */
function matchAt(
  line: string,
  pos: number,
  patterns: CompiledPattern[]
): { length: number; token: CmToken | null; begin?: CompiledPattern } | null {
  for (const p of patterns) {
    if (p.match) {
      p.match.lastIndex = pos;
      const m = p.match.exec(line);
      if (m && m.index === pos && m[0].length > 0) {
        // Prefer a capture token if the whole rule has no name.
        let token = scopeToToken(p.name);
        if (!token && p.captures.length > 0) {
          // Emit the first capture's token for the captured span only.
          const cap = p.captures.find(c => m[c.index] !== undefined);
          if (cap) token = cap.token;
        }
        return { length: m[0].length, token };
      }
    } else if (p.begin) {
      p.begin.lastIndex = pos;
      const m = p.begin.exec(line);
      if (m && m.index === pos && m[0].length > 0) {
        return { length: m[0].length, token: scopeToToken(p.name), begin: p };
      }
    }
  }
  return null;
}

/** Build a StreamParser from a compiled grammar. */
function makeParser(patterns: CompiledPattern[]): StreamParser<TmState> {
  return {
    startState(): TmState {
      return { stack: [] };
    },
    token(stream, state): string | null {
      // Inside an open begin/end block: look for its end first.
      const top = state.stack[state.stack.length - 1];
      if (top?.end) {
        top.end.lastIndex = stream.pos;
        const m = top.end.exec(stream.string);
        if (m && m.index === stream.pos && m[0].length > 0) {
          stream.match(m[0]);
          state.stack.pop();
          let token = scopeToToken(top.endCaptures[0]?.token ?? top.name);
          if (!token && top.endCaptures.length > 0) token = top.endCaptures[0].token;
          return token ?? 'string';
        }
        // Inside the block: try nested patterns, else consume one char with the
        // block's content token.
        const nested = matchAt(stream.string, stream.pos, top.patterns);
        if (nested) {
          stream.match(stream.string.slice(stream.pos, stream.pos + nested.length));
          if (nested.begin) state.stack.push(nested.begin);
          return nested.token ?? scopeToToken(top.contentName) ?? 'string';
        }
        // No nested match: consume up to the next potential end match.
        const contentToken = scopeToToken(top.contentName) ?? scopeToToken(top.name) ?? 'string';
        top.end.lastIndex = stream.pos;
        const next = top.end.exec(stream.string);
        if (next && next.index > stream.pos) {
          stream.match(stream.string.slice(stream.pos, next.index));
          return contentToken;
        }
        stream.next();
        return contentToken;
      }

      // Top level: skip whitespace, then try the grammar patterns.
      if (stream.eatSpace()) return null;
      const m = matchAt(stream.string, stream.pos, patterns);
      if (m) {
        stream.match(stream.string.slice(stream.pos, stream.pos + m.length));
        if (m.begin) state.stack.push(m.begin);
        return m.token;
      }
      stream.next();
      return null;
    },
    blankLine(state): void {
      // A block that spans blank lines stays open (matches TextMate behaviour).
      void state;
    },
  };
}

/**
 * Parse a `.tmLanguage.json` string and convert it into a CodeMirror
 * `StreamLanguage`. Returns null if the grammar is unparseable.
 */
export function tmLanguageToStreamLanguage(json: string) {
  let grammar: TmGrammar;
  try {
    grammar = JSON.parse(json);
  } catch {
    return null;
  }
  const repo = grammar.repository ?? {};
  const patterns = compilePatterns(grammar.patterns ?? [], repo);
  if (patterns.length === 0) return null;
  return StreamLanguage.define(makeParser(patterns));
}
