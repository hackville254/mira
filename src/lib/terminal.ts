import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export function terminalCreate(cwd: string, cols: number, rows: number): Promise<number> {
  return invoke("terminal_create", { cwd, cols, rows });
}

/**
 * Lance une tâche (`Run`) dans un PTY dédié, **sans shell** : `program` + `args`
 * sont passés en argv direct (pas d'injection possible). Côté Rust, le programme
 * est validé contre une allowlist d'interpréteurs.
 */
export function terminalCreateTask(
  cwd: string,
  program: string,
  args: string[],
  cols: number,
  rows: number,
): Promise<number> {
  return invoke("terminal_create_task", { cwd, program, args, cols, rows });
}

export function terminalShellName(): Promise<string> {
  return invoke("terminal_shell_name");
}

export function terminalWrite(id: number, data: string): Promise<void> {
  return invoke("terminal_write", { id, data });
}

export function terminalResize(id: number, cols: number, rows: number): Promise<void> {
  return invoke("terminal_resize", { id, cols, rows });
}

export function terminalClose(id: number): Promise<void> {
  return invoke("terminal_close", { id });
}

export async function onTerminalOutput(
  id: number,
  cb: (data: string) => void,
): Promise<() => void> {
  return listen<string>(`terminal-output-${id}`, (event) => cb(event.payload));
}

export async function onTerminalExit(id: number, cb: () => void): Promise<() => void> {
  return listen(`terminal-exit-${id}`, () => cb());
}
