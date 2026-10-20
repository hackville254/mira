import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useState, type ReactNode } from "react";
import { Check, Copy, FolderOpen } from "lucide-react";
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
 * Bloc de code d'un message de l'agent.
 *
 * Rendu volontairement sobre (« pro ») : une barre d'en-tête discrète avec le
 * langage à gauche et l'unique action utile (copier) à droite, puis le code
 * dans un cadre à fond sombre. Pas de coloration syntaxique : le contenu est
 * arbitraire (extraits, arborescences, sorties de commandes) et un highlighter
 * mal calibré produirait plus de bruit que de signal.
 */
function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    void navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div
      style={{
        margin: "10px 0",
        borderRadius: 6,
        overflow: "hidden",
        border: "1px solid var(--origin-border-default)",
        backgroundColor: "var(--origin-bg-editor)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: "3px 6px 3px 12px",
          backgroundColor: "var(--origin-bg-hover)",
          borderBottom: "1px solid var(--origin-border-default)",
          gap: 4,
        }}
      >
        <span
          style={{
            flex: 1,
            fontSize: "11px",
            letterSpacing: "0.02em",
            textTransform: "lowercase",
            color: "var(--origin-fg-muted)",
            fontFamily: "var(--font-mono)",
            userSelect: "none",
          }}
        >
          {language || "code"}
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
          {copied ? <Check size={11} /> : <Copy size={11} />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>

      <pre
        style={{
          margin: 0,
          padding: "10px 14px",
          overflowX: "auto",
          fontSize: "12px",
          lineHeight: "1.6",
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
  gap: 4,
  fontSize: "11px",
  color: "var(--origin-fg-muted)",
  background: "transparent",
  border: "none",
  cursor: "pointer",
  padding: "2px 7px",
  borderRadius: 4,
  fontFamily: "var(--font-sans)",
};

export default function MarkdownMessage({ content, onOpenPath }: Props) {
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
