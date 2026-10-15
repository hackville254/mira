import { tool } from "ai";
import { z } from "zod";
import { invoke } from "@tauri-apps/api/core";
import { resolvePath } from "../resolvePath";
import { applyEditDetailed, describeEditFailure } from "../applyEdit";
import { checkPath } from "./security";
import { getTodos, setTodos, type TodoItem } from "./todoStore";

export type { TodoItem };

// ── Pending action descriptors ─────────────────────────────────────────────────

export type PendingAction =
  | { type: "write_file"; path: string; content: string; originalContent: string }
  | { type: "edit";       path: string; original: string; updated: string; mergedContent: string; originalContent: string }
  | { type: "bash_run";   command: string; cwd: string }
  | { type: "ask_user";   question: string; options: string[]; allowFreeform: boolean };

export interface ApprovalEvent {
  id:      string;
  action:  PendingAction;
  approve: () => void;
  /** Pour `ask_user`, `reject(answer)` transmet la réponse choisie / saisie. */
  reject:  (answer?: string) => void;
}

// ── Tool factory ───────────────────────────────────────────────────────────────

export function createTools(opts: {
  folderPath:  string;
  onApproval:  (event: ApprovalEvent) => void;
  /**
   * Appelé AVANT la première écriture d'un fichier dans un tour d'agent, pour
   * que l'appelant puisse en capturer un snapshot (support « Undo all »).
   * Le callback est lui-même chargé de l'idempotence (un même chemin ne doit
   * être snapshoté qu'une fois par tour).
   */
  onBeforeWrite?: (path: string) => void;
  /**
   * Identifiant de session injecté par l'appelant (jamais fourni par le modèle).
   * Sert de clé au store de todo — garantit qu'un `todo_write` ne peut pas
   * écrire dans la liste d'une autre session en mentant sur l'id.
   */
  sessionId?: string;
}) {
  const { folderPath, onApproval, onBeforeWrite, sessionId } = opts;

  /** Snapshot paresseux : appelé au moment de l'approbation, pas à la demande. */
  const recordWrite = (path: string) => { onBeforeWrite?.(path); };

  return {

    read_file: tool({
      description:
        `Read the contents of a file. Workspace root: ${folderPath}. ` +
        "Use absolute paths or paths relative to the workspace root (e.g. src/foo.ts). " +
        `Large files are returned in slices: at most 2000 lines per call. The result reports ` +
        "start_line/end_line/total_lines/truncated — if truncated, call read_file again with " +
        "start_line set to the returned end_line + 1 to continue.",
      inputSchema: z.object({
        path:       z.string().describe("Absolute or workspace-relative path to the file"),
        start_line: z.coerce.number().int().optional().describe("First line to read (1-based). Defaults to 1."),
        end_line:   z.coerce.number().int().optional().describe("Last line to read (1-based, inclusive). Defaults to EOF."),
      }),
      execute: async ({ path, start_line, end_line }) => {
        const resolved = resolvePath(path, folderPath);
        const guard = checkPath(resolved, "read");
        if (!guard.ok) return { error: guard.reason };
        try {
          const slice = await invoke<{
            content: string; start_line: number; end_line: number; total_lines: number; truncated: boolean;
          }>("read_file_range", { path: resolved, workspaceRoot: folderPath, startLine: start_line ?? null, endLine: end_line ?? null });
          return slice;
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),

    list_directory: tool({
      description:
        `List files and subdirectories at a path. Workspace root: ${folderPath}.`,
      inputSchema: z.object({
        path: z.string().describe("Absolute or workspace-relative path to the directory"),
      }),
      execute: async ({ path }) => {
        const resolved = resolvePath(path, folderPath);
        const guard = checkPath(resolved, "read");
        if (!guard.ok) return { error: guard.reason };
        try {
          const entries = await invoke<{ name: string; path: string; is_dir: boolean }[]>(
            "read_dir", { path: resolved }
          );
          return { entries };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),

    grep: tool({
      description: "Search for a text pattern across all files in the workspace.",
      inputSchema: z.object({
        query:  z.string().describe("Case-insensitive search query"),
        folder: z.string().optional().describe("Folder to search (defaults to workspace root)"),
      }),
      execute: async ({ query, folder }) => {
        const resolved = folder ? resolvePath(folder, folderPath) : folderPath;
        try {
          const results = await invoke<{ path: string; line: number; col: number; text: string }[]>(
            "search_in_files", { folder: resolved, query }
          );
          return { results };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),

    glob: tool({
      description: "List all files in the workspace (up to 2000).",
      inputSchema: z.object({
        folder: z.string().optional().describe("Folder to list (defaults to workspace root)"),
      }),
      execute: async ({ folder }) => {
        const resolved = folder ? resolvePath(folder, folderPath) : folderPath;
        try {
          const files = await invoke<{ name: string; path: string; ext: string }[]>(
            "list_workspace_files", { folder: resolved }
          );
          return { files };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),

    write_file: tool({
      description:
        "Write content to a file (create or overwrite). Requires user approval. " +
        "Parent directories are created automatically.",
      inputSchema: z.object({
        path:    z.string().describe("Absolute or workspace-relative path to write"),
        content: z.string().describe("Full file content to write"),
      }),
      execute: async ({ path, content }, { toolCallId }) => {
        const resolved = resolvePath(path, folderPath);
        const guard = checkPath(resolved, "write");
        if (!guard.ok) return { error: guard.reason };
        let originalContent = "";
        try {
          originalContent = await invoke<string>("read_file", { path: resolved, workspaceRoot: folderPath });
        } catch {
          // New file — original is empty
        }
        return new Promise((resolve) => {
          onApproval({
            id: toolCallId,
            action: { type: "write_file", path: resolved, content, originalContent },
            approve: async () => {
              try {
                recordWrite(resolved);
                await invoke("write_file", { path: resolved, content, workspaceRoot: folderPath });
                resolve({ success: true, path: resolved });
              } catch (e) {
                resolve({ error: String(e) });
              }
            },
            reject: () => resolve({ cancelled: true }),
          });
        });
      },
    }),

    edit: tool({
      description:
        "Replace old_string with new_string in an existing file. Requires user approval — the diff is shown before applying.\n" +
        "Matching is tolerant: exact → whitespace-trimmed → normalized punctuation → fuzzy (≥66% similar). " +
        "old_string MUST resolve to exactly ONE location. If it appears multiple times the edit is refused as " +
        "ambiguous — include 3–5 lines of unique surrounding context. Never send the same call twice after a failure.",
      inputSchema: z.object({
        path:       z.string().describe("Absolute or workspace-relative path to the file"),
        old_string: z.coerce.string().describe("Text to find — copy it verbatim from the current file, incl. indentation"),
        new_string: z.coerce.string().describe("Replacement text"),
      }),
      execute: async ({ path, old_string, new_string }, { toolCallId }) => {
        const resolved = resolvePath(path, folderPath);
        const guard = checkPath(resolved, "write");
        if (!guard.ok) return { error: guard.reason };
        let fileContent: string;
        try {
          fileContent = await invoke<string>("read_file", { path: resolved, workspaceRoot: folderPath });
        } catch (e) {
          return { error: `Cannot read file: ${String(e)}` };
        }

        const res = applyEditDetailed(fileContent, old_string, new_string);
        if (!res.ok) return { error: describeEditFailure(resolved, res.outcome) };
        const mergedContent = res.content;
        const fuzzyNote = res.fuzz > 0 ? ` (fuzzy match, fuzz ${res.fuzz})` : "";

        return new Promise((resolve) => {
          onApproval({
            id: toolCallId,
            action: { type: "edit", path: resolved, original: old_string, updated: new_string, mergedContent, originalContent: fileContent },
            approve: async () => {
              try {
                recordWrite(resolved);
                await invoke("write_file", { path: resolved, content: mergedContent, workspaceRoot: folderPath });
                resolve({ success: true, path: resolved, note: fuzzyNote || undefined });
              } catch (e) {
                resolve({ error: String(e) });
              }
            },
            reject: () => resolve({ cancelled: true }),
          });
        });
      },
    }),

    multi_edit: tool({
      description:
        "Apply several search/replace edits to ONE file atomically and open a single diff. " +
        "Edits run in order, each old_string matched against the content produced by the previous edit " +
        "(same tolerant matching as `edit`). If ANY edit fails or is ambiguous, NOTHING is written — " +
        "the whole batch is rejected and the error names the failing edit. Prefer this over many `edit` calls.",
      inputSchema: z.object({
        path:  z.string().describe("Absolute or workspace-relative path to the file"),
        edits: z.array(z.object({
          old_string: z.coerce.string().describe("Text to find — verbatim, must be unique at the time it is applied"),
          new_string: z.coerce.string().describe("Replacement text"),
        })).min(1).describe("Ordered list of replacements; all-or-nothing"),
      }),
      execute: async ({ path, edits }, { toolCallId }) => {
        const resolved = resolvePath(path, folderPath);
        const guard = checkPath(resolved, "write");
        if (!guard.ok) return { error: guard.reason };
        let fileContent: string;
        try {
          fileContent = await invoke<string>("read_file", { path: resolved, workspaceRoot: folderPath });
        } catch (e) {
          return { error: `Cannot read file: ${String(e)}` };
        }

        let content = fileContent;
        for (let i = 0; i < edits.length; i++) {
          const e = edits[i];
          const res = applyEditDetailed(content, e.old_string, e.new_string);
          if (!res.ok) {
            return { error: `Edit #${i + 1} of ${edits.length} failed — no changes were written. ${describeEditFailure(resolved, res.outcome)}` };
          }
          content = res.content;
        }

        const mergedContent = content;
        return new Promise((resolve) => {
          onApproval({
            id: toolCallId,
            action: { type: "edit", path: resolved, original: edits.map((e) => e.old_string).join("\n…\n"), updated: edits.map((e) => e.new_string).join("\n…\n"), mergedContent, originalContent: fileContent },
            approve: async () => {
              try {
                recordWrite(resolved);
                await invoke("write_file", { path: resolved, content: mergedContent, workspaceRoot: folderPath });
                resolve({ success: true, path: resolved, applied: edits.length });
              } catch (e) {
                resolve({ error: String(e) });
              }
            },
            reject: () => resolve({ cancelled: true }),
          });
        });
      },
    }),

    bash_run: tool({
      description:
        "Run a shell command. Requires user approval. Non-interactive, with a hard " +
        "120s timeout (the process is killed on timeout) and output capped at 64 KB " +
        "per stream. For long-running processes (dev servers, watchers) start them " +
        "detached (e.g. `nohup … &`) and poll instead of blocking.",
      inputSchema: z.object({
        command: z.string().describe("Command to execute"),
        cwd:     z.string().optional().describe("Working directory (defaults to workspace root)"),
      }),
      execute: async ({ command, cwd }, { toolCallId }) => {
        const guard = checkPath(command, "exec");
        if (!guard.ok) return { error: guard.reason };
        const resolvedCwd = cwd ? resolvePath(cwd, folderPath) : folderPath;
        return new Promise((resolve) => {
          onApproval({
            id: toolCallId,
            action: { type: "bash_run", command, cwd: resolvedCwd },
            approve: async () => {
              try {
                const result = await invoke<{ stdout: string; stderr: string; exit_code: number; timed_out: boolean; truncated: boolean }>(
                  "agent_bash_run", { command, cwd: resolvedCwd }
                );
                const notes: string[] = [];
                if (result.truncated) notes.push("output was truncated at 64 KB");
                resolve(notes.length ? { ...result, note: notes.join("; ") } : result);
              } catch (e) {
                resolve({ error: String(e) });
              }
            },
            reject: () => resolve({ cancelled: true }),
          });
        });
      },
    }),

    todo_write: tool({
      description:
        "Replace the persistent task list for this session. Use for any " +
        "non-trivial multi-step task: keep exactly one item `in_progress` and " +
        "flip items to `done` as you finish them (never batch completions — mark " +
        "each one the moment it is actually finished). Always pass the FULL list — " +
        "it overwrites the previous one. Auto-executes (no approval).",
      inputSchema: z.object({
        todos: z.array(
          z.object({
            id:      z.string().describe("Short unique id, e.g. \"t1\", \"t2\""),
            content: z.string().describe("Description of the task"),
            status:  z.enum(["pending", "in_progress", "done", "cancelled"]),
          }),
        ).describe("The complete task list for this session"),
      }),
      execute: async ({ todos }) => {
        if (!sessionId) return { ok: false, count: 0 };
        const items: TodoItem[] = todos.map((t) => ({
          id: t.id, content: t.content, status: t.status,
        }));
        setTodos(sessionId, items);
        return { ok: true, count: items.length };
      },
    }),

    todo_read: tool({
      description:
        "Read the persistent task list for this session. Returns an " +
        "empty list if nothing has been written yet. Auto-executes (no approval).",
      inputSchema: z.object({}),
      execute: async () => {
        return { todos: getTodos(sessionId) };
      },
    }),

    ask_user: tool({
      description:
        "Ask the user a clarifying question and BLOCK until they answer. Use it when you genuinely " +
        "cannot proceed without a decision that is the user's to make (ambiguous intent, a destructive " +
        "or irreversible choice, a preference you cannot infer). Do NOT use it for things you can " +
        "determine from the codebase — prefer reading files. Provide 2–4 concrete options; the user may " +
        "also type a free-form answer. Your turn PAUSES here until answered: never ask two questions in " +
        "a row, and never ask before having read the relevant files.",
      inputSchema: z.object({
        question: z.string().describe("The question to ask — concise, one decision only"),
        options: z.array(z.string()).min(2).max(4).describe("2–4 concrete, mutually exclusive options"),
        allow_freeform: z.coerce.boolean().optional().describe("Also allow a typed answer (default true)"),
      }),
      execute: async ({ question, options, allow_freeform }, { toolCallId }) => {
        const allowFreeform = allow_freeform ?? true;
        return new Promise((resolve) => {
          onApproval({
            id: toolCallId,
            action: { type: "ask_user", question, options, allowFreeform },
            approve: () => resolve({ cancelled: true }),
            // La réponse choisie par l'utilisateur est transmise via `answer`.
            reject: (answer?: string) => resolve({ answer: answer ?? "" }),
          });
        });
      },
    }),

  } as const;
}

// ── Read-only tool subset (used by Plan mode Phase 1) ─────────────────────────

export function createReadOnlyTools(opts: { folderPath: string }) {
  const all = createTools({ folderPath: opts.folderPath, onApproval: () => {} });
  return {
    read_file:      all.read_file,
    list_directory: all.list_directory,
    grep:           all.grep,
    glob:           all.glob,
    todo_read:      all.todo_read,
  };
}

// ── Ask mode tools (edit-only, no disk write — diff view handles write-back) ──

// Resolve a (possibly short) AI-provided path to { fullPath, content }.
// Open editor files take priority — matched by suffix so the AI can pass
// just "layout.tsx" or "app/layout.tsx" and still hit the right open buffer.
// Falls back to a disk read only when the file is not open.
async function resolveFileContent(
  aiPath: string,
  folderPath: string,
  getFileContents: () => Record<string, string>,
): Promise<{ fullPath: string; content: string } | { error: string }> {
  const norm = aiPath.replace(/\\/g, "/");
  const openContents = getFileContents();
  for (const [fullPath, content] of Object.entries(openContents)) {
    const normFull = fullPath.replace(/\\/g, "/");
    if (normFull === norm || normFull.endsWith("/" + norm)) {
      return { fullPath, content };
    }
  }
  // Not open — read from disk
  try {
    const resolved = resolvePath(aiPath, folderPath);
    const content = await invoke<string>("read_file", { path: resolved, workspaceRoot: folderPath });
    return { fullPath: resolved, content };
  } catch (e) {
    return { error: `Cannot read file "${aiPath}": ${String(e)}` };
  }
}

export function createAskTools(opts: {
  folderPath: string;
  getFileContents: () => Record<string, string>;
  onShowDiff: (path: string, original: string, patched: string) => void;
}) {
  const { folderPath, getFileContents, onShowDiff } = opts;

  return {
    edit: tool({
      description:
        "Replace an exact string in a file and open a per-hunk diff for the user to review. " +
        "old_string must match the file verbatim (including whitespace) and be unique — " +
        "include 3–5 lines of surrounding context to guarantee uniqueness.",
      inputSchema: z.object({
        path:       z.string().describe("Workspace-relative path to the file (e.g. src/foo.ts)"),
        old_string: z.string().describe("Exact text to replace — verbatim, must be unique in the file"),
        new_string: z.string().describe("Replacement text"),
      }),
      execute: async ({ path, old_string, new_string }) => {
        const resolved = await resolveFileContent(path, folderPath, getFileContents);
        if ("error" in resolved) return { error: resolved.error };
        const res = applyEditDetailed(resolved.content, old_string, new_string);
        if (!res.ok) return { error: describeEditFailure(resolved.fullPath, res.outcome) };
        onShowDiff(resolved.fullPath, resolved.content, res.content);
        return { ok: true, fuzz: res.fuzz };
      },
    }),

    multi_edit: tool({
      description:
        "Apply multiple search/replace edits to a single file atomically, then open a diff for review. " +
        "Edits are applied in order; each old_string is matched against the content after previous edits. " +
        "Matching is tolerant (exact → trimmed → normalized punctuation → fuzzy ≥66%); if any edit is " +
        "ambiguous or not found the whole batch is refused and nothing is shown.",
      inputSchema: z.object({
        path:  z.string().describe("Workspace-relative path to the file"),
        edits: z.array(z.object({
          old_string: z.coerce.string().describe("Text to replace — verbatim, must be unique at the time it is applied"),
          new_string: z.coerce.string().describe("Replacement text"),
        })).min(1).describe("Ordered list of replacements to apply"),
      }),
      execute: async ({ path, edits }) => {
        const resolved = await resolveFileContent(path, folderPath, getFileContents);
        if ("error" in resolved) return { error: resolved.error };
        let content = resolved.content;
        for (let i = 0; i < edits.length; i++) {
          const e = edits[i];
          const res = applyEditDetailed(content, e.old_string, e.new_string);
          if (!res.ok) {
            return { error: `Edit #${i + 1} of ${edits.length} failed — no changes shown. ${describeEditFailure(resolved.fullPath, res.outcome)}` };
          }
          content = res.content;
        }
        onShowDiff(resolved.fullPath, resolved.content, content);
        return { ok: true, applied: edits.length };
      },
    }),
  } as const;
}
