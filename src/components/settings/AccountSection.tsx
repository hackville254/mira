/**
 * Mira — page RÉGLAGES « Account ».
 *
 * RÔLE
 * ----
 * Connecter le poste au compte Mira (device flow OAuth 2.0), puis synchroniser
 * ce que Mira fournit : la clé Orvyx du compte et le catalogue de modèles.
 *
 * POURQUOI UN DEVICE FLOW
 * -----------------------
 * Le poste n'a pas de navigateur embarqué fiable ni de redirection locale
 * exploitable : le device flow est le standard (RFC 8628) pour un client
 * desktop. L'utilisateur ouvre une page dans SON navigateur, saisit un code
 * court, et le poste récupère les jetons par polling.
 *
 * SÉCURITÉ
 * --------
 * Ce composant ne voit JAMAIS le token d'accès ni la clé Orvyx : les deux
 * restent côté Rust (`cloud.rs` + keychain OS). Il n'affiche que des
 * métadonnées non sensibles (code utilisateur, empreinte de clé, budget).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { LogIn, LogOut, RefreshCw, ShieldCheck } from "lucide-react";
import { PageHeader, Button, Badge, EmptyState, ErrorLine } from "./ui";
import {
  runDeviceSignIn,
  provisionKey,
  syncModels,
  signOut,
  isSignedIn,
  loadAccount,
  type CloudAccount,
  type DeviceStart,
} from "../../lib/agent/account";
import { emitCustomModelsChanged } from "../../lib/agent/customModels";

function normalize(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return "Something went wrong";
}

export default function AccountSection() {
  const [signedIn, setSignedIn] = useState(false);
  const [account, setAccount] = useState<CloudAccount | null>(() => loadAccount());
  const [flow, setFlow] = useState<DeviceStart | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // État initial : une session cloud est-elle active côté Rust ?
  useEffect(() => {
    let alive = true;
    isSignedIn()
      .then(v => { if (alive) setSignedIn(v); })
      .catch(() => { /* hors Tauri : on reste déconnecté */ });
    return () => { alive = false; };
  }, []);

  // Annule une éventuelle boucle de polling au démontage.
  useEffect(() => () => abortRef.current?.abort(), []);

  const handleSignIn = useCallback(async () => {
    setError(null);
    setBusy(true);
    abortRef.current = new AbortController();
    try {
      const result = await runDeviceSignIn({
        label: "Mira Desktop",
        signal: abortRef.current.signal,
        onStarted: async (started) => {
          setFlow(started);
          // Ouvre la page de vérification dans le navigateur de l'utilisateur.
          await openUrl(started.verificationUriComplete).catch(() => { /* repli : le code reste affiché */ });
        },
      });
      setFlow(null);
      if (result === "approved") {
        setAccount(loadAccount());
        // Le sélecteur de modèles doit voir arriver le catalogue sans rechargement.
        emitCustomModelsChanged();
        setSignedIn(true);
      } else if (result === "denied") {
        setError("Sign-in was denied.");
      } else if (result === "expired") {
        setError("The code expired. Please try again.");
      }
    } catch (e) {
      setError(normalize(e));
    } finally {
      setBusy(false);
      abortRef.current = null;
      setFlow(null);
    }
  }, []);

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const handleSignOut = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await signOut();
      setSignedIn(false);
      setAccount(null);
    } catch (e) {
      setError(normalize(e));
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <div>
      <PageHeader
        title="Account"
        description="Sign in to Mira to use the built-in models included with your plan."
      />

      {error && <ErrorLine message={error} />}

      {signedIn ? (
        <div>
          <div style={{
            display: "flex", alignItems: "center", gap: 12,
            border: "1px solid var(--origin-border-default)", borderRadius: 8,
            padding: "14px 16px", marginBottom: 12,
            backgroundColor: "var(--origin-bg-sidebar)",
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 13.5, fontWeight: 500, color: "var(--origin-fg-default)" }}>
                  {account?.email ?? "Signed in"}
                </span>
                {account?.plan && <Badge tone="accent">{account.plan}</Badge>}
              </div>
              {account?.maskedHint && (
                <div style={{ fontSize: 11.5, color: "var(--origin-fg-muted)", marginTop: 3 }}>
                  Key {account.maskedHint}
                  {typeof account.budgetUsd === "number" ? ` · $${account.budgetUsd} budget` : ""}
                </div>
              )}
            </div>
            <Button variant="secondary" onClick={handleSignOut} disabled={busy}>
              <LogOut size={13} /> Sign out
            </Button>
          </div>

          <Button
            variant="secondary"
            small
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const acc = await provisionKey();
                setAccount(acc);
                await syncModels();
                emitCustomModelsChanged();
              } catch (e) {
                setError(normalize(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            <RefreshCw size={12} /> Refresh models
          </Button>
        </div>
      ) : flow ? (
        <div style={cardStyle}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
            <ShieldCheck size={14} style={{ color: "var(--origin-semantic-success, #2ea043)" }} />
            <span style={{ fontSize: 13, color: "var(--origin-fg-default)" }}>
              Finish signing in your browser
            </span>
          </div>
          <div style={{ fontSize: 12, color: "var(--origin-fg-muted)", marginBottom: 10 }}>
            Enter this code on the page that just opened:
          </div>
          <div style={{
            fontFamily: "var(--font-mono)", fontSize: 22, letterSpacing: "0.18em",
            color: "var(--origin-fg-default)", padding: "8px 0", userSelect: "all",
          }}>
            {flow.userCode}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
            <Button variant="secondary" small onClick={() => openUrl(flow.verificationUriComplete).catch(() => { /* repli */ })}>
              Open browser again
            </Button>
            <Button variant="secondary" small onClick={handleCancel}>Cancel</Button>
          </div>
        </div>
      ) : (
        <EmptyState
          title="Not signed in"
          hint="Sign in to unlock Mira's built-in models. You can also add your own models under Settings → Models."
          action={
            <Button variant="primary" onClick={handleSignIn} disabled={busy}>
              <LogIn size={13} /> {busy ? "Waiting for approval…" : "Sign in to Mira"}
            </Button>
          }
        />
      )}
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  border: "1px solid var(--origin-border-default)",
  borderRadius: 8,
  padding: "14px 16px",
  backgroundColor: "var(--origin-bg-sidebar)",
};
