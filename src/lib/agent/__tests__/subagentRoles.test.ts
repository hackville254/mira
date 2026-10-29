import { describe, it, expect } from "vitest";
import {
  ROLES, DEFAULT_ROLE_ID, listRoles, roleIds, resolveRole, rolesCatalogPrompt,
} from "../subagentRoles";
import { buildContextBlock, MAX_CONTEXT_CHARS, type ProjectContext } from "../projectContext";

// ── Catalogue de rôles ─────────────────────────────────────────────────────────

describe("catalogue de rôles", () => {
  it("expose le rôle par défaut et l'inclut dans les ids", () => {
    expect(ROLES[DEFAULT_ROLE_ID]).toBeDefined();
    expect(roleIds()).toContain(DEFAULT_ROLE_ID);
  });

  it("chaque rôle est bien formé et en lecture seule", () => {
    const allowedTools = new Set(["read_file", "list_directory", "grep", "glob", "todo_read"]);
    for (const role of listRoles()) {
      expect(role.id).toBeTruthy();
      expect(role.label).toBeTruthy();
      expect(role.icon).toBeTruthy();
      expect(role.description).toBeTruthy();
      expect(role.systemPrompt.length).toBeGreaterThan(50);
      expect(role.tools.length).toBeGreaterThan(0);
      // Allowlist stricte : aucun outil hors du set read-only.
      for (const t of role.tools) expect(allowedTools.has(t)).toBe(true);
      // Budget cohérent.
      expect(role.budget.maxSteps).toBeGreaterThan(0);
      expect(role.budget.maxInputTokens).toBeGreaterThan(0);
      expect(role.budget.timeoutMs).toBeGreaterThan(0);
      expect(role.budget.reportMaxChars).toBeGreaterThan(0);
    }
  });

  it("les ids de rôle sont uniques", () => {
    const ids = listRoles().map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("resolveRole — entrée NON fiable", () => {
  it("résout un id valide", () => {
    expect(resolveRole("review").id).toBe("review");
  });

  it("retombe sur le rôle par défaut pour une entrée inconnue/absente", () => {
    expect(resolveRole("nope").id).toBe(DEFAULT_ROLE_ID);
    expect(resolveRole(undefined).id).toBe(DEFAULT_ROLE_ID);
    expect(resolveRole(42).id).toBe(DEFAULT_ROLE_ID);
    expect(resolveRole({}).id).toBe(DEFAULT_ROLE_ID);
    // Ne jette jamais (jamais de crash sur inject malveillant côté modèle).
    expect(() => resolveRole("__proto__")).not.toThrow();
    expect(resolveRole("__proto__").id).toBe(DEFAULT_ROLE_ID);
    expect(() => resolveRole("constructor")).not.toThrow();
    expect(resolveRole("constructor").id).toBe(DEFAULT_ROLE_ID);
  });
});

describe("rolesCatalogPrompt", () => {
  it("décrit chaque rôle par son id, son libellé et sa description", () => {
    const block = rolesCatalogPrompt();
    for (const r of listRoles()) {
      expect(block).toContain(`"${r.id}"`);
      expect(block).toContain(r.label);
      expect(block).toContain(r.description);
    }
  });
});

// ── Bloc de contexte borné ─────────────────────────────────────────────────────

const ctx = (over: Partial<ProjectContext> = {}): ProjectContext => ({
  folderPath: "/ws",
  stack: ["Node/TypeScript"],
  tree: ["src/", "src/app.ts"],
  keyFiles: ["package.json"],
  ...over,
});

describe("buildContextBlock", () => {
  it("rend un bloc vide quand il n'y a rien à dire", () => {
    expect(buildContextBlock(ctx({ stack: [], tree: [], keyFiles: [] }))).toBe("");
  });

  it("emballe le contenu dans <project-context>", () => {
    const block = buildContextBlock(ctx());
    expect(block.startsWith("<project-context>")).toBe(true);
    expect(block.endsWith("</project-context>")).toBe(true);
    expect(block).toContain("Stack: Node/TypeScript");
  });

  it("inclut le résumé du fil et les todos", () => {
    const block = buildContextBlock(ctx(), {
      threadSummary: "Refactor de l'auth",
      todos: ["[in_progress] brancher le host"],
    });
    expect(block).toContain("Refactor de l'auth");
    expect(block).toContain("- [in_progress] brancher le host");
  });

  it("reste borné à MAX_CONTEXT_CHARS même avec une arbo énorme", () => {
    const huge = Array.from({ length: 5_000 }, (_, i) => `dir${i}/file${i}.ts`);
    const block = buildContextBlock(ctx({ tree: huge }));
    expect(block.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS);
  });

  it("ignore un résumé de fil vide (espaces)", () => {
    const block = buildContextBlock(ctx(), { threadSummary: "   " });
    expect(block).not.toContain("What the parent already knows");
  });
});
