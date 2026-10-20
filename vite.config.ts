import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      //
      // `bench/**` est AUSSI ignoré : le harnais de benchmark clone de vrais
      // dépôts sous `bench/coding/swebench/.envs/**`, dans l'arbre du projet.
      // Sans cette exclusion, CHAQUE écriture de l'agent déclenche un
      // full-reload Vite → la webview se recharge → l'auto-run redémarre et le
      // run mesuré est détruit. Ce n'est pas une modification du moteur : juste
      // le périmètre surveillé par le serveur de dev.
      ignored: ["**/src-tauri/**", "**/bench/**"],
    },
  },
}));
