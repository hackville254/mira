import { describe, it, expect } from "vitest";
import { flowTargetFor, activeFlowTab, shouldFlow } from "../flow";

describe("flowTargetFor", () => {
  it("mappe editor → diffview (on juge le changement écrit)", () => {
    expect(flowTargetFor("editor")).toBe("diffview");
  });

  it("mappe read_files → editor", () => {
    expect(flowTargetFor("read_files")).toBe("editor");
  });

  it("mappe run_commands → terminal", () => {
    expect(flowTargetFor("run_commands")).toBe("terminal");
  });

  it("mappe fetch_web_content → browser", () => {
    expect(flowTargetFor("fetch_web_content")).toBe("browser");
  });

  it("renvoie undefined pour un outil sans panneau dédié", () => {
    expect(flowTargetFor("search_codebase")).toBeUndefined();
    expect(flowTargetFor("todo_write")).toBeUndefined();
    expect(flowTargetFor("ask_question")).toBeUndefined();
    expect(flowTargetFor("skills")).toBeUndefined();
  });

  it("renvoie undefined pour un outil inconnu ou vide (aucun clignotement)", () => {
    expect(flowTargetFor("outil_bidon")).toBeUndefined();
    expect(flowTargetFor("")).toBeUndefined();
    expect(flowTargetFor(null)).toBeUndefined();
    expect(flowTargetFor(undefined)).toBeUndefined();
  });
});

describe("activeFlowTab", () => {
  it("prend le DERNIER tool-call pilotable (l'étape active)", () => {
    expect(activeFlowTab([
      { toolName: "read_files" },
      { toolName: "run_commands" },
    ])).toBe("terminal");
  });

  it("ignore les outils sans panneau et remonte au dernier pilotable", () => {
    expect(activeFlowTab([
      { toolName: "editor" },
      { toolName: "search_codebase" },
      { toolName: "todo_write" },
    ])).toBe("diffview");
  });

  it("renvoie undefined si aucun tool-call ne tourne", () => {
    expect(activeFlowTab([])).toBeUndefined();
  });

  it("renvoie undefined si aucun outil pilotable ne tourne", () => {
    expect(activeFlowTab([
      { toolName: "search_codebase" },
      { toolName: "todo_write" },
    ])).toBeUndefined();
  });
});

describe("shouldFlow", () => {
  it("n'active le Flow que pendant un run", () => {
    expect(shouldFlow(true)).toBe(true);
    expect(shouldFlow(false)).toBe(false);
  });
});
