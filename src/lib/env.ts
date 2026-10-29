import { invoke } from '@tauri-apps/api/core';

export interface ToolInfo {
  name: string;
  path: string | null;
  version: string | null;
}

/** Détecte Python, Node.js et Git installés sur la machine. */
export async function detectDevEnvironment(): Promise<ToolInfo[]> {
  return invoke<ToolInfo[]>('detect_dev_environment').catch(() => []);
}
