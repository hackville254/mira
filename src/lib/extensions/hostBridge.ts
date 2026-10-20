/**
 * Host bridge for the sandboxed extension runtime (Level 2).
 *
 * This interface is the ONLY thing the `vscode.*` shim inside QuickJS can call.
 * Everything is a plain async function implemented in the main webview; the
 * sandbox never receives a reference to `window`, the DOM, `invoke`, or any
 * other host global — just these capability-gated methods.
 *
 * The host implementation (see `ExtensionHost`) is responsible for enforcing
 * permissions via `assertCapability` before doing anything privileged.
 */

/** A document view of an open editor, as seen by an extension. */
export interface HostTextDocument {
  /** Absolute path or synthetic uri. */
  uri: string;
  /** VS Code language id (best-effort). */
  languageId: string;
  /** Full text of the document. */
  getText: () => string;
}

export interface HostBridge {
  /**
   * Register a command handler. Returns a disposable id the sandbox can use to
   * unregister. `title` is taken from the manifest by the host.
   */
  registerCommand: (commandId: string, handler: (...args: unknown[]) => unknown) => number;

  /** Unregister a previously registered command (by the id returned above). */
  unregisterCommand: (registrationId: number) => void;

  /** Run another command by id (built-in or extension). */
  executeCommand: (commandId: string, args: unknown[]) => Promise<unknown>;

  /** Whether a command id currently has a handler. */
  hasCommand: (commandId: string) => boolean;

  /** All command ids currently registered (usable by extensions that list them). */
  getCommandIds: () => string[];

  // ── window ────────────────────────────────────────────────────────────────
  /** Show an information/warning/error notification. Resolves to null. */
  showMessage: (kind: "info" | "warning" | "error", message: string) => Promise<null>;

  /** Append a line to the extension host log (visible in the panel). */
  log: (level: "debug" | "info" | "warn" | "error", message: string) => void;

  // ── workspace ─────────────────────────────────────────────────────────────
  /** Workspace root, or null when no folder is open. */
  getWorkspaceRoot: () => string | null;

  /** Read a workspace-relative or absolute (confined) file. */
  readFile: (path: string) => Promise<string>;

  /** Write text to a workspace-relative or absolute (confined) file. */
  writeFile: (path: string, content: string) => Promise<void>;

  /** List entries of a directory (defaults to the workspace root). */
  listDirectory: (path?: string) => Promise<{ name: string; isDirectory: boolean }[]>;

  // ── editor ────────────────────────────────────────────────────────────────
  /** The active editor's document, or null when none is open. */
  getActiveEditor: () => (HostTextDocument & { path: string }) | null;

  /** Replace the entire text of a document identified by path. */
  setDocumentText: (path: string, content: string) => Promise<void>;

  // ── extensions ──────────────────────────────────────────────────────────────
  /**
   * Metadata for one installed extension. The shim does NOT call this at run
   * time — metadata is snapshotted into the VM before evaluation (see
   * `ExtensionRuntime.setExtensionsSnapshot`) because `vscode.extensions.*` is
   * a synchronous API that bundles read at module load. Kept on the bridge so
   * the host has one uniform surface for extension metadata.
   */
  getExtensionInfo: (id: string) => Promise<ExtensionMetadata | undefined>;

  /** Metadata for every installed extension. See {@link getExtensionInfo}. */
  getInstalledExtensions: () => Promise<ExtensionMetadata[]>;

  /** Convention used by the shim for `window.show*Message` return values. */
  isEmptyMessageResult: () => null;
}

/** Read-only extension metadata exposed to `vscode.extensions.*`. */
export interface ExtensionMetadata {
  id: string;
  extensionPath: string;
  isActive: boolean;
  packageJSON: Record<string, unknown>;
}
