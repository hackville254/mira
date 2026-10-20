/**
 * Dynamic command registry (Level 2).
 *
 * The built-in commands in `keybindings.ts` are static. Extensions contribute
 * commands at *runtime* — when their `activate()` calls
 * `vscode.commands.registerCommand(id, fn)`. This module is the single place
 * where those live, so three consumers can agree on one source of truth:
 *
 *   - the `vscode.commands` shim registers/unregisters handlers here,
 *   - the command palette lists and runs them,
 *   - the global keybinding listener dispatches them.
 *
 * Kept framework-free (a module-level store + subscribe) so it can be used from
 * React via `useSyncExternalStore` and from plain code alike.
 */

export interface RegisteredCommand {
  /** Command id, e.g. `acme.sayHello`. */
  id: string;
  /** Palette label (from the manifest, or the id as a fallback). */
  title: string;
  /** Optional category for grouping in the palette. */
  category?: string;
  /** Owning extension id, or null for built-ins. */
  extensionId: string | null;
  /** The handler. May be async; errors are surfaced to the caller. */
  handler: (...args: unknown[]) => unknown;
}

type Listener = () => void;

/** id → command. Insertion order is preserved for stable palette ordering. */
const commands = new Map<string, RegisteredCommand>();
const listeners = new Set<Listener>();

/**
 * Cached snapshot. `useSyncExternalStore` compares the snapshot identity on
 * every render and re-renders again when it changes, so returning a fresh
 * array each call would loop forever. We rebuild only when the map mutates.
 */
let snapshot: RegisteredCommand[] = [];

function emit(): void {
  snapshot = Array.from(commands.values());
  for (const l of listeners) l();
}

/** Subscribe to registry changes. Returns an unsubscribe function. */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Stable snapshot for `useSyncExternalStore` — new identity only on change. */
export function getCommands(): RegisteredCommand[] {
  return snapshot;
}

/**
 * Register a command handler. Re-registering the same id overwrites it (VS Code
 * semantics: last registration wins within a session).
 */
export function registerCommand(cmd: RegisteredCommand): void {
  commands.set(cmd.id, cmd);
  emit();
}

/** Remove a single command by id. No-op if absent. */
export function unregisterCommand(id: string): void {
  if (commands.delete(id)) emit();
}

/** Remove every command contributed by an extension (called on deactivation). */
export function unregisterAllForExtension(extensionId: string): void {
  let changed = false;
  for (const [id, cmd] of commands) {
    if (cmd.extensionId === extensionId) {
      commands.delete(id);
      changed = true;
    }
  }
  if (changed) emit();
}

/** Look up a command without running it. */
export function getCommand(id: string): RegisteredCommand | undefined {
  return commands.get(id);
}

/**
 * Run a command by id. Rejects (async) if unknown, and propagates handler
 * errors so the caller (palette / shim) can report them — we never swallow
 * a failing command silently.
 */
export async function executeCommand(id: string, ...args: unknown[]): Promise<unknown> {
  const cmd = commands.get(id);
  if (!cmd) throw new Error(`Command not found: ${id}`);
  return await cmd.handler(...args);
}
