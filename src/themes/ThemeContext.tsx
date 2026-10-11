/* eslint-disable react-refresh/only-export-components -- exports the useTheme hook alongside the provider component */
import { createContext, useContext, useState, useEffect, useCallback } from "react";
import type { OriginTheme } from "./types";
import { applyTheme } from "./applyTheme";
import { listExtensions, readExtensionAsset } from "../lib/extensions";
import { vscodeThemeToOrigin, parseVscodeTheme } from "./vscodeTheme";
import type { FileIconTheme, IconResolver } from "./iconTheme";
import {
  BUILTIN_ICON_THEME,
  createIconResolver,
  loadFileIconThemes,
  loadProductIconThemes,
  subscribeIconUpdates,
} from "./iconTheme";

const themeModules = import.meta.glob<{ default: OriginTheme }>(
  "./**/theme.json",
  { eager: true }
);

export const builtinThemes: OriginTheme[] = Object.values(themeModules).map(
  (m) => m.default
);

function resolveDefaultTheme(): OriginTheme {
  // 1. Respect saved preference
  const saved = localStorage.getItem("origin-theme");
  if (saved) {
    const match = builtinThemes.find((t) => t.name === saved);
    if (match) return match;
  }
  // 2. Fall back to OS preference
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const fallbackName = prefersDark ? "Origin Dark" : "Origin Light";
  return builtinThemes.find((t) => t.name === fallbackName) ?? builtinThemes[0];
}

/** Built-in theme used to fill tokens a VS Code theme does not define. */
function fallbackFor(type: "dark" | "light"): OriginTheme {
  const name = type === "light" ? "Origin Light" : "Origin Dark";
  return builtinThemes.find((t) => t.name === name) ?? builtinThemes[0];
}

/**
 * Load every VS Code theme contributed by installed extensions and convert it
 * to an Origin theme. Failures are isolated per-extension: a broken theme file
 * never blocks the others, and nothing is executed — assets are read as text.
 */
async function loadExtensionThemes(): Promise<OriginTheme[]> {
  const out: OriginTheme[] = [];
  let extensions;
  try {
    extensions = await listExtensions();
  } catch {
    return out;
  }
  for (const ext of extensions) {
    const themeContribs = ext.contributions.filter((c) => c.kind === "theme");
    for (const contrib of themeContribs) {
      try {
        const json = await readExtensionAsset(ext.id, contrib.path);
        const raw = parseVscodeTheme(json);
        const label = contrib.label ?? raw.name ?? ext.display_name;
        // Use the source theme type to pick the right built-in base.
        const base = fallbackFor(raw.type === "light" ? "light" : "dark");
        const { theme } = vscodeThemeToOrigin(raw, base, label);
        // Namespace the id so extension themes never collide with built-ins.
        theme.name = `${label} (${ext.name})`;
        out.push(theme);
      } catch (e) {
        console.warn(`Failed to load theme from ${ext.id}:${contrib.path}`, e);
      }
    }
  }
  return out;
}

interface ThemeContextValue {
  theme: OriginTheme;
  themes: OriginTheme[];
  setTheme: (theme: OriginTheme) => void;
  loadThemeFromJson: (json: string) => void;
  /** Re-scan installed extensions for contributed themes (after install/uninstall). */
  refreshThemes: () => Promise<void>;
  /** File-icon themes contributed by installed extensions (plus the default). */
  iconThemes: FileIconTheme[];
  /** Currently selected file-icon theme id ("" = default). */
  iconThemeId: string;
  setIconTheme: (id: string) => void;
  /** Resolver for the active file-icon theme, or null for the default glyphs. */
  iconResolver: IconResolver | null;
  /** Product-icon themes contributed by installed extensions (plus the default). */
  productIconThemes: FileIconTheme[];
  /** Currently selected product-icon theme id ("" = default). */
  productIconThemeId: string;
  setProductIconTheme: (id: string) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const ICON_THEME_KEY = "origin-icon-theme";
const PRODUCT_ICON_THEME_KEY = "origin-product-icon-theme";

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<OriginTheme>(() => {
    const t = resolveDefaultTheme();
    applyTheme(t); // apply synchronously so CSS vars are set before any child effect reads them
    return t;
  });
  const [themes, setThemes] = useState<OriginTheme[]>(builtinThemes);

  // File-icon theme selection + resolver.
  const [iconThemes, setIconThemes] = useState<FileIconTheme[]>([BUILTIN_ICON_THEME]);
  const [iconThemeId, setIconThemeId] = useState<string>(
    () => localStorage.getItem(ICON_THEME_KEY) ?? ""
  );
  // Bumped when a lazily-loaded icon SVG finishes, to re-render consumers.
  const [, forceIconRender] = useState(0);
  useEffect(() => subscribeIconUpdates(() => forceIconRender((n) => n + 1)), []);

  // Product-icon theme selection.
  const [productIconThemes, setProductIconThemes] = useState<FileIconTheme[]>([BUILTIN_ICON_THEME]);
  const [productIconThemeId, setProductIconThemeId] = useState<string>(
    () => localStorage.getItem(PRODUCT_ICON_THEME_KEY) ?? ""
  );

  // Discover VS Code themes from installed extensions on mount.
  useEffect(() => {
    let cancelled = false;
    void loadExtensionThemes().then((extThemes) => {
      if (cancelled || extThemes.length === 0) return;
      const merged = [...builtinThemes, ...extThemes];
      setThemes(merged);
      // If the saved theme came from an extension, re-resolve to its instance.
      const saved = localStorage.getItem("origin-theme");
      if (saved) {
        const match = merged.find((t) => t.name === saved);
        if (match && match !== theme) {
          setThemeState(match);
          applyTheme(match);
        }
      }
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount
  }, []);

  // Discover file-icon themes, and load the active one on mount.
  useEffect(() => {
    let cancelled = false;
    void loadFileIconThemes().then((list) => {
      if (cancelled) return;
      setIconThemes([BUILTIN_ICON_THEME, ...list]);
    });
    void loadProductIconThemes().then((list) => {
      if (cancelled) return;
      setProductIconThemes([BUILTIN_ICON_THEME, ...list]);
    });
    return () => { cancelled = true; };
  }, []);

  // Build the resolver whenever the selected icon theme changes. We keep the
  // loaded resolver alongside the id it belongs to, so the effective resolver is
  // derived (never a stale one from a previous selection).
  const [loadedResolver, setLoadedResolver] = useState<{ id: string; resolver: IconResolver | null } | null>(null);
  const activeIconTheme = iconThemes.find((t) => t.id === iconThemeId);
  useEffect(() => {
    if (!activeIconTheme || activeIconTheme.id === "") return;
    let cancelled = false;
    const id = activeIconTheme.id;
    void createIconResolver(activeIconTheme.extensionId, activeIconTheme.relPath).then((resolver) => {
      if (!cancelled) setLoadedResolver({ id, resolver });
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resolver follows the selected id only
  }, [iconThemeId, iconThemes]);
  const iconResolver =
    activeIconTheme && loadedResolver?.id === activeIconTheme.id ? loadedResolver.resolver : null;

  const setIconTheme = useCallback((id: string) => {
    setIconThemeId(id);
    localStorage.setItem(ICON_THEME_KEY, id);
  }, []);

  const setProductIconTheme = useCallback((id: string) => {
    setProductIconThemeId(id);
    localStorage.setItem(PRODUCT_ICON_THEME_KEY, id);
  }, []);

  // Re-scan extension themes on demand (e.g. right after an install/uninstall).
  const refreshThemes = useCallback(async () => {
    const extThemes = await loadExtensionThemes();
    const merged = [...builtinThemes, ...extThemes];
    setThemes(merged);
    // Re-resolve the active theme so a removal falls back to a valid instance.
    const saved = localStorage.getItem("origin-theme");
    const match = saved ? merged.find((t) => t.name === saved) : undefined;
    if (match) {
      setThemeState(match);
      applyTheme(match);
    } else if (!builtinThemes.some((t) => t.name === theme.name)) {
      const fallback = resolveDefaultTheme();
      setThemeState(fallback);
      applyTheme(fallback);
      localStorage.setItem("origin-theme", fallback.name);
    }
    // Refresh icon themes too, and drop a stale selection.
    const iconList = await loadFileIconThemes();
    setIconThemes([BUILTIN_ICON_THEME, ...iconList]);
    const savedIcon = localStorage.getItem(ICON_THEME_KEY) ?? "";
    if (savedIcon && !iconList.some((t) => t.id === savedIcon)) {
      setIconThemeId("");
      localStorage.setItem(ICON_THEME_KEY, "");
    }
    const productList = await loadProductIconThemes();
    setProductIconThemes([BUILTIN_ICON_THEME, ...productList]);
    const savedProduct = localStorage.getItem(PRODUCT_ICON_THEME_KEY) ?? "";
    if (savedProduct && !productList.some((t) => t.id === savedProduct)) {
      setProductIconThemeId("");
      localStorage.setItem(PRODUCT_ICON_THEME_KEY, "");
    }
  }, [theme.name]);

  function setTheme(t: OriginTheme) {
    setThemeState(t);
    applyTheme(t);
    localStorage.setItem("origin-theme", t.name);
  }

  function loadThemeFromJson(json: string) {
    try {
      const parsed = JSON.parse(json) as OriginTheme;
      if (!parsed.name || !parsed.colors) throw new Error("Invalid theme file");
      setTheme(parsed);
    } catch (e) {
      console.error("Failed to load theme:", e);
    }
  }

  return (
    <ThemeContext.Provider value={{
      theme, themes, setTheme, loadThemeFromJson, refreshThemes,
      iconThemes, iconThemeId, setIconTheme, iconResolver,
      productIconThemes, productIconThemeId, setProductIconTheme,
    }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside ThemeProvider");
  return ctx;
}
