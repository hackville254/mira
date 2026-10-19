/* eslint-disable react-refresh/only-export-components */
/**
 * Mira — primitives d'UI partagées par les pages Settings « extensions »
 * (Skills, Commands, MCP, Hooks, About).
 *
 * Ce module expose VOLONTAIREMENT des constantes de style en plus des
 * composants : le fast-refresh ne s'y applique donc pas, ce qui est acceptable
 * pour un fichier de primitives stables.
 */

import { useState } from "react";
import type { CSSProperties, ReactNode } from "react";

// ── Tokens de style ─────────────────────────────────────────────────────────

export const sectionCard: CSSProperties = {
  border: "1px solid var(--origin-border-default)",
  borderRadius: 8,
  backgroundColor: "var(--origin-bg-sidebar)",
  padding: "14px 16px",
  marginBottom: 12,
};

export const fieldStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "6px 9px",
  borderRadius: 6,
  border: "1px solid var(--origin-border-default)",
  backgroundColor: "var(--origin-bg-base)",
  color: "var(--origin-fg-default)",
  fontSize: 12.5,
  fontFamily: "inherit",
  outline: "none",
};

export const monoFieldStyle: CSSProperties = {
  ...fieldStyle,
  fontFamily: "var(--font-mono)",
  fontSize: 12,
};

// ── Page (en-tête + corps) ──────────────────────────────────────────────────

/** En-tête de page : titre + description, façon panneau de réglages. */
export function PageHeader({ title, description, actions }: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 16, marginBottom: 18 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 17, fontWeight: 600, color: "var(--origin-fg-default)" }}>{title}</div>
        {description && (
          <div style={{ fontSize: 12.5, color: "var(--origin-fg-muted)", marginTop: 5, lineHeight: 1.55 }}>
            {description}
          </div>
        )}
      </div>
      {actions && <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>{actions}</div>}
    </div>
  );
}

/** Séparateur de section avec intitulé. */
export function SubHeading({ children }: { children: ReactNode }) {
  return (
    <div style={{
      fontSize: 11, fontWeight: 600, color: "var(--origin-fg-subtle)",
      textTransform: "uppercase", letterSpacing: "0.07em", margin: "20px 0 8px",
    }}>
      {children}
    </div>
  );
}

// ── Boutons ────────────────────────────────────────────────────────────────

export function Button({ onClick, children, variant = "secondary", disabled, title, small }: {
  onClick: () => void;
  children: ReactNode;
  variant?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  title?: string;
  small?: boolean;
}) {
  const palette: Record<string, { bg: string; fg: string; border: string }> = {
    primary: {
      bg: "var(--origin-semantic-accent, #2f81f7)",
      fg: "#fff",
      border: "transparent",
    },
    secondary: {
      bg: "transparent",
      fg: "var(--origin-fg-default)",
      border: "var(--origin-border-default)",
    },
    danger: {
      bg: "transparent",
      fg: "var(--origin-semantic-error, #f85149)",
      border: "var(--origin-border-default)",
    },
  };
  const p = palette[variant];
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        display: "inline-flex", alignItems: "center", gap: 5,
        padding: small ? "3px 9px" : "5px 12px",
        borderRadius: 6,
        border: `1px solid ${p.border}`,
        backgroundColor: p.bg,
        color: p.fg,
        fontSize: small ? 11.5 : 12.5,
        fontFamily: "inherit",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: "filter 0.12s",
      }}
      onMouseEnter={e => { if (!disabled) e.currentTarget.style.filter = "brightness(1.12)"; }}
      onMouseLeave={e => { e.currentTarget.style.filter = "none"; }}
    >
      {children}
    </button>
  );
}

/** Bouton-icône compact (actions de ligne : éditer, supprimer…). */
export function IconButton({ onClick, title, children, danger }: {
  onClick: () => void;
  title: string;
  children: ReactNode;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 26, height: 26, borderRadius: 6, cursor: "pointer",
        border: "1px solid var(--origin-border-default)",
        backgroundColor: "transparent",
        color: danger ? "var(--origin-semantic-error, #f85149)" : "var(--origin-fg-muted)",
      }}
      onMouseEnter={e => { e.currentTarget.style.backgroundColor = "var(--origin-bg-hover)"; }}
      onMouseLeave={e => { e.currentTarget.style.backgroundColor = "transparent"; }}
    >
      {children}
    </button>
  );
}

// ── Interrupteur ───────────────────────────────────────────────────────────

export function Switch({ on, onToggle, disabled, title }: {
  on: boolean;
  onToggle: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      onClick={onToggle}
      disabled={disabled}
      title={title}
      role="switch"
      aria-checked={on}
      style={{
        width: 34, height: 18, borderRadius: 9, border: "none",
        cursor: disabled ? "not-allowed" : "pointer", padding: 2,
        display: "flex", alignItems: "center", flexShrink: 0,
        opacity: disabled ? 0.5 : 1,
        backgroundColor: on ? "var(--origin-semantic-success, #2ea043)" : "var(--origin-border-default)",
        transition: "background 0.15s",
      }}
    >
      <span style={{
        width: 14, height: 14, borderRadius: "50%", backgroundColor: "#fff",
        transform: on ? "translateX(16px)" : "translateX(0)",
        transition: "transform 0.15s",
        boxShadow: "0 1px 2px rgba(0,0,0,0.3)",
      }} />
    </button>
  );
}

// ── États (vide / chargement / erreur) ──────────────────────────────────────

export function EmptyState({ title, hint, action }: {
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      gap: 8, padding: "36px 20px", textAlign: "center",
      border: "1px dashed var(--origin-border-default)", borderRadius: 8,
    }}>
      <div style={{ fontSize: 13.5, color: "var(--origin-fg-default)", fontWeight: 500 }}>{title}</div>
      {hint && <div style={{ fontSize: 12, color: "var(--origin-fg-muted)", maxWidth: 420, lineHeight: 1.6 }}>{hint}</div>}
      {action && <div style={{ marginTop: 6 }}>{action}</div>}
    </div>
  );
}

export function LoadingLine({ label = "Loading…" }: { label?: string }) {
  return <div style={{ fontSize: 12.5, color: "var(--origin-fg-subtle)", padding: "18px 0" }}>{label}</div>;
}

export function ErrorLine({ message }: { message: string }) {
  return (
    <div style={{
      fontSize: 12.5, color: "var(--origin-semantic-error, #f85149)",
      padding: "10px 12px", border: "1px solid var(--origin-border-default)",
      borderRadius: 6, marginBottom: 12,
    }}>
      {message}
    </div>
  );
}

// ── Ligne de liste générique ───────────────────────────────────────────────

export function ListRow({ title, subtitle, badge, right, onClick }: {
  title: ReactNode;
  subtitle?: ReactNode;
  badge?: ReactNode;
  right?: ReactNode;
  onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        display: "flex", alignItems: "center", gap: 12,
        padding: "10px 12px",
        border: "1px solid var(--origin-border-default)",
        borderRadius: 8,
        marginBottom: 8,
        backgroundColor: "var(--origin-bg-base)",
        cursor: onClick ? "pointer" : "default",
      }}
      onMouseEnter={e => { if (onClick) e.currentTarget.style.backgroundColor = "var(--origin-bg-hover)"; }}
      onMouseLeave={e => { e.currentTarget.style.backgroundColor = "var(--origin-bg-base)"; }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 13, color: "var(--origin-fg-default)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {title}
          </span>
          {badge}
        </div>
        {subtitle && (
          <div style={{ fontSize: 11.5, color: "var(--origin-fg-muted)", marginTop: 3, lineHeight: 1.5 }}>
            {subtitle}
          </div>
        )}
      </div>
      {right && <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>{right}</div>}
    </div>
  );
}

/** Petite pastille de portée (`Global` / `Projet`) ou d'état. */
export function Badge({ children, tone = "neutral" }: {
  children: ReactNode;
  tone?: "neutral" | "success" | "warning" | "accent";
}) {
  const colors: Record<string, string> = {
    neutral: "var(--origin-fg-subtle)",
    success: "var(--origin-semantic-success, #2ea043)",
    warning: "var(--origin-semantic-warning, #d29922)",
    accent: "var(--origin-semantic-accent, #2f81f7)",
  };
  return (
    <span style={{
      fontSize: 10.5, fontWeight: 600, letterSpacing: "0.03em",
      textTransform: "uppercase",
      color: colors[tone],
      border: `1px solid ${colors[tone]}`,
      borderRadius: 4, padding: "1px 5px", opacity: 0.85, flexShrink: 0,
    }}>
      {children}
    </span>
  );
}

// ── Sélecteur de portée (global / projet) ──────────────────────────────────

export type Scope = "global" | "project";

export function ScopeTabs({ scope, onChange, projectAvailable }: {
  scope: Scope;
  onChange: (s: Scope) => void;
  projectAvailable: boolean;
}) {
  const tab = (id: Scope, label: string, enabled: boolean) => (
    <button
      key={id}
      onClick={() => enabled && onChange(id)}
      disabled={!enabled}
      title={enabled ? undefined : "No project folder open"}
      style={{
        padding: "4px 12px", fontSize: 12, fontFamily: "inherit",
        border: `1px solid ${scope === id ? "var(--origin-semantic-accent, #2f81f7)" : "var(--origin-border-default)"}`,
        backgroundColor: scope === id ? "color-mix(in srgb, var(--origin-semantic-accent, #2f81f7) 14%, transparent)" : "transparent",
        color: enabled ? "var(--origin-fg-default)" : "var(--origin-fg-subtle)",
        cursor: enabled ? "pointer" : "not-allowed",
        opacity: enabled ? 1 : 0.5,
        borderRadius: 6,
      }}
    >
      {label}
    </button>
  );
  return (
    <div style={{ display: "flex", gap: 6 }}>
      {tab("global", "Global", true)}
      {tab("project", "Project", projectAvailable)}
    </div>
  );
}

// ── Champ de saisie libellé ────────────────────────────────────────────────

export function Field({ label, hint, children }: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label style={{ display: "block", marginBottom: 12 }}>
      <div style={{ fontSize: 12, color: "var(--origin-fg-default)", marginBottom: 5, fontWeight: 500 }}>
        {label}
      </div>
      {children}
      {hint && <div style={{ fontSize: 11, color: "var(--origin-fg-subtle)", marginTop: 4, lineHeight: 1.5 }}>{hint}</div>}
    </label>
  );
}

/**
 * Éditeur de carte de paires clé→valeur (variables d'environnement MCP,
 * en-têtes HTTP). On gère l'état des lignes ici : les pages n'ont qu'un tableau
 * `Record<string,string>` à lire/écrire.
 */
export function KeyValueEditor({ value, onChange, keyPlaceholder = "KEY", valuePlaceholder = "value" }: {
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}) {
  // On matérialise les entrées en lignes stables pour permettre l'édition d'une
  // clé vide en cours de frappe (une Map ne le permettrait pas).
  const [rows, setRows] = useState<Array<{ k: string; v: string }>>(() =>
    Object.entries(value).map(([k, v]) => ({ k, v }))
  );

  function commit(next: Array<{ k: string; v: string }>) {
    setRows(next);
    const record: Record<string, string> = {};
    for (const { k, v } of next) if (k.trim()) record[k.trim()] = v;
    onChange(record);
  }

  return (
    <div>
      {rows.map((row, i) => (
        <div key={i} style={{ display: "flex", gap: 6, marginBottom: 6 }}>
          <input
            value={row.k}
            placeholder={keyPlaceholder}
            onChange={e => commit(rows.map((r, j) => (j === i ? { ...r, k: e.target.value } : r)))}
            style={{ ...monoFieldStyle, flex: 1 }}
          />
          <input
            value={row.v}
            placeholder={valuePlaceholder}
            onChange={e => commit(rows.map((r, j) => (j === i ? { ...r, v: e.target.value } : r)))}
            style={{ ...monoFieldStyle, flex: 2 }}
          />
          <IconButton title="Remove" danger onClick={() => commit(rows.filter((_, j) => j !== i))}>
            ×
          </IconButton>
        </div>
      ))}
      <Button small onClick={() => commit([...rows, { k: "", v: "" }])}>+ Add</Button>
    </div>
  );
}
