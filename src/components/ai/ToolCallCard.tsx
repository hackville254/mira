import { useState } from "react";
import { ChevronDown, Check, ShieldAlert } from "lucide-react";
import type { ToolCallDisplay } from "../../lib/aiTypes";
import { toolTargetPath } from "../../lib/toolGroups";
import AskUserCard from "./AskUserCard";
import SubAgentCard from "./SubAgentCard";

const TOOL_LABELS: Record<string, string> = {
  read_file: "Read file",
  list_directory: "List directory",
  grep: "Search",
  glob: "List files",
  write_file: "Write file",
  edit: "Edit file",
  multi_edit: "Edit file",
  bash_run: "Run command",
  ask_user: "Question",
};

function toolLabel(name: string) { return TOOL_LABELS[name] ?? name; }

function argsPreview(toolName: string, args: unknown): string {
  const a = args as Record<string, unknown>;
  if (!a) return "";
  if (toolName === "read_file" || toolName === "list_directory" || toolName === "write_file" || toolName === "edit" || toolName === "multi_edit") {
    const p = String(a.path ?? "");
    return p.split(/[/\\]/).pop() ?? p;
  }
  if (toolName === "grep") return `"${a.query}"`;
  if (toolName === "bash_run") return String(a.command ?? "").slice(0, 60);
  if (toolName === "glob") return String(a.folder ?? "workspace");
  return "";
}

function resultSummary(result: unknown): string {
  if (result === undefined || result === null) return "Done";
  if (typeof result === "string") return result.slice(0, 300);
  const obj = result as Record<string, unknown>;
  if (obj.error) return `Error: ${obj.error}`;
  if (obj.cancelled) return "Cancelled";
  if (typeof obj.answer === "string") return obj.answer ? `Answer: ${obj.answer}` : "No answer provided";
  if (obj.success) return `Written: ${obj.path}`;
  if (obj.content && typeof obj.content === "string") {
    // read_file renvoie une tranche : on annonce la plage et la troncature.
    if (typeof obj.total_lines === "number") {
      const range = `lines ${obj.start_line}–${obj.end_line} of ${obj.total_lines}`;
      return obj.truncated ? `${range} (truncated) — ${obj.content.slice(0, 240)}` : `${range}\n${obj.content.slice(0, 240)}`;
    }
    return obj.content.slice(0, 300);
  }
  if (obj.results && Array.isArray(obj.results)) return `${obj.results.length} result(s)`;
  if (obj.entries && Array.isArray(obj.entries)) return `${obj.entries.length} item(s)`;
  if (obj.files && Array.isArray(obj.files)) return `${obj.files.length} file(s)`;
  if (obj.stdout !== undefined) {
    const out = String(obj.stdout).trim();
    const err = String(obj.stderr ?? "").trim();
    return out || err || `exit ${obj.exit_code}`;
  }
  return JSON.stringify(result).slice(0, 200);
}

export default function ToolCallCard({
  tc,
  onOpenFile,
}: {
  tc: ToolCallDisplay;
  onOpenFile?: (path: string, line?: number, col?: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  // Les sous-agents d'un `spawn_agent` sont rendus sous la carte du tool-call :
  // le tool-call lui-même reste la « ligne » du délégateur, les cartes de
  // sous-agent montrent le travail réellement effectué.
  const children = tc.children ?? [];
  const withChildren = (node: React.ReactNode) => (
    <>
      {node}
      {children.map(child => <SubAgentCard key={child.spawnId} child={child} />)}
    </>
  );

  // Encadré réservé aux cas « sensibles » (approbation) : les états running et
  // complete restent des accordéons nus, alignés sur le rendu Trae.
  const boxedStyle: React.CSSProperties = {
    margin: "3px 0",
    borderRadius: "6px",
    border: "1px solid var(--origin-border-default)",
    backgroundColor: "var(--origin-bg-editor)",
    fontSize: "12px",
    overflow: "hidden",
  };

  if (tc.status === "running") {
    return withChildren(
      <div style={{ margin: "2px 0" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "6px", padding: "2px 0", color: "var(--origin-fg-subtle)", fontSize: "12px" }}>
          <div style={{
            width: 11, height: 11, flexShrink: 0,
            border: "1.5px solid var(--origin-fg-subtle)",
            borderTopColor: "var(--origin-accent-blue)",
            borderRadius: "50%",
            animation: "spin 0.8s linear infinite",
          }} />
          <span>{toolLabel(tc.toolName)}</span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: "var(--origin-fg-subtle)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
            {argsPreview(tc.toolName, tc.args)}
          </span>
        </div>
      </div>,
    );
  }

  if (tc.status === "approval-required" && tc.action) {
    const action = tc.action;

    // Question interactive : pas d'approbation binaire mais un choix cliquable.
    if (action.type === "ask_user") {
      if (tc.reject) {
        return (
          <AskUserCard
            question={action.question}
            options={action.options}
            allowFreeform={action.allowFreeform}
            onAnswer={(answer) => tc.reject?.(answer)}
          />
        );
      }
      // Question déjà répondue : le résultat porte la réponse.
      const answered = (tc.result as { answer?: string } | undefined)?.answer;
      return (
        <AskUserCard
          question={action.question}
          options={action.options}
          allowFreeform={false}
          answered={answered ?? ""}
          onAnswer={() => {}}
        />
      );
    }

    return (
      <div style={{ ...boxedStyle, border: "1px solid color-mix(in srgb, var(--origin-semantic-warning) 50%, transparent)", backgroundColor: "color-mix(in srgb, var(--origin-semantic-warning) 8%, transparent)" }}>
        <div style={{ padding: "8px 10px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "5px", marginBottom: "6px" }}>
            <ShieldAlert size={11} style={{ color: "var(--origin-semantic-warning)", flexShrink: 0 }} />
            <span style={{ fontSize: "11px", fontWeight: 600, color: "var(--origin-semantic-warning)" }}>Approval required</span>
            <span style={{ fontSize: "11px", color: "var(--origin-fg-muted)", fontFamily: "var(--font-mono)", marginLeft: 4 }}>
              {toolLabel(tc.toolName)}
            </span>
          </div>
          <div style={{
            backgroundColor: "var(--origin-bg-base)",
            borderRadius: "4px",
            padding: "6px 8px",
            marginBottom: "8px",
            fontFamily: "var(--font-mono)",
            fontSize: "11px",
            color: "var(--origin-fg-muted)",
            maxHeight: "100px",
            overflowY: "auto",
          }}>
            {action.type === "bash_run" && (
              <span style={{ color: "var(--origin-fg-default)" }}>
                $ {action.command}
                {action.cwd && (
                  <span style={{ color: "var(--origin-fg-subtle)", marginLeft: 8 }}>
                    ({action.cwd.split(/[/\\]/).pop()})
                  </span>
                )}
              </span>
            )}
            {action.type === "write_file" && (
              <>
                <div style={{ color: "var(--origin-fg-subtle)", marginBottom: 4 }}>
                  {action.path.split(/[/\\]/).pop()}
                </div>
                <div style={{ color: "var(--origin-fg-muted)" }}>
                  {action.content.slice(0, 180)}
                  {action.content.length > 180 ? "…" : ""}
                </div>
              </>
            )}
            {action.type === "edit" && (
              <>
                <div style={{ color: "var(--origin-fg-subtle)", marginBottom: 4 }}>
                  {action.path.split(/[/\\]/).pop()}
                </div>
                <div style={{ color: "var(--origin-semantic-success)" }}>
                  + {action.updated.slice(0, 120)}
                  {action.updated.length > 120 ? "…" : ""}
                </div>
              </>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end" }}>
            <span style={{ fontSize: "11px", color: "var(--origin-fg-subtle)", fontStyle: "italic" }}>
              Review in the diff tab →
            </span>
          </div>
        </div>
      </div>
    );
  }

  if (tc.status === "complete") {
    const summary = resultSummary(tc.result);
    const isCancelled = (tc.result as Record<string, unknown> | undefined)?.cancelled;
    const isError = (tc.result as Record<string, unknown> | undefined)?.error;
    const targetPath = toolTargetPath(tc);
    const clickable = !!targetPath && !!onOpenFile && !isError && !isCancelled;
    return withChildren(
      <div style={{ margin: "2px 0" }}>
        <div
          onClick={() => setExpanded(e => !e)}
          style={{ display: "flex", alignItems: "center", gap: "6px", padding: "2px 0", cursor: "pointer", fontSize: "12px" }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.opacity = "0.85"; }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.opacity = "1"; }}
        >
          {isCancelled ? (
            <span style={{ fontSize: "9px", color: "var(--origin-fg-subtle)", flexShrink: 0 }}>✕</span>
          ) : isError ? (
            <span style={{ fontSize: "9px", color: "var(--origin-semantic-error)", flexShrink: 0 }}>✕</span>
          ) : (
            <Check size={11} style={{ color: "var(--origin-semantic-success)", flexShrink: 0 }} />
          )}
          <span style={{ color: "var(--origin-fg-subtle)" }}>{toolLabel(tc.toolName)}</span>
          {/* Le nom de fichier est cliquable : il ouvre le fichier dans l'éditeur,
              sans déplier l'accordéon (stopPropagation). */}
          <span
            onClick={clickable ? (e) => { e.stopPropagation(); onOpenFile?.(targetPath); } : undefined}
            title={targetPath || undefined}
            style={{
              fontFamily: "var(--font-mono)", fontSize: "11px", overflow: "hidden",
              textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1,
              color: clickable ? "var(--origin-fg-muted)" : "var(--origin-fg-subtle)",
              cursor: clickable ? "pointer" : "inherit",
              textDecoration: clickable ? "underline" : "none",
              textDecorationColor: "var(--origin-border-default)",
              textUnderlineOffset: "2px",
            }}
            onMouseEnter={e => { if (clickable) { e.currentTarget.style.color = "var(--origin-fg-default)"; e.currentTarget.style.textDecorationColor = "var(--origin-fg-muted)"; } }}
            onMouseLeave={e => { if (clickable) { e.currentTarget.style.color = "var(--origin-fg-muted)"; e.currentTarget.style.textDecorationColor = "var(--origin-border-default)"; } }}
          >
            {targetPath || argsPreview(tc.toolName, tc.args)}
          </span>
          <ChevronDown
            size={11}
            style={{ flexShrink: 0, color: "var(--origin-fg-subtle)", transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.12s" }}
          />
        </div>
        {expanded && (
          <div style={{
            padding: "4px 0 4px 17px",
            fontFamily: "var(--font-mono)",
            fontSize: "11px",
            color: "var(--origin-fg-subtle)",
            maxHeight: "160px",
            overflowY: "auto",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}>
            {summary}
          </div>
        )}
      </div>,
    );
  }

  return null;
}
