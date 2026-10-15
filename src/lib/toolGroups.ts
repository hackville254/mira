import type { MessagePart, ToolCallDisplay } from "./aiTypes";

// ── Regroupement des outils par « tour visuel » ────────────────────────────────
//
// Trae/Cursor condensent une rafale d'outils en une seule ligne repliable :
//   « Read 2 files › », « Read 3 files ⌄ », « Searched files 1 time › ».
//
// On reproduit ce comportement : une séquence de tool-calls CONSÉCUTIFS portant
// le même verbe (read/grep/glob/…) est fusionnée en un groupe. Un groupe
// interrompu par du texte ou par un outil d'un autre verbe en démarre un autre.
//
// Les outils « sensibles » (écriture, commande, question) ne sont JAMAIS
// regroupés : ils gardent leur carte dédiée, car l'utilisateur doit les voir
// individuellement (approbation, diff, question).

export type ToolGroupRenderer =
  | { kind: "single"; tc: ToolCallDisplay }
  | { kind: "group"; verb: string; label: string; tools: ToolCallDisplay[] };

/** Verbe visuel d'un outil — détermine les regroupements possibles. */
export function toolVerb(toolName: string): string {
  switch (toolName) {
    case "read_file":       return "read";
    case "grep":            return "search";
    case "glob":            return "list";
    case "list_directory":  return "list";
    default:                return toolName;
  }
}

/** Un outil est-il regroupable ? (lecture seule, non sensible) */
export function isGroupable(toolName: string): boolean {
  return toolName === "read_file"
      || toolName === "grep"
      || toolName === "glob"
      || toolName === "list_directory";
}

/**
 * Chemin workspace-relatif exploitable d'un outil (pour ouvrir le fichier dans
 * l'éditeur). Renvoie `""` si l'outil n'a pas de cible fichier (grep, glob…).
 * Le chemin est renvoyé tel quel (relatif au workspace), pas réduit au basename.
 */
export function toolTargetPath(tc: ToolCallDisplay): string {
  const a = (tc.args ?? {}) as Record<string, unknown>;
  switch (tc.toolName) {
    case "read_file":
    case "write_file":
    case "edit":
    case "multi_edit":
      return String(a.path ?? "");
    default:
      return "";
  }
}

/**
 * Étiquettes au pluriel, calquées sur les captures Trae. Un groupe est décrit
 * par une SUITE de verbes : « Read 2 files, Searched files 2 times ».
 */
export function groupLabel(verb: string, count: number): string {
  switch (verb) {
    case "read":
      return count === 1 ? "Read 1 file" : `Read ${count} files`;
    case "search":
      return count === 1 ? "Searched files 1 time" : `Searched files ${count} times`;
    case "list":
      return count === 1 ? "Listed 1 folder" : `Listed ${count} folders`;
    default:
      return `${count} calls`;
  }
}

/**
 * Étiquette combinée d'un groupe hétérogène : on agrège les verbes rencontrés
 * dans l'ordre d'apparition, chacun avec son compte, joint par « , ».
 *   [read, read, search, search] → « Read 2 files, Searched files 2 times »
 */
export function combinedGroupLabel(tools: ToolCallDisplay[]): string {
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const tc of tools) {
    const verb = toolVerb(tc.toolName);
    if (!counts.has(verb)) order.push(verb);
    counts.set(verb, (counts.get(verb) ?? 0) + 1);
  }
  return order.map(v => groupLabel(v, counts.get(v) ?? 0)).join(", ");
}

/**
 * Transforme les parts d'un message assistant en une liste de renderers.
 *
 * Les parts `text` et `plan-card` sont conservées telles quelles (via un
 * renderer `single`-like géré par l'appelant) ; seuls les tool-calls
 * regroupables sont condensés. Un groupe a toujours ≥ 2 membres.
 */
export function buildToolRenderers(parts: MessagePart[]): Array<
  | { kind: "text"; content: string }
  | { kind: "reasoning"; content: string }
  | { kind: "plan-card"; part: Extract<MessagePart, { type: "plan-card" }> }
  | { kind: "status"; part: Extract<MessagePart, { type: "status" }> }
  | ToolGroupRenderer
> {
  const out: Array<
    | { kind: "text"; content: string }
    | { kind: "reasoning"; content: string }
    | { kind: "plan-card"; part: Extract<MessagePart, { type: "plan-card" }> }
    | { kind: "status"; part: Extract<MessagePart, { type: "status" }> }
    | ToolGroupRenderer
  > = [];

  let run: ToolCallDisplay[] = [];

  // Un « run » = suite d'outils de lecture CONSÉCUTIFS. Un groupe n'est rendu
  // comme accordéon que s'il compte ≥ 2 membres ; sinon chaque outil reste une
  // carte individuelle (plus lisible pour un appel isolé).
  const flush = () => {
    if (run.length === 0) return;
    if (run.length === 1) {
      out.push({ kind: "single", tc: run[0] });
    } else {
      out.push({ kind: "group", verb: toolVerb(run[0].toolName), label: combinedGroupLabel(run), tools: run });
    }
    run = [];
  };

  for (const part of parts) {
    if (part.type !== "tool-call") {
      flush();
      if (part.type === "text") out.push({ kind: "text", content: part.content });
      else if (part.type === "reasoning") out.push({ kind: "reasoning", content: part.content });
      else if (part.type === "plan-card") out.push({ kind: "plan-card", part });
      else out.push({ kind: "status", part });
      continue;
    }

    const tc = part.tc;
    const groupable = isGroupable(tc.toolName) && tc.status !== "approval-required";
    if (!groupable) {
      flush();
      out.push({ kind: "single", tc });
      continue;
    }

    run.push(tc);
  }
  flush();
  return out;
}
