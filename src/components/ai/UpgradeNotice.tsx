import { useState } from "react";
import { Sparkles, ArrowUpRight } from "lucide-react";
import { openUpgradePage } from "../../lib/agent/account";

// ── Carte « offre supérieure » ─────────────────────────────────────────────────
//
// Affichée dans le fil quand le tour a échoué faute de crédit côté Orvyx (402
// `insufficient_credits`). Chaque plan dispose d'un budget MENSUEL (le plan
// gratuit : 1 USD/mois). Deux situations mènent ici : soit le budget du mois est
// épuisé, soit la requête demande plus de crédit que le plafond du plan n'en
// autorise d'un coup. Dans les deux cas, la bonne action n'est pas « réessayer »
// mais « passer à une offre supérieure », d'où ce bouton dédié.
//
// Le message d'erreur brut reste affiché au-dessus : on informe, on ne masque
// rien. Le bouton ouvre la page de tarifs du portail dans le navigateur système.

export default function UpgradeNotice() {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const handleUpgrade = async () => {
    setBusy(true);
    setFailed(false);
    try {
      await openUpgradePage();
    } catch {
      // Ouvrir un lien ne doit jamais casser la conversation : on signale
      // sobrement et l'utilisateur peut réessayer.
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        marginTop: "10px",
        padding: "12px 14px",
        borderRadius: "10px",
        border: "1px solid var(--origin-border-default)",
        background: "var(--origin-bg-sidebar)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "7px", marginBottom: "5px" }}>
        <Sparkles size={14} style={{ flexShrink: 0, color: "var(--origin-accent-default, #7c8cff)" }} />
        <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--origin-fg-default)" }}>
          You've used up this month's plan credit
        </span>
      </div>
      <div style={{ fontSize: "12px", color: "var(--origin-fg-muted)", lineHeight: 1.6, marginBottom: "10px" }}>
        Your plan's monthly credit has run out, so Mira's built-in models can't run
        this request. Upgrade to a higher plan to keep going - or wait for your
        credit to reset next month.
      </div>
      <button
        onClick={handleUpgrade}
        disabled={busy}
        style={{
          display: "inline-flex", alignItems: "center", gap: "6px",
          padding: "5px 12px", borderRadius: "7px", border: "none",
          background: "var(--origin-accent-default, #4f5bd5)", color: "#fff",
          fontSize: "12.5px", fontWeight: 500,
          cursor: busy ? "default" : "pointer", opacity: busy ? 0.7 : 1,
        }}
      >
        {busy ? "Opening…" : "Upgrade plan"}
        {!busy && <ArrowUpRight size={13} style={{ flexShrink: 0 }} />}
      </button>
      {failed && (
        <div style={{ fontSize: "11px", color: "var(--origin-semantic-error, #ef4444)", marginTop: "6px" }}>
          Couldn't open the pricing page. Please try again.
        </div>
      )}
    </div>
  );
}
