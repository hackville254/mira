import { Icon } from "@iconify/react";
import { useWorkspace } from "../../context/WorkspaceContext";
import { lsForPath } from "../../lib/sessionStore";
import { useActiveTasks } from "../../lib/agent/taskRuntime";

/**
 * Bandeau de progression multitâche (parité Trae).
 *
 * En mode AI, plusieurs tâches peuvent tourner EN PARALLÈLE. Quand l'utilisateur
 * en affiche une, les autres continuent en arrière-plan : il doit donc pouvoir
 * voir d'un coup d'œil QUI travaille encore, sans changer de tâche.
 *
 * Ce composant lit le registre de statut réel (`taskRuntime`) et affiche une
 * puce cliquable par tâche active (running | waiting), avec son libellé et, le
 * cas échéant, l'outil attendu. Un clic bascule l'affichage sur cette tâche.
 *
 * Il ne rend RIEN tant qu'une seule tâche (ou aucune) est active : aucune
 * pollution visuelle dans le cas courant mono-tâche.
 */
export default function TaskProgressBar({
  activeSessionId,
  onSelect,
}: {
  activeSessionId: string | null;
  onSelect: (sessionId: string) => void;
}) {
  const { folderPath } = useWorkspace();
  const active = useActiveTasks();

  // Résolution des titres : le registre ne connaît que les `sessionId`, pas les
  // titres humains. On lit donc les métadonnées persistées de la tâche. Le calcul
  // est fait à chaque rendu (déclenché par un changement du registre) : c'est un
  // simple parcours d'un tableau court, volontairement non mémoïsé pour rester
  // corrélé au statut live des tâches actives.
  const titleById = new Map<string, string>();
  for (const s of lsForPath(folderPath ?? "")) titleById.set(s.id, s.title || "Untitled task");

  // Mono-tâche : rien à signaler, on n'occupe pas d'espace.
  if (active.length < 2) return null;

  const running = active.filter(t => t.status === "running").length;
  const waiting = active.length - running;

  return (
    <div
      style={{
        display: "flex", alignItems: "center", gap: 8,
        height: 30, flexShrink: 0, padding: "0 8px",
        backgroundColor: "var(--origin-bg-panel)",
        borderBottom: "1px solid var(--origin-border-default)",
        fontSize: 11, color: "var(--origin-fg-muted)",
      }}
    >
      <Icon
        icon="lucide:loader-circle"
        width={13}
        style={{
          flexShrink: 0,
          color: "var(--origin-semantic-info, #60a5fa)",
          animation: "origin-spin 1s linear infinite",
        }}
      />
      <span style={{ flexShrink: 0, fontWeight: 600 }}>
        {active.length} active tasks
      </span>
      {(running > 0 || waiting > 0) && (
        <span style={{ flexShrink: 0, color: "var(--origin-fg-subtle)" }}>
          {running > 0 ? `${running} running` : ""}
          {running > 0 && waiting > 0 ? " · " : ""}
          {waiting > 0 ? `${waiting} waiting` : ""}
        </span>
      )}

      <div style={{ flex: 1, minWidth: 0, display: "flex", gap: 6, overflowX: "auto" }}>
        {active.map(t => {
          const isShown = t.sessionId === activeSessionId;
          const label =
            t.status === "waiting"
              ? `${titleById.get(t.sessionId) ?? t.sessionId} · ${t.waitingTool ?? "waiting"}`
              : titleById.get(t.sessionId) ?? t.sessionId;
          return (
            <button
              key={t.sessionId}
              onClick={() => onSelect(t.sessionId)}
              title={isShown ? "Task shown" : "Show this task"}
              style={{
                display: "flex", alignItems: "center", gap: 5,
                flexShrink: 0, maxWidth: 240,
                padding: "2px 8px", borderRadius: 999,
                background: isShown ? "rgba(96, 165, 250, 0.14)" : "var(--origin-bg-base)",
                border: "1px solid " + (isShown ? "rgba(96,165,250,0.35)" : "var(--origin-border-default)"),
                color: isShown ? "var(--origin-fg-default)" : "var(--origin-fg-muted)",
                cursor: "pointer", fontSize: 11,
              }}
            >
              <Icon
                icon={t.status === "waiting" ? "lucide:hourglass" : "lucide:activity"}
                width={11}
                style={{
                  flexShrink: 0,
                  color: t.status === "waiting"
                    ? "var(--origin-semantic-warning, #fbbf24)"
                    : "var(--origin-semantic-info, #60a5fa)",
                }}
              />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
