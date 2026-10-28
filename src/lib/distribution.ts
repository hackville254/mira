/**
 * Canal de distribution — pendant frontend de `src-tauri/src/distribution.rs`.
 *
 * RÔLE
 * ----
 * Savoir QUI possède la mise à jour :
 *   - `direct`          → l'app s'auto-met à jour via `tauri-plugin-updater`
 *                         (GitHub Releases : macOS/Linux/Windows hors Store).
 *   - `microsoft_store` → c'est le Microsoft Store qui met à jour (build MSIX).
 *
 * Sur le Store, le plugin updater n'est PAS enregistré côté Rust : appeler
 * `check()` lèverait une erreur « plugin not found ». On DOIT donc consulter ce
 * canal avant tout appel d'updater.
 *
 * Repli : si la commande échoue (WebView hors Tauri, version antérieure), on
 * suppose `direct` — c'est le comportement historique et le plus sûr en dev.
 */

import { invoke } from "@tauri-apps/api/core";

export type DistributionChannel = "direct" | "microsoft_store";

let cached: DistributionChannel | null = null;

/** Renvoie le canal de distribution, mémoïsé (une seule IPC par session). */
export async function getDistributionChannel(): Promise<DistributionChannel> {
  if (cached) return cached;
  try {
    cached = await invoke<DistributionChannel>("distribution_channel");
  } catch {
    cached = "direct";
  }
  return cached;
}

/** Vrai si l'app peut/doit gérer elle-même ses mises à jour. */
export async function canSelfUpdate(): Promise<boolean> {
  return (await getDistributionChannel()) === "direct";
}
