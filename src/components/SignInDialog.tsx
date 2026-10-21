import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { runDeviceSignIn, type DeviceStart } from "../lib/agent/account";
import { emitCustomModelsChanged } from "../lib/agent/customModels";

// ── Connexion Mira depuis la barre de titre ──────────────────────────────────
//
// Le bouton « Log in » de la barre de titre lance le device flow DIRECTEMENT,
// sans passer par les réglages : c'est l'action attendue au premier lancement,
// et détourner par un écran de réglages ajoutait un clic inutile.
//
// Cette modale ne voit jamais le token ni la clé Orvyx (tout reste côté Rust) :
// elle n'affiche que le code utilisateur et l'état d'avancement.

/** Normalise une erreur Tauri (chaîne) ou JS en message affichable. */
function normalize(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return "Something went wrong";
}

export default function SignInDialog({ onClose }: { onClose: () => void }) {
  const [flow, setFlow] = useState<DeviceStart | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Une seule exécution, même si React rejoue les effets en mode strict.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const controller = new AbortController();
    abortRef.current = controller;

    void (async () => {
      try {
        const result = await runDeviceSignIn({
          label: "Mira Desktop",
          signal: controller.signal,
          onStarted: async (f: DeviceStart) => {
            setFlow(f);
            // Ouvre la page de vérification dans le navigateur de l'utilisateur.
            await openUrl(f.verificationUriComplete).catch(() => { /* repli : le code reste affiché */ });
          },
        });
        if (result === "approved") {
          // Le sélecteur de modèles doit refléter le catalogue sans rechargement.
          emitCustomModelsChanged();
          setDone(true);
        } else if (result === "denied") {
          setError("Sign-in was denied.");
        } else if (result === "expired") {
          setError("The code expired. Please try again.");
        }
        // « cancelled » : l'utilisateur a fermé, rien à afficher.
      } catch (e) {
        setError(normalize(e));
      }
    })();

    return () => controller.abort();
  }, []);

  const handleClose = useCallback(() => {
    abortRef.current?.abort();
    onClose();
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Sign in to Mira"
      style={{
        position: "fixed", inset: 0, zIndex: 60,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "rgba(0,0,0,0.45)", padding: "20px",
      }}
      onClick={handleClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: "100%", maxWidth: "400px",
          background: "var(--origin-bg-base)",
          border: "1px solid var(--origin-border-default)",
          borderRadius: "10px",
          boxShadow: "0 12px 32px rgba(0,0,0,0.35)",
          overflow: "hidden",
          fontSize: "12px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "8px", padding: "12px 14px", borderBottom: "1px solid var(--origin-border-default)" }}>
          <Icon icon="lucide:log-in" width={16} style={{ color: "var(--origin-accent-blue)", flexShrink: 0 }} />
          <span style={{ flex: 1, fontSize: "13px", fontWeight: 600, color: "var(--origin-fg-default)" }}>
            Sign in to Mira
          </span>
        </div>

        <div style={{ padding: "14px" }}>
          {error ? (
            <div style={{ color: "var(--origin-semantic-error, #ef4444)", marginBottom: "12px" }}>
              {error}
            </div>
          ) : done ? (
            <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "var(--origin-fg-default)" }}>
              <Icon icon="lucide:check-circle-2" width={15} style={{ color: "var(--origin-semantic-success, #2ea043)" }} />
              Signed in. Your models are ready.
            </div>
          ) : (
            <>
              <div style={{ color: "var(--origin-fg-muted)", marginBottom: "10px" }}>
                {flow
                  ? "Your browser just opened. Enter this code to finish signing in:"
                  : "Starting sign-in…"}
              </div>
              {flow && (
                <div
                  style={{
                    fontFamily: "var(--font-mono)", fontSize: "22px", letterSpacing: "0.18em",
                    color: "var(--origin-fg-default)", padding: "6px 0", userSelect: "all",
                    textAlign: "center",
                  }}
                >
                  {flow.userCode}
                </div>
              )}
              {flow && (
                <button
                  onClick={() => openUrl(flow.verificationUriComplete).catch(() => { /* repli */ })}
                  style={{
                    marginTop: "6px", padding: "5px 10px", borderRadius: "6px", fontSize: "12px",
                    cursor: "pointer", width: "100%",
                    border: "1px solid var(--origin-border-default)",
                    background: "transparent", color: "var(--origin-fg-default)",
                  }}
                >
                  Open browser again
                </button>
              )}
            </>
          )}
        </div>

        <div style={{ padding: "10px 14px", borderTop: "1px solid var(--origin-border-default)", backgroundColor: "var(--origin-bg-editor)", display: "flex", justifyContent: "flex-end" }}>
          <button
            onClick={handleClose}
            style={{
              padding: "5px 12px", borderRadius: "6px", fontSize: "12px",
              cursor: "pointer",
              border: "1px solid var(--origin-border-default)",
              background: done ? "var(--origin-accent-blue)" : "transparent",
              color: done ? "#fff" : "var(--origin-fg-default)",
            }}
          >
            {done ? "Done" : "Cancel"}
          </button>
        </div>
      </div>
    </div>
  );
}
