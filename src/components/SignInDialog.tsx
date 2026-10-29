import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { runDeviceSignIn, type DeviceStart } from "../lib/agent/account";
import { createAuthNudge } from "../lib/deepLink";
import { emitCustomModelsChanged } from "../lib/agent/customModels";

// ── Connexion Mira depuis la barre de titre ──────────────────────────────────
//
// Le bouton « Log in » de la barre de titre lance la connexion DIRECTEMENT,
// sans passer par les réglages : c'est l'action attendue au premier lancement.
//
// Parcours « par lien » (façon Trae) : on ouvre le navigateur sur un lien qui
// autorise l'appareil tout seul. L'utilisateur n'a RIEN à recopier — juste à
// confirmer dans son navigateur (et à se connecter s'il ne l'est pas déjà).
// Aucun code n'est jamais affiché : si le navigateur ne s'ouvre pas, un bouton
// relance la page d'appairage.
//
// Cette modale ne voit jamais le token ni la clé Orvyx (tout reste côté Rust) :
// elle n'affiche que l'état d'avancement.

/** Normalise une erreur Tauri (chaîne) ou JS en message affichable. */
function normalize(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return "Something went wrong";
}

export default function SignInDialog({ onClose }: { onClose: () => void }) {
  const [flow, setFlow] = useState<DeviceStart | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [browserFailed, setBrowserFailed] = useState(false);
  const [done, setDone] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // `onClose` sert dans l'effet à exécution unique (fermeture au succès) :
  // on le lit via une ref pour ne pas relancer le flow si son identité change.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;

    // Deep link `mira://auth` : le navigateur a approuvé, on veut le savoir tout
    // de suite plutôt que d'attendre le prochain tick de polling (jusqu'à 5 s).
    // `listen()` renvoie un désabonnement qu'on relâche au démontage.
    const nudge = createAuthNudge();
    let unlistenNudge: (() => void) | undefined;
    let cancelled = false;
    void nudge.listen().then((off) => {
      // L'effet a pu être démonté avant que l'écoute soit établie (React rejoue
      // les effets) : on relâche alors immédiatement pour ne pas fuir.
      if (cancelled) off();
      else unlistenNudge = off;
    });

    void (async () => {
      try {
        const result = await runDeviceSignIn({
          label: "Mira Desktop",
          signal: controller.signal,
          nudge,
          onStarted: async (f: DeviceStart) => {
            if (cancelled) return;
            setFlow(f);
            // Ouvre la page de vérification dans le navigateur de l'utilisateur.
            // En cas d'échec (pas de navigateur), on bascule sur le code manuel.
            try {
              await openUrl(f.verificationUriComplete);
            } catch {
              if (!cancelled) setBrowserFailed(true);
            }
          },
        });
        if (cancelled) return;
        if (result.outcome === "approved") {
          // Le sélecteur de modèles doit refléter le catalogue sans rechargement.
          emitCustomModelsChanged();
          setDone(true);
          // Succès : on referme aussitôt pour rendre la main à l'app (la fenêtre
          // a déjà été ramenée au premier plan par `runDeviceSignIn`).
          onCloseRef.current();
        } else if (result.outcome === "denied") {
          setError("Sign-in was denied.");
        } else if (result.outcome === "expired") {
          setError("The code expired. Please try again.");
        }
        // « cancelled » : l'effet a été démonté, rien à afficher.
      } catch (e) {
        if (!cancelled) setError(normalize(e));
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      unlistenNudge?.();
    };
  }, []);

  const handleClose = useCallback(() => {
    abortRef.current?.abort();
    onClose();
  }, [onClose]);

  const retryBrowser = useCallback(() => {
    if (!flow) return;
    void openUrl(flow.verificationUriComplete).catch(() => setBrowserFailed(true));
  }, [flow]);

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
          ) : flow ? (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "var(--origin-fg-muted)", marginBottom: "10px" }}>
                <Icon icon="lucide:loader-circle" width={14} className="animate-spin" />
                <span>
                  {browserFailed
                    ? "Your browser did not open."
                    : "Waiting for you to confirm in your browser…"}
                </span>
              </div>
              <div style={{ color: "var(--origin-fg-subtle)", fontSize: "11px", marginBottom: "10px" }}>
                This window updates automatically.
              </div>

              <button
                onClick={retryBrowser}
                style={{
                  padding: "5px 10px", borderRadius: "6px", fontSize: "12px",
                  cursor: "pointer", width: "100%",
                  border: "1px solid var(--origin-border-default)",
                  background: "transparent", color: "var(--origin-fg-default)",
                }}
              >
                {browserFailed ? "Open the sign-in page" : "Open browser again"}
              </button>
            </>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "var(--origin-fg-muted)" }}>
              <Icon icon="lucide:loader-circle" width={14} className="animate-spin" />
              Starting sign-in…
            </div>
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
