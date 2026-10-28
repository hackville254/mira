/**
 * Mira — page RÉGLAGES « About ».
 *
 * RÔLE
 * ----
 * Afficher l'identité de l'application : nom, version installée, état de mise à
 * jour, et liens utiles (documentation, signalement de bug).
 *
 * SOURCE DE LA VERSION
 * --------------------
 * On lit la version depuis le bundle Tauri (`@tauri-apps/api/app`), PAS depuis
 * `package.json` : c'est la seule source qui reflète EXACTEMENT le binaire
 * installé (utant un build de dev qu'un paquet signé). En cas d'échec (WebView
 * hors Tauri), on affiche un repli au lieu de casser la page.
 */

import { useEffect, useState } from "react";
import { getVersion, getName } from "@tauri-apps/api/app";
import { check as checkForUpdate } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { ExternalLink, RefreshCw, Check } from "lucide-react";
import { Button, sectionCard } from "./ui";
import { getDistributionChannel } from "../../lib/distribution";
import logoSrc from "../../assets/logo-code.svg";

type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "uptodate" }
  | { kind: "available"; version: string; install: () => Promise<void> }
  | { kind: "error"; message: string };

const LINKS: Array<{ label: string; url: string; hint: string }> = [
  { label: "Documentation", url: "https://docs.trae.ai", hint: "Guides and reference" },
  { label: "Report an issue", url: "https://github.com/Origin-AI-IDE/origin/issues", hint: "Open a ticket" },
];

export default function AboutSection() {
  const [version, setVersion] = useState<string | null>(null);
  const [name, setName] = useState<string>("Mira");
  const [update, setUpdate] = useState<UpdateState>({ kind: "idle" });
  const [storeManaged, setStoreManaged] = useState(false);

  useEffect(() => {
    getVersion().then(setVersion).catch(() => setVersion(null));
    getName().then(n => { if (n) setName(n); }).catch(() => { /* repli sur « Mira » */ });
    // Si l'app vient du Microsoft Store, c'est le Store qui gère les mises à
    // jour : on masque le bouton manuel (les appels updater échoueraient).
    getDistributionChannel()
      .then(ch => setStoreManaged(ch === "microsoft_store"))
      .catch(() => { /* repli direct */ });
  }, []);

  async function runCheck() {
    setUpdate({ kind: "checking" });
    try {
      const found = await checkForUpdate();
      if (!found) {
        setUpdate({ kind: "uptodate" });
        return;
      }
      setUpdate({
        kind: "available",
        version: found.version,
        install: async () => {
          await found.downloadAndInstall();
          await relaunch();
        },
      });
    } catch (e) {
      setUpdate({ kind: "error", message: normalize(e) });
    }
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 22 }}>
        <div style={{
          width: 56, height: 56, borderRadius: 12, flexShrink: 0,
          display: "flex", alignItems: "center", justifyContent: "center",
          background: "var(--origin-bg-base)",
          border: "1px solid var(--origin-border-default)",
          overflow: "hidden",
        }}>
          <img
            src={logoSrc}
            alt={name}
            style={{ width: 40, height: 40, objectFit: "contain" }}
          />
        </div>
        <div>
          <div style={{ fontSize: 22, fontWeight: 600, color: "var(--origin-fg-default)" }}>{name}</div>
          <div style={{ fontSize: 12.5, color: "var(--origin-fg-muted)", marginTop: 3 }}>
            {version ? `Version ${version}` : "Unknown version"}
          </div>
        </div>
      </div>

      <div style={sectionCard}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, color: "var(--origin-fg-default)" }}>Updates</div>
            <div style={{ fontSize: 11.5, color: "var(--origin-fg-muted)", marginTop: 3 }}>
              {storeManaged
                ? "Updates are managed by the Microsoft Store."
                : update.kind === "checking" ? "Checking…"
                : update.kind === "uptodate" ? "You're on the latest version."
                : update.kind === "available" ? `Version ${update.version} available.`
                : update.kind === "error" ? update.message
                : "Check if a new version is available."}
            </div>
          </div>
          {storeManaged ? (
            <span style={{ fontSize: 11.5, color: "var(--origin-fg-subtle)" }}>via Microsoft Store</span>
          ) : update.kind === "available" ? (
            <Button variant="primary" onClick={() => void update.install()}>Install and restart</Button>
          ) : update.kind === "uptodate" ? (
            <span style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: "var(--origin-semantic-success, #2ea043)" }}>
              <Check size={14} /> Up to date
            </span>
          ) : (
            <Button onClick={() => void runCheck()} disabled={update.kind === "checking"}>
              <RefreshCw size={13} /> Check
            </Button>
          )}
        </div>
      </div>

      <div style={sectionCard}>
        <div style={{ fontSize: 13, color: "var(--origin-fg-default)", marginBottom: 10 }}>Links</div>
        {LINKS.map(link => (
          <a
            key={link.url}
            href={link.url}
            target="_blank"
            rel="noreferrer noopener"
            style={{
              display: "flex", alignItems: "center", gap: 8,
              padding: "8px 10px", borderRadius: 6, textDecoration: "none",
              color: "var(--origin-fg-default)", fontSize: 12.5,
            }}
            onMouseEnter={e => { e.currentTarget.style.backgroundColor = "var(--origin-bg-hover)"; }}
            onMouseLeave={e => { e.currentTarget.style.backgroundColor = "transparent"; }}
          >
            <ExternalLink size={13} style={{ opacity: 0.6 }} />
            <span style={{ flex: 1 }}>{link.label}</span>
            <span style={{ fontSize: 11, color: "var(--origin-fg-subtle)" }}>{link.hint}</span>
          </a>
        ))}
      </div>

      <div style={{ fontSize: 11.5, color: "var(--origin-fg-subtle)", lineHeight: 1.6, marginTop: 4 }}>
        An open-source desktop IDE. Built with Tauri and React.
      </div>
    </div>
  );
}

function normalize(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return "Couldn't check for updates.";
}
