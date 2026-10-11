import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App";
import { ThemeProvider } from "./themes/ThemeContext";
import { WorkspaceProvider } from "./context/WorkspaceContext";
import { ToastProvider } from "./components/ui/Toast";
import { ErrorBoundary } from "./components/ui/ErrorBoundary";
import { DebugProvider } from "./context/DebugContext";
import { ExtensionsProvider } from "./context/ExtensionsContext";

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
                <App />
              </DebugProvider>
            </ToastProvider>
          </ExtensionsProvider>
        </WorkspaceProvider>
      </ThemeProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
