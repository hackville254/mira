import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useAgentTerminal } from "../../lib/agent/agentTerminalStore";
import { useTheme } from "../../themes/ThemeContext";

// ── Terminal de l'agent (miroir LECTURE SEULE) ────────────────────────────────
//
// Affiche, dans un vrai xterm, le transcript accumulé par `agentTerminalStore`
// pour la session d'agent courante (mode IA / IDE). Parité SOLO : l'utilisateur
// VOIT exactement ce que l'agent exécute — commande + sortie en direct.
//
// LECTURE SEULE STRICT (décision produit) :
//   - `disableStdin: true` → xterm n'émet AUCUN événement clavier (onData muet) ;
//   - aucune écriture PTY n'est câblée ici (pas de `terminalWrite`) ;
//   - ce composant n'a même pas accès aux identifiants PTY.
// Le clavier est donc neutralisé à la source, pas seulement masqué.

interface Props {
  /** Session d'agent dont on affiche le terminal. */
  sessionId: string;
  /** Onglet visible ? (pilote le re-fit à l'activation). */
  active: boolean;
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function buildTheme() {
  return {
    background:          cssVar("--origin-bg-panel"),
    foreground:          cssVar("--origin-terminal-fg"),
    cursor:              cssVar("--origin-terminal-fg"),
    cursorAccent:        cssVar("--origin-bg-panel"),
    selectionBackground: cssVar("--origin-terminal-selection"),
    black:               cssVar("--origin-terminal-black"),
    red:                 cssVar("--origin-terminal-red"),
    green:               cssVar("--origin-terminal-green"),
    yellow:              cssVar("--origin-terminal-yellow"),
    blue:                cssVar("--origin-terminal-blue"),
    magenta:             cssVar("--origin-terminal-purple"),
    cyan:                cssVar("--origin-terminal-cyan"),
    white:               cssVar("--origin-terminal-white"),
    brightBlack:         cssVar("--origin-terminal-brightBlack"),
    brightRed:           cssVar("--origin-terminal-brightRed"),
    brightGreen:         cssVar("--origin-terminal-brightGreen"),
    brightYellow:        cssVar("--origin-terminal-brightYellow"),
    brightBlue:          cssVar("--origin-terminal-brightBlue"),
    brightMagenta:       cssVar("--origin-terminal-brightPurple"),
    brightCyan:          cssVar("--origin-terminal-brightCyan"),
    brightWhite:         cssVar("--origin-terminal-brightWhite"),
  };
}

export default function AgentTerminalView({ sessionId, active }: Props) {
  const { theme } = useTheme();
  const { transcript } = useAgentTerminal(sessionId);
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef     = useRef<XTerm | null>(null);
  const fitAddonRef  = useRef<FitAddon | null>(null);
  // Position déjà écrite dans le xterm : on n'écrit que le DELTA à chaque mise à
  // jour du store (le transcript est append-only, sauf troncature → reset).
  const writtenRef   = useRef(0);

  // Création de l'instance xterm (une seule fois).
  useEffect(() => {
    if (!containerRef.current) return;
    const xterm = new XTerm({
      fontFamily: "GeistMono, 'Cascadia Code', 'Fira Code', Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.2,
      theme: buildTheme(),
      cursorBlink: false,
      // LECTURE SEULE : aucune saisie clavier n'est acceptée par le terminal.
      disableStdin: true,
      scrollback: 5000,
    });
    xtermRef.current = xterm;
    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    xterm.loadAddon(fitAddon);
    xterm.open(containerRef.current);
    fitAddon.fit();

    const observer = new ResizeObserver(() => {
      if (!containerRef.current || containerRef.current.offsetWidth === 0 || containerRef.current.offsetHeight === 0) return;
      fitAddon.fit();
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      fitAddonRef.current = null;
      xtermRef.current = null;
      try { xterm.dispose(); } catch { /* ignore double-dispose */ }
    };
  }, []);

  // Re-thème au changement de thème IDE.
  useEffect(() => {
    if (xtermRef.current) xtermRef.current.options.theme = buildTheme();
  }, [theme]);

  // Écrit le DELTA du transcript. Une troncature (transcript plus court que ce
  // qu'on a déjà écrit) déclenche un reset propre du buffer.
  useEffect(() => {
    const xterm = xtermRef.current;
    if (!xterm) return;
    if (transcript.length < writtenRef.current) {
      xterm.reset();
      writtenRef.current = 0;
    }
    if (transcript.length > writtenRef.current) {
      xterm.write(transcript.slice(writtenRef.current));
      writtenRef.current = transcript.length;
    }
  }, [transcript]);

  // Re-fit à l'activation (les dimensions peuvent avoir changé onglet masqué).
  useEffect(() => {
    if (!active || !fitAddonRef.current) return;
    requestAnimationFrame(() => { fitAddonRef.current?.fit(); });
  }, [active]);

  return (
    <div style={{ width: "100%", height: "100%", padding: "8px 12px", boxSizing: "border-box", overflow: "hidden" }}>
      {/* Bandeau : rappelle la nature lecture seule du panneau. */}
      <div style={{
        display: "flex", alignItems: "center", gap: 6, marginBottom: 6,
        fontSize: 11, color: "var(--origin-fg-subtle)", fontFamily: "var(--font-mono)",
      }}>
        <img src="/logo-code.svg" width={12} height={12} alt="" />
        <span>Agent terminal</span>
        <span style={{
          padding: "0 5px", borderRadius: 3, fontSize: 10,
          border: "1px solid var(--origin-border-subtle)", color: "var(--origin-fg-muted)",
        }}>lecture seule</span>
      </div>
      <div ref={containerRef} style={{ width: "100%", height: "calc(100% - 24px)", overflow: "hidden" }} />
    </div>
  );
}
