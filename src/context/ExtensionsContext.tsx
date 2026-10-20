/* eslint-disable react-refresh/only-export-components -- exports the useExtensions hook alongside the provider component */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from "react";
import type { Extension } from "@codemirror/state";
import { type ExtensionInfo, listExtensions, readExtensionAsset } from "../lib/extensions";
import { tmLanguageToStreamLanguage } from "../lib/tmLanguage";
import { ExtensionHost, type ExtensionHostRecord, type HostDelegate } from "../lib/extensions/host";
import { clearCapabilities } from "../lib/extensions/permissions";
import { clearBinaryConsent } from "../lib/extensions/binaryConsent";
import { executeCommand as runRegisteredCommand } from "../lib/extensions/registry";
import { readDir, readFile, writeFile } from "../lib/fs";

/**
 * Level-1 extension runtime.
 *
 * Loads every installed extension, converts its *passive* contributions
 * (TextMate grammars) into CodeMirror languages, and indexes them by file
 * extension so the editor can pick one up. Snippets and themes are surfaced
 * separately for their respective consumers.
 *
 * No extension code (`main.js`) is ever executed here — this is the passive
 * tier only.
 */

/** VS Code language id → file extensions, for languages we know about. */
const LANGUAGE_EXTENSIONS: Record<string, string[]> = {
  rust: ["rs"],
  python: ["py", "pyw"],
  go: ["go"],
  java: ["java"],
  c: ["c", "h"],
  cpp: ["cpp", "cc", "cxx", "hpp", "hh", "hxx"],
  csharp: ["cs"],
  ruby: ["rb"],
  php: ["php"],
  swift: ["swift"],
  kotlin: ["kt", "kts"],
  scala: ["scala"],
  lua: ["lua"],
  perl: ["pl", "pm"],
  r: ["r"],
  dart: ["dart"],
  elixir: ["ex", "exs"],
  erlang: ["erl", "hrl"],
  haskell: ["hs"],
  clojure: ["clj", "cljs", "cljc"],
  toml: ["toml"],
  yaml: ["yaml", "yml"],
  shellscript: ["sh", "bash", "zsh"],
  dockerfile: ["dockerfile"],
  makefile: ["mk"],
  sql: ["sql"],
  ini: ["ini", "cfg"],
  xml: ["xml"],
  vue: ["vue"],
  svelte: ["svelte"],
  graphql: ["graphql", "gql"],
  protobuf: ["proto"],
};

export interface LoadedGrammar {
  /** The CM6 language extension. */
  extension: Extension;
  /** Language id declared by the extension (e.g. "rust"). */
  language: string;
  /** File extensions this grammar claims. */
  fileExtensions: string[];
  /** Exact file names this grammar claims (e.g. "Dockerfile"). */
  fileNames: string[];
  /** Owning extension id, for diagnostics. */
  extensionId: string;
}

interface ExtensionsContextType {
  extensions: ExtensionInfo[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  /** Resolve a CM6 language for a file path based on installed grammars. */
  getGrammarForPath: (path: string) => Extension | null;
  /** All loaded grammars (for diagnostics / UI). */
  grammars: LoadedGrammar[];
  // ── Level 2: sandboxed code execution ──────────────────────────────────────
  /** Activate an extension's code (its `activate()` runs in a sandbox). */
  activate: (ext: ExtensionInfo) => Promise<void>;
  /** Stop a running extension and remove its contributed commands. */
  deactivate: (extensionId: string) => Promise<void>;
  /** Live activation state of every code-shipping extension. */
  hostRecords: ExtensionHostRecord[];
}

const ExtensionsContext = createContext<ExtensionsContextType>({
  extensions: [],
  loading: false,
  error: null,
  reload: async () => {},
  getGrammarForPath: () => null,
  grammars: [],
  activate: async () => {},
  deactivate: async () => {},
  hostRecords: [],
});

// ── Host delegate wiring ────────────────────────────────────────────────────
//
// App.tsx owns the real workspace/editor/toast services, so it publishes a
// delegate here (and keeps its closures fresh with a ref). The host reads it
// lazily at call time via `hostDelegateRef.current`, so installing the real
// delegate later takes effect without recreating the host. That is why the
// delegate below is a stable forwarding object rather than a snapshot.

/** The delegate the host currently uses. Falls back to a throwing stub. */
export const hostDelegateRef: { current: HostDelegate } = {
  current: {
    getWorkspaceRoot: () => null,
    readFile: async () => { throw new Error("Extension host not ready yet."); },
    writeFile: async () => { throw new Error("Extension host not ready yet."); },
    listDirectory: async () => [],
    getActiveEditor: () => null,
    notify: () => {},
    executeCommand: (...args) => runRegisteredCommand(...args),
    getExtensionInfo: async () => undefined,
    getInstalledExtensions: async () => [],
  },
};

/** Install the real host delegate (called once by App.tsx). */
export function setHostDelegate(delegate: HostDelegate): void {
  hostDelegateRef.current = delegate;
}

/** Forwards to whatever delegate is current, so the host always sees the latest. */
const forwardingDelegate: HostDelegate = {
  getWorkspaceRoot: () => hostDelegateRef.current.getWorkspaceRoot(),
  readFile: (p) => hostDelegateRef.current.readFile(p),
  writeFile: (p, c) => hostDelegateRef.current.writeFile(p, c),
  listDirectory: (p) => hostDelegateRef.current.listDirectory(p),
  getActiveEditor: () => hostDelegateRef.current.getActiveEditor(),
  notify: (k, m) => hostDelegateRef.current.notify(k, m),
  executeCommand: (id, args) => hostDelegateRef.current.executeCommand(id, args),
  getExtensionInfo: (id) => hostDelegateRef.current.getExtensionInfo(id),
  getInstalledExtensions: () => hostDelegateRef.current.getInstalledExtensions(),
};

export function ExtensionsProvider({ children }: { children: React.ReactNode }) {
  const [extensions, setExtensions] = useState<ExtensionInfo[]>([]);
  const [grammars, setGrammars] = useState<LoadedGrammar[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Level 2: the extension host is a single instance for the app's life.
  const hostRef = useRef<ExtensionHost | null>(null);
  if (!hostRef.current) {
    hostRef.current = new ExtensionHost(forwardingDelegate);
  }

  const [hostRecords, setHostRecords] = useState<ExtensionHostRecord[]>([]);
  useEffect(() => {
    const host = hostRef.current!;
    const sync = () => setHostRecords(host.getRecords());
    sync();
    return host.subscribe(sync);
  }, []);

  const activate = useCallback(async (ext: ExtensionInfo) => {
    await hostRef.current!.activate(ext);
  }, []);
  const deactivate = useCallback(async (extensionId: string) => {
    await hostRef.current!.deactivate(extensionId);
  }, []);

  async function reload() {
    setLoading(true);
    setError(null);
    try {
      const list = await listExtensions();
      // Deactivate extensions whose code is no longer present (uninstalled).
      const present = new Set(list.map(e => e.id));
      for (const rec of hostRef.current!.getRecords()) {
        if (!present.has(rec.extensionId)) await hostRef.current!.deactivate(rec.extensionId);
      }
      setExtensions(list);

      // Convert every grammar contribution into a CM6 language.
      const loaded: LoadedGrammar[] = [];
      for (const ext of list) {
        for (const c of ext.contributions) {
          if (c.kind !== "grammar" || !c.language) continue;
          try {
            const json = await readExtensionAsset(ext.id, c.path);
            const lang = tmLanguageToStreamLanguage(json);
            if (!lang) continue;
            // Prefer the extensions declared by the manifest; fall back to the
            // built-in table for well-known language ids that omit them.
            const declared = (c.file_extensions ?? []).map(e => e.replace(/^\./, "").toLowerCase());
            const fallback = LANGUAGE_EXTENSIONS[c.language] ?? [];
            loaded.push({
              extension: lang,
              language: c.language,
              fileExtensions: declared.length > 0 ? declared : fallback,
              fileNames: (c.file_names ?? []).map(n => n.toLowerCase()),
              extensionId: ext.id,
            });
          } catch {
            // A malformed grammar must never break the app.
          }
        }
      }
      setGrammars(loaded);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load installed extensions from the backend on mount
    void reload();
  }, []);

  const grammarByExt = useMemo(() => {
    const map = new Map<string, Extension>();
    for (const g of grammars) {
      for (const fileExt of g.fileExtensions) {
        if (!map.has(fileExt)) map.set(fileExt, g.extension);
      }
    }
    return map;
  }, [grammars]);

  const grammarByName = useMemo(() => {
    const map = new Map<string, Extension>();
    for (const g of grammars) {
      for (const name of g.fileNames) {
        if (!map.has(name)) map.set(name, g.extension);
      }
    }
    return map;
  }, [grammars]);

  function getGrammarForPath(path: string): Extension | null {
    const base = path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
    // Some grammars target extension-less files by exact name (e.g. Dockerfile).
    const byName = grammarByName.get(base);
    if (byName) return byName;
    const ext = base.includes(".") ? (base.split(".").pop() ?? "") : "";
    if (!ext) return null;
    return grammarByExt.get(ext) ?? null;
  }

  return (
    <ExtensionsContext.Provider
      value={{
        extensions, loading, error, reload, getGrammarForPath, grammars,
        activate, deactivate, hostRecords,
      }}
    >
      {children}
    </ExtensionsContext.Provider>
  );
}

export function useExtensions() {
  return useContext(ExtensionsContext);
}

// ── Optional helpers ────────────────────────────────────────────────────────

/**
 * Default host file services backed by the app's own layer. The host applies
 * workspace-root confinement before these run, so they can be plain operations.
 * App.tsx spreads these and adds the editor/toast bridge.
 */
export function createDefaultHostServices(): Pick<
  HostDelegate, "readFile" | "writeFile" | "listDirectory" | "executeCommand"
> {
  return {
    readFile: (absolutePath) => readFile(absolutePath),
    writeFile: (absolutePath, content) => writeFile(absolutePath, content),
    listDirectory: async (absolutePath) => {
      const entries = await readDir(absolutePath);
      return entries.map(e => ({ name: e.name, isDirectory: e.is_dir }));
    },
    executeCommand: (id, args) => runRegisteredCommand(id, ...args),
  };
}

/** Clear stored consent for an extension (used when it is uninstalled). */
export function revokeConsent(extensionId: string): void {
  clearCapabilities(extensionId);
  clearBinaryConsent(extensionId);
}
