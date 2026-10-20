import type { OriginTheme, ThemeType } from "./types";

/**
 * Adapter: VS Code color theme JSON → Origin theme.
 *
 * VS Code themes come in two parts:
 *  - `colors`: flat map of UI keys (`editor.background`, `sideBar.background`, …)
 *  - `tokenColors`: TextMate rules (`{ scope, settings: { foreground } }`)
 *
 * We translate both into Origin's own token model (`bg.editor`, `syntax.keyword`,
 * …). Anything the source theme does not define falls back to the nearest
 * built-in Origin theme (dark or light) so the UI is never left unstyled.
 */

interface VscodeTokenRule {
  scope?: string | string[];
  settings?: { foreground?: string; fontStyle?: string };
}

interface VscodeThemeJson {
  name?: string;
  type?: string;
  colors?: Record<string, string>;
  tokenColors?: VscodeTokenRule[];
  include?: string;
}

// ── UI color mapping ─────────────────────────────────────────────────────────
// Each entry: Origin token → ordered list of VS Code keys to try (first wins).

const COLOR_MAP: Record<string, string[]> = {
  "bg.base":     ["editor.background", "editorGroupHeader.tabsBackground", "sideBar.background"],
  "bg.editor":   ["editor.background"],
  "bg.sidebar":  ["sideBar.background", "activityBar.background", "editor.background"],
  "bg.panel":    ["panel.background", "terminal.background", "editor.background"],
  "bg.titlebar": ["titleBar.activeBackground", "activityBar.background", "sideBar.background"],
  "bg.input":    ["input.background", "editorWidget.background", "editor.background"],
  "bg.hover":    ["list.hoverBackground", "toolbar.hoverBackground"],
  "bg.active":   ["list.activeSelectionBackground"],
  "bg.selection": ["editor.selectionBackground"],
  "bg.selection-focused": ["editor.selectionBackground", "list.activeSelectionBackground"],
  "bg.editor-line-highlight": ["editor.lineHighlightBackground"],

  "fg.default": ["editor.foreground", "foreground"],
  "fg.muted":   ["descriptionForeground", "editor.foreground"],
  "fg.subtle":  ["disabledForeground", "descriptionForeground"],

  "border.default": ["panel.border", "editorGroup.border", "sideBar.border", "contrastBorder"],
  "border.subtle":  ["editorWidget.border", "panel.border", "editorGroup.border"],

  "accent.blue":   ["focusBorder", "button.background", "editorInfo.foreground", "#007acc"],
  "accent.pink":   ["terminal.ansiMagenta", "editorError.foreground"],
  "accent.green":  ["terminal.ansiGreen", "editorGutter.addedBackground", "gitDecoration.addedResourceForeground"],
  "accent.yellow": ["terminal.ansiYellow", "editorWarning.foreground", "gitDecoration.modifiedResourceForeground"],
  "accent.purple": ["terminal.ansiBrightMagenta", "terminal.ansiMagenta"],
  "accent.cyan":   ["terminal.ansiCyan", "terminal.ansiBrightCyan"],
  "accent.red":    ["terminal.ansiRed", "editorError.foreground", "errorForeground"],

  "git.added":     ["gitDecoration.addedResourceForeground"],
  "git.modified":  ["gitDecoration.modifiedResourceForeground"],
  "git.deleted":   ["gitDecoration.deletedResourceForeground"],
  "git.conflict":  ["gitDecoration.conflictingResourceForeground"],
  "git.ignored":   ["gitDecoration.ignoredResourceForeground"],
  "git.untracked": ["gitDecoration.untrackedResourceForeground"],

  "semantic.error":   ["editorError.foreground", "errorForeground"],
  "semantic.warning": ["editorWarning.foreground"],
  "semantic.info":    ["editorInfo.foreground"],
  "semantic.success": ["terminal.ansiGreen"],

  "terminal.fg":        ["terminal.foreground", "editor.foreground"],
  "terminal.selection": ["terminal.selectionBackground", "editor.selectionBackground"],
  "terminal.black":         ["terminal.ansiBlack"],
  "terminal.red":           ["terminal.ansiRed"],
  "terminal.green":         ["terminal.ansiGreen"],
  "terminal.yellow":        ["terminal.ansiYellow"],
  "terminal.blue":          ["terminal.ansiBlue"],
  "terminal.purple":        ["terminal.ansiMagenta"],
  "terminal.cyan":          ["terminal.ansiCyan"],
  "terminal.white":         ["terminal.ansiWhite"],
  "terminal.brightBlack":   ["terminal.ansiBrightBlack"],
  "terminal.brightRed":     ["terminal.ansiBrightRed"],
  "terminal.brightGreen":   ["terminal.ansiBrightGreen"],
  "terminal.brightYellow":  ["terminal.ansiBrightYellow"],
  "terminal.brightBlue":    ["terminal.ansiBrightBlue"],
  "terminal.brightPurple":  ["terminal.ansiBrightMagenta"],
  "terminal.brightCyan":    ["terminal.ansiBrightCyan"],
  "terminal.brightWhite":   ["terminal.ansiBrightWhite"],
};

// ── Syntax token mapping ─────────────────────────────────────────────────────
// Origin syntax token → ordered TextMate scopes (most specific first).

const SYNTAX_SCOPES: Record<string, string[]> = {
  "syntax.comment":   ["comment", "punctuation.definition.comment"],
  "syntax.keyword":   ["keyword", "storage", "keyword.control", "keyword.operator.new"],
  "syntax.string":    ["string", "constant.other.symbol", "string.quoted"],
  "syntax.function":  ["entity.name.function", "support.function", "meta.function-call.entity.name"],
  "syntax.variable":  ["variable", "variable.other", "entity.name.variable", "source"],
  "syntax.constant":  ["constant", "constant.numeric", "constant.language", "support.constant"],
  "syntax.type":      ["entity.name.type", "support.type", "entity.name.class", "support.class", "storage.type"],
  "syntax.operator":  ["keyword.operator"],
  "syntax.attribute": ["entity.other.attribute-name", "meta.object-literal.key", "variable.other.property"],
};

/**
 * Flatten `tokenColors` into scope → foreground map. When a rule lists several
 * scopes they all get the same color. Rules are kept in order so that later
 * (more specific) declarations override earlier ones for an exact scope.
 */
function flattenTokenColors(rules: VscodeTokenRule[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const rule of rules) {
    const fg = rule.settings?.foreground;
    if (!fg) continue;
    const scopes = Array.isArray(rule.scope)
      ? rule.scope
      : rule.scope
        ? [rule.scope]
        : [];
    for (const s of scopes) map.set(s, fg);
  }
  return map;
}

/**
 * Resolve the color for an Origin syntax token by finding the most specific
 * matching VS Code scope. VS Code scope selectors are space-separated parents
 * (e.g. `keyword.control`); we match on the longest exact scope first, then
 * fall back to progressively shorter dotted prefixes.
 */
function resolveSyntaxColor(
  token: string,
  scopeColors: Map<string, string>,
): string | undefined {
  const candidates = SYNTAX_SCOPES[token] ?? [];
  let best: { color: string; specificity: number } | undefined;

  for (const candidate of candidates) {
    for (const [scope, color] of scopeColors) {
      // VS Code scopes can be space-separated paths; compare each segment path.
      const scopePath = scope.split(" ").pop() ?? scope;
      if (scopePath === candidate || scopePath.startsWith(candidate + ".")) {
        const specificity = candidate.split(".").length;
        if (!best || specificity > best.specificity) {
          best = { color, specificity };
        }
      }
    }
  }
  return best?.color;
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Normalize a VS Code theme `type` to Origin's dark/light. */
function normalizeType(type: string | undefined): ThemeType {
  const t = (type ?? "").toLowerCase();
  if (t === "light" || t === "hcLight".toLowerCase()) return "light";
  return "dark";
}

export interface DownconvertResult {
  theme: OriginTheme;
  /** True when at least one UI color or syntax color was actually mapped. */
  matched: boolean;
}

/**
 * Convert a raw VS Code theme JSON into an Origin theme.
 *
 * @param raw        Parsed VS Code theme JSON.
 * @param fallback   Built-in Origin theme used to fill unmapped tokens.
 * @param sourceName Display name to use (extension label). Defaults to theme name.
 */
export function vscodeThemeToOrigin(
  raw: VscodeThemeJson,
  fallback: OriginTheme,
  sourceName?: string,
): DownconvertResult {
  const vscColors = raw.colors ?? {};
  const scopeColors = flattenTokenColors(raw.tokenColors ?? []);
  const type = normalizeType(raw.type);

  const base = fallback;
  const colors: Record<string, string> = {};
  let matched = false;

  for (const [token, candidates] of Object.entries(COLOR_MAP)) {
    let value: string | undefined;
    for (const key of candidates) {
      // Ignore pseudo-entries starting with '#' (hard-coded fallbacks).
      if (key.startsWith("#")) { value = key; break; }
      if (vscColors[key]) { value = vscColors[key]; break; }
    }
    const fallbackValue = base.colors[token];
    if (value && fallbackValue && fallbackValue !== value) matched = true;
    colors[token] = value ?? fallbackValue ?? "#000000";
  }

  // Syntax tokens resolved from tokenColors, else fallback.
  for (const token of Object.keys(SYNTAX_SCOPES)) {
    const resolved = resolveSyntaxColor(token, scopeColors);
    const fallbackValue = base.colors[token];
    if (resolved && fallbackValue !== resolved) matched = true;
    colors[token] = resolved ?? fallbackValue ?? colors["fg.default"];
  }

  // Tokens with no mapping at all (island.*, tooltip.*, etc.) inherit fallback.
  for (const [token, value] of Object.entries(base.colors)) {
    if (!(token in colors)) colors[token] = value;
  }

  const theme: OriginTheme = {
    name: sourceName ?? raw.name ?? "VS Code Theme",
    type,
    colors,
  };
  return { theme, matched };
}

/** Validate + parse a raw string of a VS Code theme file. */
export function parseVscodeTheme(json: string): VscodeThemeJson {
  const parsed = JSON.parse(json) as VscodeThemeJson;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid theme file");
  }
  return parsed;
}
