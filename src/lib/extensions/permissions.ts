/**
 * Level-2 extension permission model.
 *
 * Extensions that ship code run in a sandboxed QuickJS runtime: they have NO
 * access to the DOM, `window`, the network, Tauri's `invoke`, or any host global.
 * The only thing they can do is call the `vscode.*` API surface we expose, and
 * every one of those calls is routed through this mediator.
 *
 * Capabilities are coarse, user-understandable permissions. They are derived
 * from the extension manifest (declared commands, whether it ships code) and
 * must be explicitly consented to by the user before the extension is activated.
 * A refused capability means the extension cannot be activated at all — we never
 * run code the user did not approve.
 */

import { checkPath } from "../agent/security";

/** Coarse-grained capabilities an extension may request. */
export type Capability =
  | "commands:register"      // contribute entries to the command palette
  | "window:message"         // show info/warning/error notifications
  | "workspace:read"         // read files inside the open workspace
  | "workspace:write"        // write files inside the open workspace
  | "editor:modify";         // read/modify the active editor buffer

export const CAPABILITY_INFO: Record<Capability, { label: string; detail: string }> = {
  "commands:register": {
    label: "Register commands",
    detail: "Add entries to the command palette that run this extension's code.",
  },
  "window:message": {
    label: "Show notifications",
    detail: "Display information, warning and error messages.",
  },
  "workspace:read": {
    label: "Read workspace files",
    detail: "Read files that are inside the currently open project folder.",
  },
  "workspace:write": {
    label: "Modify workspace files",
    detail: "Create, edit or delete files inside the currently open project folder.",
  },
  "editor:modify": {
    label: "Edit the active editor",
    detail: "Read and change the document open in the active editor tab.",
  },
};

/**
 * Infer the capabilities an extension needs from its manifest.
 *
 * Conservative: an extension that ships code but declares nothing still needs
 * `commands:register` + `window:message` (the two harmless building blocks any
 * extension uses), and is granted workspace/editor access only when it declares
 * an activation event or command that implies it. Because we cannot know what
 * arbitrary code will attempt, the *mediator* still enforces at call time — this
 * list only drives the consent prompt.
 */
export function requiredCapabilities(manifest: {
  has_main?: boolean;
  main?: string | null;
  commands?: unknown[];
  activation_events?: string[];
}): Capability[] {
  if (!manifest.main && !manifest.has_main) return [];
  const caps: Capability[] = ["commands:register", "window:message"];

  const events = manifest.activation_events ?? [];
  // `onStartupFinished` / `*` extensions typically touch the workspace; be
  // transparent about it so the user sees the broader access up front.
  if (events.some(e => e === "*" || e === "onStartupFinished")) {
    caps.push("workspace:read", "editor:modify");
  }
  return caps;
}

// ── Consent storage ───────────────────────────────────────────────────────────

const STORAGE_KEY = "origin-extension-consents";

/** extensionId → granted capabilities. */
type ConsentMap = Record<string, Capability[]>;

function readConsents(): ConsentMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as ConsentMap) : {};
  } catch {
    return {};
  }
}

function writeConsents(map: ConsentMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Storage may be unavailable (private mode); consent simply won't persist.
  }
}

/** Capabilities the user has granted to an extension. */
export function grantedCapabilities(extensionId: string): Capability[] {
  return readConsents()[extensionId] ?? [];
}

/** Persist the user's decision for one extension. */
export function setGrantedCapabilities(extensionId: string, caps: Capability[]): void {
  const map = readConsents();
  map[extensionId] = caps;
  writeConsents(map);
}

/** Drop all stored consents for an extension (used on uninstall). */
export function clearCapabilities(extensionId: string): void {
  const map = readConsents();
  delete map[extensionId];
  writeConsents(map);
}

/**
 * Whether an extension has been granted everything it requires (and therefore
 * may be activated). Returns the missing set otherwise.
 */
export function consentStatus(
  extensionId: string,
  required: Capability[],
): { granted: boolean; missing: Capability[] } {
  const have = new Set(grantedCapabilities(extensionId));
  const missing = required.filter(c => !have.has(c));
  return { granted: missing.length === 0, missing };
}

// ── Runtime guard ─────────────────────────────────────────────────────────────

/**
 * Called by the `vscode` shim before any privileged operation. Throws if the
 * capability was not granted, so a misbehaving extension cannot exceed the
 * permissions the user approved — consent is enforced at every call, not just
 * at activation.
 *
 * For workspace file paths we additionally run the existing agent path-safety
 * policy (`checkPath`), so even a granted `workspace:write` cannot escape the
 * workspace confinement check that the caller performs on top.
 */
export function assertCapability(granted: Set<Capability>, cap: Capability): void {
  if (!granted.has(cap)) {
    throw new Error(`Permission denied: "${cap}" was not granted to this extension.`);
  }
}

/**
 * Validate a workspace-relative path against the shared safety policy before a
 * file operation. `checkPath` rejects secrets, protected dirs and `..`
 * traversal; the caller is still responsible for confining to the workspace
 * root (it knows the root; we don't).
 */
export function assertSafePath(path: string, op: "read" | "write"): void {
  const res = checkPath(path, op);
  if (!res.ok) throw new Error(res.reason);
}
