import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Sparkles } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import {
  terminalCreate,
  terminalCreateTask,
  terminalWrite,
  terminalResize,
  terminalClose,
  onTerminalOutput,
  onTerminalExit,
} from "../../lib/terminal";
import { useTheme } from "../../themes/ThemeContext";
import { appendOutput, appendOutputSystem, startOutputChannel } from "../../lib/outputStore";

interface Props {
  cwd: string;
  active: boolean;
  clearKey?: number;
  pendingInput?: string;
  /**
   * Texte à INJECTER dans le PTY sans l'exécuter : la commande apparaît sur la
   * ligne courante, l'utilisateur garde le dernier mot (il peut l'éditer puis
   * valider avec Entrée). Distinct de `pendingInput`, qui envoie un `\r`.
   * `nonce` change à chaque demande : le texte peut être identique d'une fois à
   * l'autre, c'est le nonce qui déclenche la réinjection.
   */
  insertRequest?: { text: string; nonce: number };
  /** Lancement d'une tâche « Run » : spawn direct (argv), sans shell interactif. */
  task?: { program: string; args: string[] } | null;
  onCwdChange?: (cwd: string) => void;
  onShellState?: (state: 'idle' | 'running', exitCode?: number) => void;
  /**
   * Envoi de la SÉLECTION du terminal vers l'input du chat (« Add to AI »).
   * Fourni par le parent : le terminal ne connaît pas le chat, il se contente de
   * remonter le texte sélectionné. Absent → pas de bouton flottant.
   */
  onAddSelectionToAi?: (text: string) => void;
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

export default function Terminal({ cwd, active, clearKey, pendingInput, insertRequest, task, onCwdChange, onShellState, onAddSelectionToAi }: Props) {
  const { theme } = useTheme();
  const containerRef    = useRef<HTMLDivElement>(null);
  const xtermRef        = useRef<XTerm | null>(null);
  const cwdRef          = useRef(cwd);
  const termIdRef       = useRef<number | null>(null);
  const fitAddonRef     = useRef<FitAddon | null>(null);
  const onCwdChangeRef  = useRef(onCwdChange);
  const onShellStateRef = useRef(onShellState);
  const onAddSelectionRef = useRef(onAddSelectionToAi);
  // eslint-disable-next-line react-hooks/refs
  onCwdChangeRef.current  = onCwdChange;
  // eslint-disable-next-line react-hooks/refs
  onShellStateRef.current = onShellState;
  // eslint-disable-next-line react-hooks/refs
  onAddSelectionRef.current = onAddSelectionToAi;

  // Bouton flottant « Add to AI » affiché en haut à DROITE du terminal dès
  // qu'une sélection existe. On ne le positionne PAS au-dessus de la sélection :
  // il recouvrirait la ligne de texte précédente (rendu non professionnel). Une
  // barre d'action ancrée au bord droit ne masque jamais le contenu.
  const [hasSelection, setHasSelection] = useState(false);

  useEffect(() => {
    if (!clearKey) return;
    xtermRef.current?.clear();
  }, [clearKey]);

  // Insertion sans exécution : on écrit le texte tel quel dans le PTY (sans `\r`).
  // Déclenché par le `nonce` (et non par le texte), sinon deux insertions
  // successives du MÊME bloc ne produiraient qu'un seul effet.
  const lastInsertNonceRef = useRef(0);
  useEffect(() => {
    if (!insertRequest) return;
    if (insertRequest.nonce === lastInsertNonceRef.current) return;
    lastInsertNonceRef.current = insertRequest.nonce;
    if (termIdRef.current !== null) {
      terminalWrite(termIdRef.current, insertRequest.text).catch(() => { /* terminal fermé */ });
    }
  }, [insertRequest]);

  // Create the xterm instance once on mount
  useEffect(() => {
    if (!containerRef.current) return;

    const xterm = new XTerm({
      fontFamily: "GeistMono, 'Cascadia Code', 'Fira Code', Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.2,
      theme: buildTheme(),
      cursorBlink: true,
      scrollback: 5000,
    });

    xtermRef.current = xterm;
    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    xterm.loadAddon(fitAddon);
    xterm.open(containerRef.current);

    // WebGL renderer — falls back to canvas silently if the GPU context is unavailable.
    // Do NOT dispose the addon on context loss: xterm owns the addon lifecycle and will
    // dispose it when xterm.dispose() is called. Disposing it manually here causes a
    // double-dispose crash because xterm's AddonManager still holds a reference.
    try {
      const webglAddon = new WebglAddon();
      // On context loss, xterm's AddonManager handles addon disposal; nothing to do here.
      webglAddon.onContextLoss(() => {});
      xterm.loadAddon(webglAddon);
    } catch {
      // GPU context unavailable — xterm falls back to the canvas renderer silently.
    }

    fitAddon.fit();

    // Ctrl+Shift+C → copy selection; Ctrl+Shift+V → paste from clipboard.
    // Both keys must be fully intercepted (return false) so they never reach the PTY.
    xterm.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'C') {
        if (e.type === 'keydown') {
          const sel = xterm.getSelection();
          if (sel) navigator.clipboard.writeText(sel).catch(() => {});
        }
        return false;
      }
      if (e.ctrlKey && e.shiftKey && e.key === 'V') {
        if (e.type === 'keydown') {
          navigator.clipboard.readText().then(text => {
            if (text && termIdRef.current !== null) {
              terminalWrite(termIdRef.current, text).catch(() => {});
            }
          }).catch(() => {});
        }
        return false;
      }
      return true;
    });

    // OSC 7 — shell reports current working directory
    const oscDisp7 = xterm.parser.registerOscHandler(7, (data: string) => {
      try {
        const url = new URL(data);
        let path = decodeURIComponent(url.pathname);
        // Windows: /C:/path → C:\path
        if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1).replace(/\//g, '\\');
        onCwdChangeRef.current?.(path);
      } catch {
        onCwdChangeRef.current?.(data);
      }
      return true;
    });

    // OSC 133 — shell integration markers (prompt start / command running / done + exit code)
    const oscDisp133 = xterm.parser.registerOscHandler(133, (data: string) => {
      if (data === 'A' || data === 'B') {
        onShellStateRef.current?.('idle');
      } else if (data === 'C') {
        onShellStateRef.current?.('running');
      } else {
        const parts = data.split(';');
        if (parts[0] === 'D') {
          const code = parts[1] !== undefined ? parseInt(parts[1], 10) : 0;
          onShellStateRef.current?.('idle', isNaN(code) ? 0 : code);
        }
      }
      return true;
    });

    const dims = fitAddon.proposeDimensions();
    const cols = dims?.cols ?? 80;
    const rows = dims?.rows ?? 24;

    let cleanupOutput: (() => void) | null = null;
    let cleanupExit: (() => void) | null = null;

    // Mode tâche « Run » : on spawn le programme directement (argv), sans shell.
    // On ne crée PAS de shell interactif ici.
    if (task) {
      const channel = `${task.program} ${task.args.join(' ')}`;
      startOutputChannel(channel, `$ ${channel}`);
      xterm.write(`\x1b[90m$ ${task.program} ${task.args.join(' ')}\x1b[0m\r\n`);
      terminalCreateTask(cwdRef.current, task.program, task.args, cols, rows)
        .then(async (id) => {
          termIdRef.current = id;
          cleanupOutput = await onTerminalOutput(id, (data) => {
            xterm.write(data);
            appendOutput(channel, data);
          });
          cleanupExit = await onTerminalExit(id, () => {
            xterm.write("\r\n\x1b[90m[process exited]\x1b[0m\r\n");
            appendOutputSystem(channel, '[process exited]');
          });
        })
        .catch((err: unknown) => {
          xterm.write(`\r\n\x1b[31mFailed to run task: ${String(err)}\x1b[0m\r\n`);
          appendOutput(channel, `Failed to run task: ${String(err)}`, 'stderr');
        });
    } else {
      terminalCreate(cwdRef.current, cols, rows)
        .then(async (id) => {
          termIdRef.current = id;
          cleanupOutput = await onTerminalOutput(id, (data) => xterm.write(data));
          cleanupExit = await onTerminalExit(id, () => {
            xterm.write("\r\n\x1b[90m[process exited]\x1b[0m\r\n");
          });
          // pendingInput is captured from props at mount time (effect deps are intentionally [])
          if (pendingInput) {
            terminalWrite(id, pendingInput + '\r').catch(() => {});
          }
        })
        .catch((err: unknown) => {
          xterm.write(`\r\n\x1b[31mFailed to start terminal: ${String(err)}\x1b[0m\r\n`);
        });
    }

    const dataDisposable = xterm.onData((data: string) => {
      if (termIdRef.current !== null) {
        terminalWrite(termIdRef.current, data).catch(() => {});
      }
    });

    // Suivi de la sélection : on affiche/masque la barre « Add to AI ». Un simple
    // booléen suffit — le bouton est ancré au bord droit, pas collé au texte.
    const selectionDisposable = xterm.onSelectionChange(() => {
      const sel = xterm.getSelection();
      setHasSelection(!!sel && !!sel.trim());
    });

    const observer = new ResizeObserver(() => {
      // Skip when hidden (display:none collapses dimensions to 0 — fitting at 0 truncates the scrollback buffer)
      if (!containerRef.current || containerRef.current.offsetWidth === 0 || containerRef.current.offsetHeight === 0) return;
      fitAddon.fit();
      const d = fitAddon.proposeDimensions();
      if (termIdRef.current !== null && d) {
        terminalResize(termIdRef.current, d.cols, d.rows).catch(() => {});
      }
    });
    observer.observe(containerRef.current);

    return () => {
      oscDisp7.dispose();
      oscDisp133.dispose();
      cleanupOutput?.();
      cleanupExit?.();
      dataDisposable.dispose();
      selectionDisposable.dispose();
      observer.disconnect();
      if (termIdRef.current !== null) {
        terminalClose(termIdRef.current).catch(() => {});
        termIdRef.current = null;
      }
      fitAddonRef.current = null;
      xtermRef.current = null;
      // xterm.dispose() triggers AddonManager disposal for all loaded addons (including
      // WebGL). If the GPU context was already lost the addon internals may be partially
      // torn down, so guard against the resulting crash here.
      try { xterm.dispose(); } catch { /* ignore addon double-dispose on context loss */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- terminal lifecycle is independent of React renders; pendingInput is intentionally captured at mount
  }, []);

  // Re-theme XTerm whenever the IDE theme changes
  useEffect(() => {
    if (xtermRef.current) {
      xtermRef.current.options.theme = buildTheme();
    }
  }, [theme]);

  // Re-fit when this tab becomes active (dimensions may have changed while hidden)
  useEffect(() => {
    if (!active || !fitAddonRef.current) return;
    requestAnimationFrame(() => {
      if (!fitAddonRef.current) return;
      fitAddonRef.current.fit();
      const d = fitAddonRef.current.proposeDimensions();
      if (termIdRef.current !== null && d) {
        terminalResize(termIdRef.current, d.cols, d.rows).catch(() => {});
      }
    });
  }, [active]);

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        padding: "8px 12px",
        boxSizing: "border-box",
        overflow: "hidden",
      }}
    >
      <div ref={containerRef} style={{ width: "100%", height: "100%", overflow: "hidden" }} />
      {/* Barre « Add to AI » — ancrée en HAUT À DROITE, jamais sur le texte.
          `onMouseDown` + `preventDefault` : on lit la sélection AVANT que le clic
          ne la vide (sinon `getSelection()` serait déjà vide au moment de l'envoi). */}
      {hasSelection && onAddSelectionToAi && (
        <button
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            const sel = xtermRef.current?.getSelection();
            if (sel && sel.trim()) onAddSelectionRef.current?.(sel);
            setHasSelection(false);
            xtermRef.current?.clearSelection();
          }}
          title="Add terminal selection to AI"
          style={{
            position: "absolute",
            top: 8,
            right: 14,
            zIndex: 10,
            display: "flex",
            alignItems: "center",
            gap: 5,
            height: 24,
            padding: "0 10px",
            borderRadius: 6,
            border: "1px solid var(--origin-border-default)",
            background: "var(--origin-bg-elevated, var(--origin-bg-panel))",
            color: "var(--origin-fg-default)",
            fontSize: 11.5,
            fontFamily: "var(--font-mono)",
            cursor: "pointer",
            boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
          }}
        >
          <Sparkles size={12} style={{ color: "var(--origin-accent-blue, #4a9eff)" }} />
          Add to AI
        </button>
      )}
    </div>
  );
}
