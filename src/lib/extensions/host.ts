/**
 * Extension host (Level 2) — lifecycle + permission gating.
 *
 * This is the trusted side of the sandbox boundary. It:
 *
 *   1. loads an extension's entrypoint source (read from disk via Tauri),
 *   2. spins up an isolated QuickJS runtime ({@link createExtensionRuntime}),
 *   3. implements {@link HostBridge} — the ONLY surface the extension can call,
 *   4. enforces the user's consent on every privileged call, and
 *   5. owns activation/deactivation and command-registry cleanup.
 *
 * Nothing here trusts the extension: paths are re-validated, capabilities are
 * checked at call time (not just at activation), and file access is confined to
 * the open workspace root by the host delegate.
 */

import { readExtensionAsset, type ExtensionInfo } from "../extensions";
import type { Capability } from "./permissions";
import {
  assertCapability,
  assertSafePath,
  consentStatus,
  requiredCapabilities,
} from "./permissions";
import { resolveEntry, type ResolvedEntry } from "./entry";
import { checkPrerequisites } from "./guard";
import { binaryConsentStatus } from "./binaryConsent";
import {
  registerCommand as registerInRegistry,
  unregisterAllForExtension,
  getCommand,
  getCommands,
} from "./registry";
import { createExtensionRuntime, type ExtensionRuntime } from "./runtime";
import type { HostBridge, HostTextDocument } from "./hostBridge";

// ── Host delegate — the trusted operations the host can actually perform ───────

/**
 * The host services an extension may reach, all provided by the app (App.tsx)
 * so this module stays framework-free and testable. The host is responsible for
 * actually confining file operations to the workspace root.
 */
export interface HostDelegate {
  /** Absolute workspace root, or null when no folder is open. */
  getWorkspaceRoot: () => string | null;
  /** Read a file the host has validated/confined. */
  readFile: (absolutePath: string) => Promise<string>;
  /** Write a file the host has validated/confined. */
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  /** List a directory the host has validated/confined. */
  listDirectory: (absolutePath: string) => Promise<{ name: string; isDirectory: boolean }[]>;
  /** The active editor document, or null. */
  getActiveEditor: () => (HostTextDocument & { path: string }) | null;
  /** Show a user-facing notification. */
  notify: (kind: "info" | "warning" | "error", message: string) => void;
  /** Run another (built-in or extension) command by id. */
  executeCommand: (id: string, args: unknown[]) => Promise<unknown>;
  /** Metadata for one installed extension (for `vscode.extensions.getExtension`). */
  getExtensionInfo: (id: string) => Promise<ExtensionDescriptor | undefined>;
  /** Metadata for every installed extension (for `vscode.extensions.all`). */
  getInstalledExtensions: () => Promise<ExtensionDescriptor[]>;
}

/** Read-only extension metadata exposed to `vscode.extensions.*`. */
export interface ExtensionDescriptor {
  id: string;
  extensionPath: string;
  isActive: boolean;
  packageJSON: Record<string, unknown>;
}

// ── Activation state ──────────────────────────────────────────────────────────

export type ActivationState =
  | "inactive"
  | "active"
  | "error"
  | "unsupported"
  | "prerequisites-missing"
  | "binary-consent-required";

export interface ExtensionHostRecord {
  extensionId: string;
  displayName: string;
  state: ActivationState;
  /** Last error message when `state === "error"`. */
  error?: string;
  /** Lines captured from the extension's `console` for the panel. */
  log: string[];
}

// ── ExtensionHost ─────────────────────────────────────────────────────────────

const MAX_LOG_LINES = 200;

export class ExtensionHost {
  private delegate: HostDelegate;
  private runtimes = new Map<string, ExtensionRuntime>();
  private records = new Map<string, ExtensionHostRecord>();
  private listeners = new Set<() => void>();
  /** registrationId counter shared across all extensions. */
  private nextRegistrationId = 1;
  /** registrationId → owning extension id, for cleanup + dispatch. */
  private registrations = new Map<number, string>();

  constructor(delegate: HostDelegate) {
    this.delegate = delegate;
  }

  /** Update the delegate when the app's workspace/editor wiring changes. */
  setDelegate(delegate: HostDelegate): void {
    this.delegate = delegate;
  }

  // ── Observable state (for React via useSyncExternalStore) ───────────────────

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getRecords = (): ExtensionHostRecord[] => {
    return Array.from(this.records.values()).sort((a, b) =>
      a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()),
    );
  };

  getRecord(extensionId: string): ExtensionHostRecord | undefined {
    return this.records.get(extensionId);
  }

  private emit(): void {
    // Records map is mutated in place; produce a fresh array identity so
    // useSyncExternalStore sees a change.
    this.records = new Map(this.records);
    for (const l of this.listeners) l();
  }

  private ensureRecord(ext: Pick<ExtensionInfo, "id" | "display_name">): ExtensionHostRecord {
    let rec = this.records.get(ext.id);
    if (!rec) {
      rec = { extensionId: ext.id, displayName: ext.display_name, state: "inactive", log: [] };
      this.records.set(ext.id, rec);
    }
    return rec;
  }

  private log(extensionId: string, level: string, message: string): void {
    const rec = this.records.get(extensionId);
    if (!rec) return;
    rec.log.push(`[${level}] ${message}`);
    if (rec.log.length > MAX_LOG_LINES) rec.log.splice(0, rec.log.length - MAX_LOG_LINES);
  }

  /**
   * Teste l'existence d'un asset d'extension **sans** lever : on tente une
   * lecture confinée (les chemins restent relatifs au dossier de l'extension
   * côté backend) ; toute erreur signifie « absent ». Sert à la résolution des
   * fallbacks d'entrypoint (`.js`, `index.js`).
   */
  private async assetExists(extensionId: string, relPath: string): Promise<boolean> {
    try {
      await readExtensionAsset(extensionId, relPath);
      return true;
    } catch {
      return false;
    }
  }

  /** Trace structurée de la résolution d'entrypoint (root, main, chemin, état). */
  private logEntryResolution(ext: ExtensionInfo, resolved: ResolvedEntry): void {
    this.log(
      ext.id,
      "debug",
      `entrypoint: root=${ext.path} main=${JSON.stringify(ext.main)} ` +
        `resolved=${JSON.stringify(resolved.path)} declared=${JSON.stringify(resolved.declared)} ` +
        `kind=${resolved.kind}`,
    );
    this.emit();
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  /**
   * Activate an extension. Requires that every capability the manifest implies
   * has been consented to; otherwise this throws and nothing is executed.
   */
  async activate(ext: ExtensionInfo): Promise<void> {
    const rec = this.ensureRecord(ext);

    // Résolution de l'entrypoint en 3 états (voir `entry.ts`) : un webpack/tsc
    // peut déclarer `main` sans `.js` (cas réel : ms-python.python →
    // "./out/client/extension" alors que le fichier est "extension.js").
    // Ne JAMAIS échouer sur une extension purement déclarative (thème, grammaire).
    const resolved: ResolvedEntry = await resolveEntry(ext.main, (rel) => this.assetExists(ext.id, rel));
    this.logEntryResolution(ext, resolved);

    if (resolved.kind === "declarative") {
      // Pas de code : statut normal, rien à exécuter en mode léger.
      rec.state = "inactive";
      rec.error = undefined;
      this.emit();
      return;
    }

    if (resolved.kind === "missing") {
      // `main` déclaré mais fichier absent → « code non supporté en mode léger »,
      // pas une « error » bloquante : l'extension reste utilisable pour ses
      // contributions passives (thèmes, grammaires, snippets).
      rec.state = "unsupported";
      rec.error = `Code non supporté en mode léger (entrypoint introuvable : ${resolved.declared ?? "?"}).`;
      this.emit();
      return;
    }

    const entryPath = resolved.path!;

    // Guard de prérequis (`extensionDependencies`) : on refuse d'activer tant
    // qu'une dépendance déclarée n'est pas installée. État explicable
    // (« prerequisites-missing »), jamais une « error » : l'extension reste
    // installée et deviendra activable dès que la dépendance sera présente.
    const installed = await this.delegate.getInstalledExtensions();
    const prereq = checkPrerequisites(ext, installed.map((e) => e.id));
    if (!prereq.satisfied) {
      rec.state = "prerequisites-missing";
      rec.error = `Requiert : ${prereq.missing.join(", ")}`;
      this.emit();
      throw new Error(rec.error);
    }

    const required = requiredCapabilities({
      main: ext.main,
      commands: ext.commands,
      activation_events: ext.activation_events,
    });
    const status = consentStatus(ext.id, required);
    if (!status.granted) {
      throw new Error(
        `Missing permissions: ${status.missing.join(", ")}. Grant them before activating.`,
      );
    }

    // Consentement des binaires tiers : l'extension déclare `origin.binaries`
    // des exécutables qu'elle embarque/lance. On refuse d'activer tant que
    // l'utilisateur ne les a pas approuvés explicitement — jamais de lancement
    // silencieux d'un binaire tiers (état explicable, pas une « error »).
    const binStatus = binaryConsentStatus(ext.id, ext.binaries ?? []);
    if (!binStatus.granted) {
      rec.state = "binary-consent-required";
      rec.error = `Binaires tiers à approuver : ${binStatus.missing.join(", ")}`;
      this.emit();
      throw new Error(rec.error);
    }

    // Already active → no-op.
    if (this.runtimes.has(ext.id)) return;

    rec.state = "inactive";
    rec.error = undefined;
    rec.log = [];

    // The granted set is captured now; every bridge call re-checks against it.
    const granted = new Set<Capability>(requiredCapabilities({
      main: ext.main,
      commands: ext.commands,
      activation_events: ext.activation_events,
    }));

    let source: string;
    try {
      source = await readExtensionAsset(ext.id, entryPath);
    } catch (e) {
      rec.state = "error";
      rec.error = `cannot read entrypoint (${entryPath}): ${String(e)}`;
      this.emit();
      throw new Error(rec.error, { cause: e });
    }

    const bridge = this.makeBridge(ext, granted);
    let runtime: ExtensionRuntime | undefined;
    try {
      runtime = await createExtensionRuntime(bridge, ext.path, (level, message) => {
        this.log(ext.id, level, message);
        this.emit();
      });
      // Snapshot the metadata table *before* evaluation: bundles read their own
      // manifest (and `vscode.extensions.all`) synchronously at module load.
      const snapshot = await this.delegate.getInstalledExtensions();
      runtime.setExtensionsSnapshot(snapshot);
      runtime.evalModule(source, entryPath);
      await runtime.activate(ext.id, ext.path);
    } catch (e) {
      runtime?.dispose();
      rec.state = "error";
      rec.error = String(e instanceof Error ? e.message : e);
      this.emit();
      throw new Error(rec.error, { cause: e });
    }

    this.runtimes.set(ext.id, runtime);
    rec.state = "active";
    this.emit();
  }

  /** Deactivate an extension, disposing its isolate and dropping its commands. */
  async deactivate(extensionId: string): Promise<void> {
    const runtime = this.runtimes.get(extensionId);
    if (runtime) {
      await runtime.deactivate();
      runtime.dispose();
      this.runtimes.delete(extensionId);
    }
    unregisterAllForExtension(extensionId);
    for (const [regId, owner] of this.registrations) {
      if (owner === extensionId) this.registrations.delete(regId);
    }
    const rec = this.records.get(extensionId);
    if (rec) {
      rec.state = "inactive";
      this.emit();
    }
  }

  /** Deactivate every active extension (app shutdown / workspace change). */
  async deactivateAll(): Promise<void> {
    for (const id of Array.from(this.runtimes.keys())) {
      await this.deactivate(id).catch(() => {});
    }
  }

  isActive(extensionId: string): boolean {
    return this.runtimes.has(extensionId);
  }

  // ── HostBridge implementation ───────────────────────────────────────────────

  private makeBridge(ext: ExtensionInfo, granted: Set<Capability>): HostBridge {
    const root = () => this.delegate.getWorkspaceRoot();

    /** Resolve+confine a path to the workspace root, then run the safety policy. */
    const confinedPath = (path: string, op: "read" | "write"): string => {
      const workspaceRoot = root();
      if (!workspaceRoot) {
        throw new Error("No workspace folder is open.");
      }
      // Normalise to an absolute path under the workspace root; reject escapes.
      const base = workspaceRoot.replace(/[\\/]+$/, "");
      const full = isAbsolute(path) ? path : `${base}/${path.replace(/^[/\\]+/, "")}`;
      const normalised = normalizePath(full);
      const rootNorm = normalizePath(base);
      if (normalised !== rootNorm && !normalised.startsWith(rootNorm + "/")) {
        throw new Error("Refused: path escapes the workspace folder.");
      }
      assertSafePath(normalised, op);
      return normalised;
    };

    return {
      registerCommand: (commandId, handler) => {
        assertCapability(granted, "commands:register");
        const regId = this.nextRegistrationId++;
        this.registrations.set(regId, ext.id);
        // The manifest supplies the palette label; fall back to the id.
        const declared = ext.commands?.find((c) => c.command === commandId);
        registerInRegistry({
          id: commandId,
          title: declared?.title || commandId,
          category: declared?.category ?? undefined,
          extensionId: ext.id,
          handler: (...args) => handler(...args),
        });
        return regId;
      },

      unregisterCommand: (registrationId) => {
        const owner = this.registrations.get(registrationId);
        if (!owner) return;
        this.registrations.delete(registrationId);
        // Best-effort: the registry keys by command id, not registration id, so
        // we can only drop it if it still belongs to this extension.
        unregisterAllForExtension(ext.id);
      },

      executeCommand: async (commandId, args) => {
        // Running a command is not itself privileged: it may be a built-in or
        // this extension's own. But the *target* enforces its own permissions.
        return this.delegate.executeCommand(commandId, args);
      },

      hasCommand: (commandId) => {
        return this.delegate.executeCommand != null && commandId.length > 0 &&
          // The registry is the source of truth; a cheap synchronous probe:
          registryHas(commandId);
      },

      getCommandIds: () => registryIds(),

      showMessage: async (kind, message) => {
        assertCapability(granted, "window:message");
        this.delegate.notify(kind, `[${ext.display_name}] ${message}`);
        this.log(ext.id, "info", `notification(${kind}): ${message}`);
        this.emit();
        return null;
      },

      log: (level, message) => {
        this.log(ext.id, level, message);
        this.emit();
      },

      getWorkspaceRoot: () => root(),

      readFile: async (path) => {
        assertCapability(granted, "workspace:read");
        return this.delegate.readFile(confinedPath(path, "read"));
      },

      writeFile: async (path, content) => {
        assertCapability(granted, "workspace:write");
        await this.delegate.writeFile(confinedPath(path, "write"), content);
      },

      listDirectory: async (path) => {
        assertCapability(granted, "workspace:read");
        const target = path === undefined ? root() : confinedPath(path, "read");
        if (!target) throw new Error("No workspace folder is open.");
        return this.delegate.listDirectory(target);
      },

      getActiveEditor: () => {
        assertCapability(granted, "editor:modify");
        return this.delegate.getActiveEditor();
      },

      setDocumentText: async (path, content) => {
        assertCapability(granted, "editor:modify");
        await this.delegate.writeFile(confinedPath(path, "write"), content);
      },

      getExtensionInfo: async (id) => this.delegate.getExtensionInfo(id),
      getInstalledExtensions: async () => this.delegate.getInstalledExtensions(),

      isEmptyMessageResult: () => null,
    };
  }
}

// ── Local helpers ─────────────────────────────────────────────────────────────

function isAbsolute(p: string): boolean {
  return p.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(p);
}

/** Collapse `.` / duplicate slashes and resolve `..` lexically. */
function normalizePath(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }
  const prefix = p.startsWith("/") ? "/" : "";
  return prefix + out.join("/");
}

function registryHas(id: string): boolean {
  return getCommand(id) !== undefined;
}

function registryIds(): string[] {
  return getCommands().map((c) => c.id);
}
