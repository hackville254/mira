import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useState, type ReactNode } from "react";
import { Check, Copy, Terminal, TerminalSquare, Play, FolderOpen } from "lucide-react";
import type { Components } from "react-markdown";
import { sanitizeProse } from "../../lib/textStyle";
import { routeMarkdownLink } from "../../lib/ai/linkRouting";
import { openPreviewAt } from "../../lib/ai/previewBus";
import { openUrl } from "@tauri-apps/plugin-opener";
import { looksLikePath, guessPathKind } from "../../lib/ai/pathDetection";

/** Style commun d'un chemin cliquable dans le corps du message. */
const pathStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "12px",
  color: "var(--origin-accent-blue)",
  textDecoration: "underline",
  textDecorationColor: "var(--origin-border-default)",
  textUnderlineOffset: "2px",
  cursor: "pointer",
};

/**
 * Handler de clic sur un lien d'un message de l'agent.
 *
 * Sans cela, un `<a href>` nu laissait la webview Tauri principale naviguer vers
 * le site : l'application entière se retrouvait noyée dans la page, sans retour.
 * On route désormais vers le panneau intégré (http/https) ou le navigateur
 * système (mailto/tel) ; tout autre schéma est ignoré (cf. `routeMarkdownLink`,
 * barrière contre `javascript:`/`data:`).
 */
function handleLinkClick(href: string | undefined) {
  return (e: React.MouseEvent) => {
    const routing = routeMarkdownLink(href);
    if (routing.action === "none") {
      // Ancre interne ou schéma refusé : on empêche la navigation par défaut
      // (qui noierait l'app) sans rien ouvrir.
      e.preventDefault();
      return;
    }
    e.preventDefault();
    if (routing.action === "preview") {
      openPreviewAt(routing.url);
    } else {
      void openUrl(routing.url).catch(() => { /* ouverture externe indisponible */ });
    }
  };
}

interface Props {
  content: string;
  isStreaming?: boolean;
  /**
   * Ouvre un chemin cité par l'agent (texte brut, code inline ou lien).
   * L'appelant décide quoi en faire : fichier → éditeur, dossier → révélé dans
   * l'explorateur. Aucun chemin n'est ouvert sans passer par lui, donc aucune
   * ouverture arbitraire : l'existence est vérifiée côté appelant.
   */
  onOpenPath?: (path: string) => void;
  /**
   * Exécute une commande dans un terminal (bouton `Run` d'un bloc shell).
   * Absent = pas de bouton `Run` (ex. aperçu Markdown d'un fichier).
   */
  onRunCommand?: (command: string) => void;
  /**
   * Insère un texte dans le terminal actif sans l'exécuter (bouton dédié d'un
   * bloc shell). Absent = pas de bouton d'insertion.
   */
  onInsertTerminal?: (text: string) => void;
}

/** Rend un token « chemin » sous forme de bouton texte, ou null si ce n'en est pas un. */
function maybePathNode(
  text: string,
  onOpenPath: ((path: string) => void) | undefined,
  key: React.Key,
): ReactNode | null {
  if (!onOpenPath) return null;
  if (!looksLikePath(text)) return null;
  const kind = guessPathKind(text);
  return (
    <span
      key={key}
      role="button"
      tabIndex={0}
      title={kind === "dir" ? `Reveal ${text}` : `Open ${text}`}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onOpenPath(text); }}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpenPath(text); } }}
      style={pathStyle}
    >
      {kind === "dir" ? <FolderOpen size={11} style={{ verticalAlign: "-1px", marginRight: 3 }} /> : null}
      {text}
    </span>
  );
}

/**
 * Découpe une chaîne de prose en fragments : les chemins deviennent cliquables,
 * le reste demeure du texte. On ne touche jamais aux espaces (on conserve le
 * texte tel quel entre les chemins) pour ne pas altérer la mise en page.
 */
function linkifyText(
  text: string,
  onOpenPath: ((path: string) => void) | undefined,
  keyPrefix: string,
): ReactNode {
  if (!onOpenPath || !text) return text;
  // Découpe en conservant les délimiteurs (espaces, ponctuation d'encadrement).
  const parts = text.split(/(\s+)/);
  return parts.map((part, i) => {
    if (!part || /^\s+$/.test(part)) return part;
    // Retire la ponctuation terminale potentielle (point, virgule…) avant test.
    const m = /^(.*?)([.,;:!?)»"']*)$/.exec(part);
    if (!m) return part;
    const [, core, trail] = m;
    if (!core || !looksLikePath(core)) return part;
    const node = maybePathNode(core, onOpenPath, `${keyPrefix}-p${i}`);
    if (!node) return part;
    return trail
      ? <span key={`${keyPrefix}-w${i}`}>{node}{trail}</span>
      : <span key={`${keyPrefix}-w${i}`}>{node}</span>;
  });
}

/** Parcourt récursivement des enfants React et linkifie les chaînes de texte. */
function linkifyChildren(
  children: ReactNode,
  onOpenPath: ((path: string) => void) | undefined,
  keyPrefix: string,
): ReactNode {
  if (!onOpenPath) return children;
  const walk = (node: ReactNode, key: string): ReactNode => {
    if (typeof node === "string") return linkifyText(node, onOpenPath, key);
    if (Array.isArray(node)) return node.map((n, i) => walk(n, `${key}-${i}`));
    return node;
  };
  return walk(children, keyPrefix);
}

/**
 * Langages « shell » pour lesquels on propose l'action `Run` : ce sont des
 * commandes exécutables, pas un extrait de code à lire. Sans cette liste, un
 * bloc `bash` n'aurait que `Copy`, alors que l'utilisateur veut d'abord
 * l'EXÉCUTER (parité Trae).
 */
const SHELL_LANGS = new Set(["bash", "sh", "shell", "zsh", "console", "terminal"]);

/** Nom affiché du langage : capitalisé, jamais vide. */
function langLabel(language: string): string {
  if (!language) return "Code";
  if (SHELL_LANGS.has(language)) return "Bash";
  return language.charAt(0).toUpperCase() + language.slice(1);
}

/**
 * Bloc de code d'un message de l'agent (parité Trae).
 *
 * Une barre d'en-tête porte l'icône du langage, son nom et les actions utiles :
 * `Copy` toujours ; `Run` (accent) pour les commandes shell, avec au préalable
 * l'insertion dans un terminal visible. Le corps est volontairement sans
 * coloration syntaxique : le contenu est arbitraire (extraits, arborescences,
 * sorties) et un highlighter mal calibré produirait plus de bruit que de signal.
 */
function CodeBlock({
  language,
  code,
  onRun,
  onInsertTerminal,
}: {
  language: string;
  code: string;
  /** Exécute le bloc dans un terminal (blocs shell uniquement). */
  onRun?: (command: string) => void;
  /** Insère le texte dans le terminal actif, sans l'exécuter. */
  onInsertTerminal?: (text: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const isShell = SHELL_LANGS.has(language);

  function handleCopy() {
    void navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div
      style={{
        margin: "10px 0",
        borderRadius: 8,
        overflow: "hidden",
        border: "1px solid var(--origin-border-default)",
        backgroundColor: "var(--origin-bg-editor)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: "4px 6px 4px 10px",
          backgroundColor: "var(--origin-bg-hover)",
          borderBottom: "1px solid var(--origin-border-default)",
          gap: 6,
        }}
      >
        {isShell && (
          <Terminal size={13} style={{ flexShrink: 0, color: "var(--origin-accent-blue)" }} />
        )}
        <span
          style={{
            flex: 1,
            fontSize: "12px",
            fontWeight: 500,
            color: "var(--origin-fg-default)",
            fontFamily: "var(--font-sans)",
            userSelect: "none",
          }}
        >
          {langLabel(language)}
        </span>

        <button
          type="button"
          onClick={handleCopy}
          title="Copy code"
          aria-label="Copy code"
          style={iconBtnStyle}
          onMouseEnter={e => {
            (e.currentTarget as HTMLElement).style.color = "var(--origin-fg-default)";
            (e.currentTarget as HTMLElement).style.backgroundColor = "var(--origin-bg-active)";
          }}
          onMouseLeave={e => {
            (e.currentTarget as HTMLElement).style.color = "var(--origin-fg-muted)";
            (e.currentTarget as HTMLElement).style.backgroundColor = "transparent";
          }}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>

        {onInsertTerminal && (
          <button
            type="button"
            onClick={() => onInsertTerminal(code)}
            title="Insert into terminal"
            aria-label="Insert into terminal"
            style={iconBtnStyle}
            onMouseEnter={e => {
              (e.currentTarget as HTMLElement).style.color = "var(--origin-fg-default)";
              (e.currentTarget as HTMLElement).style.backgroundColor = "var(--origin-bg-active)";
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLElement).style.color = "var(--origin-fg-muted)";
              (e.currentTarget as HTMLElement).style.backgroundColor = "transparent";
            }}
          >
            <TerminalSquare size={12} />
          </button>
        )}

        {isShell && onRun && (
          <button
            type="button"
            onClick={() => onRun(code)}
            title="Run in terminal"
            aria-label="Run in terminal"
            style={runBtnStyle}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.opacity = "0.9"; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.opacity = "1"; }}
          >
            <Play size={11} />
            <span>Run</span>
          </button>
        )}
      </div>

      <pre
        style={{
          margin: 0,
          padding: "10px 14px",
          overflowX: "auto",
          fontSize: "12.5px",
          lineHeight: "1.65",
          fontFamily: "var(--font-mono)",
          color: "var(--origin-fg-default)",
          tabSize: 2,
        }}
      >
        <code>{code}</code>
      </pre>
    </div>
  );
}

const iconBtnStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 4,
  fontSize: "11px",
  color: "var(--origin-fg-muted)",
  background: "transparent",
  border: "none",
  cursor: "pointer",
  padding: "3px 5px",
  borderRadius: 5,
  fontFamily: "var(--font-sans)",
};

/** Bouton `Run` : unique action mise en avant d'un bloc shell. */
const runBtnStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 5,
  fontSize: "11.5px",
  fontWeight: 500,
  color: "var(--origin-fg-default)",
  background: "var(--origin-bg-active)",
  border: "1px solid var(--origin-border-default)",
  cursor: "pointer",
  padding: "3px 10px",
  borderRadius: 6,
  fontFamily: "var(--font-sans)",
};

export default function MarkdownMessage({
  content,
  onOpenPath,
  onRunCommand,
  onInsertTerminal,
}: Props) {
  const components: Components = {
    pre({ children }) {
      return <>{children}</>;
    },

    code({ className, children }) {
      const match = /language-(\w+)/.exec(className || "");
      const text = String(children).replace(/\n$/, "");
      const isBlock = !!match || text.includes("\n");

      if (isBlock) {
        return (
          <CodeBlock
            language={match?.[1] ?? ""}
            code={text}
            onRun={onRunCommand}
            onInsertTerminal={onInsertTerminal}
          />
        );
      }

      // Un code inline qui EST un chemin devient cliquable (l'agent encadre
      // très souvent les chemins de backticks). Le rendu visuel reste celui
      // d'un code inline, on ajoute juste l'affordance.
      const pathNode = maybePathNode(text, onOpenPath, "inline-path");
      if (pathNode) {
        return (
          <code
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "12px",
              backgroundColor: "var(--origin-bg-hover)",
              border: "1px solid var(--origin-border-default)",
              borderRadius: "3px",
              padding: "1px 5px",
            }}
          >
            {pathNode}
          </code>
        );
      }

      return (
        <code
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "12px",
            backgroundColor: "var(--origin-bg-hover)",
            border: "1px solid var(--origin-border-default)",
            borderRadius: "3px",
            padding: "1px 5px",
            color: "var(--origin-fg-default)",
          }}
        >
          {children}
        </code>
      );
    },

    h1: ({ children }) => <h1 style={headingStyle(1)}>{children}</h1>,
    h2: ({ children }) => <h2 style={headingStyle(2)}>{children}</h2>,
    h3: ({ children }) => <h3 style={headingStyle(3)}>{children}</h3>,
    h4: ({ children }) => <h4 style={headingStyle(4)}>{children}</h4>,

    p: ({ children }) => (
      <p style={{ margin: "0 0 10px", lineHeight: 1.7 }}>
        {linkifyChildren(children, onOpenPath, "p")}
      </p>
    ),

    ul: ({ children }) => (
      <ul style={{ margin: "0 0 10px", paddingLeft: 22, lineHeight: 1.7 }}>{children}</ul>
    ),
    ol: ({ children }) => (
      <ol style={{ margin: "0 0 10px", paddingLeft: 22, lineHeight: 1.7 }}>{children}</ol>
    ),
    li: ({ children }) => (
      <li style={{ margin: "3px 0" }}>{linkifyChildren(children, onOpenPath, "li")}</li>
    ),

    strong: ({ children }) => (
      <strong style={{ fontWeight: 600, color: "var(--origin-fg-default)" }}>{children}</strong>
    ),
    em: ({ children }) => (
      <em style={{ fontStyle: "italic", color: "var(--origin-fg-muted)" }}>{children}</em>
    ),

    blockquote: ({ children }) => (
      <blockquote
        style={{
          borderLeft: "3px solid var(--origin-accent-blue)",
          background: "var(--origin-bg-hover)",
          borderRadius: "0 4px 4px 0",
          padding: "6px 12px",
          margin: "10px 0",
          color: "var(--origin-fg-muted)",
        }}
      >
        {children}
      </blockquote>
    ),

    hr: () => (
      <hr
        style={{
          border: "none",
          borderTop: "1px solid var(--origin-border-default)",
          margin: "14px 0",
        }}
      />
    ),

    a: ({ href, children }) => {
      // Un lien dont l'`href` est un chemin local (l'agent écrit parfois
      // `[src/lib/db.ts](src/lib/db.ts)`) n'est pas une URL : on l'ouvre comme
      // un chemin, pas dans le navigateur (routeMarkdownLink le refuserait).
      if (onOpenPath && href && looksLikePath(href)) {
        return (
          <a
            href={href}
            onClick={(e) => { e.preventDefault(); onOpenPath(href); }}
            style={{ color: "var(--origin-accent-blue)", textDecoration: "underline", cursor: "pointer" }}
          >
            {children}
          </a>
        );
      }
      return (
        <a
          href={href}
          onClick={handleLinkClick(href)}
          style={{ color: "var(--origin-accent-blue)", textDecoration: "underline", cursor: "pointer" }}
        >
          {children}
        </a>
      );
    },

    table: ({ children }) => (
      <div style={{ overflowX: "auto", margin: "12px 0" }}>
        <table
          style={{
            borderCollapse: "collapse",
            fontSize: "12.5px",
            width: "100%",
            border: "1px solid var(--origin-border-default)",
            borderRadius: 6,
            overflow: "hidden",
          }}
        >
          {children}
        </table>
      </div>
    ),
    thead: ({ children }) => (
      <thead style={{ backgroundColor: "var(--origin-bg-active)" }}>{children}</thead>
    ),
    th: ({ children }) => (
      <th
        style={{
          borderBottom: "1px solid var(--origin-border-default)",
          borderRight: "1px solid var(--origin-border-default)",
          padding: "7px 12px",
          fontWeight: 600,
          textAlign: "left",
          color: "var(--origin-fg-default)",
          whiteSpace: "nowrap",
        }}
      >
        {children}
      </th>
    ),
    td: ({ children }) => (
      <td
        style={{
          borderBottom: "1px solid var(--origin-border-default)",
          borderRight: "1px solid var(--origin-border-default)",
          padding: "6px 12px",
          verticalAlign: "top",
        }}
      >
        {children}
      </td>
    ),
  };

  return (
    <div style={{ fontSize: "13px", color: "var(--origin-fg-default)", lineHeight: 1.7 }}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {sanitizeProse(content)}
      </ReactMarkdown>
    </div>
  );
}

/**
 * Style d'un titre de message, hiérarchisé comme un document (« type Word ») :
 * le niveau 1 détache visuellement une section, les niveaux suivants s'y
 * subordonnent (taille décroissante, marge resserrée). On garde une échelle
 * compacte car ces titres vivent dans une bulle de chat, pas dans une page A4.
 */
function headingStyle(level: 1 | 2 | 3 | 4): React.CSSProperties {
  const spec = {
    1: { size: 17, top: 4,  bottom: 8 },
    2: { size: 15, top: 16, bottom: 6 },
    3: { size: 13.5, top: 14, bottom: 4 },
    4: { size: 13, top: 12, bottom: 4 },
  }[level];
  return {
    fontSize: `${spec.size}px`,
    fontWeight: 600,
    color: "var(--origin-fg-default)",
    margin: `${spec.top}px 0 ${spec.bottom}px`,
    lineHeight: 1.4,
  };
}
