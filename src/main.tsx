import React from "react";
import ReactDOM from "react-dom/client";
import { addCollection } from "@iconify/react";
import { icons as lucideIcons } from "@iconify-json/lucide";
import "./index.css";
import App from "./App";
import { ThemeProvider } from "./themes/ThemeContext";
import { WorkspaceProvider } from "./context/WorkspaceContext";
import { ToastProvider } from "./components/ui/Toast";
import { ErrorBoundary } from "./components/ui/ErrorBoundary";
import { DebugProvider } from "./context/DebugContext";
import { ExtensionsProvider } from "./context/ExtensionsContext";
import { DiagnosticsProvider } from "./context/DiagnosticsContext";

// Toutes les icônes de l'app utilisent le préfixe `lucide:` via `@iconify/react`.
// Par défaut, Iconify les télécharge à la demande depuis son CDN — ce qui les
// rend INVISIBLES hors ligne ou si le CDN est lent/bloqué. On embarque donc la
// collection lucide DANS le bundle (`@iconify-json/lucide`) et on l'enregistre
// une fois pour toutes : rendu instantané, aucun appel réseau, fonctionne
// hors ligne. Aucun composant n'a besoin d'être modifié.
addCollection(lucideIcons);

// Apply persisted appearance preferences before the first paint so there is no
// flash of the default density/status-bar state.
(function applyAppearancePrefs() {
  const root = document.documentElement;
  root.setAttribute("data-density", localStorage.getItem("origin-ui-density") ?? "comfortable");
  root.setAttribute("data-status-bar", localStorage.getItem("origin-ui-status-bar") ?? "true");
})();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ThemeProvider>
        <WorkspaceProvider>
          <ExtensionsProvider>
            <ToastProvider>
              <DebugProvider>
                <DiagnosticsProvider>
                  <App />
                </DiagnosticsProvider>
              </DebugProvider>
            </ToastProvider>
          </ExtensionsProvider>
        </WorkspaceProvider>
      </ThemeProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
