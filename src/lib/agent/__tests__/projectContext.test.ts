import { describe, it, expect, beforeEach, vi } from "vitest";

// `getProjectContext` lit le disque via la commande Tauri `read_dir`. On la
// remplace par un stub contrôlable : chaque `folderPath` renvoie une racine
// distincte, ce qui permet d'observer le cloisonnement du cache par session.
const readDirMock = vi.fn(async (args: { path: string }) => {
  const p = args.path;
  if (p === "/proj-x" || p === "/proj-x/sub") {
    return [{ name: "package.json", path: `${p}/package.json`, is_dir: false }];
  }
  return [];
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: { path: string }) =>
    cmd === "read_dir" ? readDirMock(args) : Promise.resolve([]),
}));

import {
  getProjectContext,
  resetProjectContext,
  buildContextBlock,
  DEFAULT_CONTEXT_KEY,
  type ProjectContext,
} from "../projectContext";

beforeEach(() => {
  readDirMock.mockClear();
  resetProjectContext();
});

describe("projectContext — cache par session (multitasking)", () => {
  it("met en cache le contexte d'une session (un seul walk)", async () => {
    const a = await getProjectContext("/proj-x", "sess-A");
    const callsAfterFirst = readDirMock.mock.calls.length;
    const b = await getProjectContext("/proj-x", "sess-A");
    expect(b).toBe(a);
    expect(readDirMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it("isole les caches de deux sessions", async () => {
    const a = await getProjectContext("/proj-x", "sess-A");
    const b = await getProjectContext("/proj-x", "sess-B");
    // Deux entrées distinctes, mais un contenu identique (même dossier).
    expect(b).not.toBe(a);
    expect(b.folderPath).toBe(a.folderPath);
    expect(b.stack).toEqual(a.stack);
  });

  it("resetProjectContext(session) ne purge QUE cette session", async () => {
    const a1 = await getProjectContext("/proj-x", "sess-A");
    await getProjectContext("/proj-x", "sess-B");

    resetProjectContext("sess-A");

    // A est recalculé (nouvelle référence) ; B reste en cache (même référence).
    const bCached = await getProjectContext("/proj-x", "sess-B");
    const a2 = await getProjectContext("/proj-x", "sess-A");
    expect(a2).not.toBe(a1);
    expect(bCached).toBe(await getProjectContext("/proj-x", "sess-B"));
  });

  it("recalcule quand le folderPath change pour la même session", async () => {
    const a = await getProjectContext("/proj-x", "sess-A");
    const other = await getProjectContext("/other", "sess-A");
    expect(other).not.toBe(a);
    expect(other.folderPath).toBe("/other");
  });

  it("resetProjectContext() sans clé purge toutes les sessions", async () => {
    const a1 = await getProjectContext("/proj-x", "sess-A");
    resetProjectContext();
    const a2 = await getProjectContext("/proj-x", "sess-A");
    expect(a2).not.toBe(a1);
  });

  it("utilise une clé par défaut quand aucune session n'est fournie", async () => {
    const a = await getProjectContext("/proj-x");
    const b = await getProjectContext("/proj-x", DEFAULT_CONTEXT_KEY);
    expect(b).toBe(a);
  });

  it("ne jette jamais même si read_dir échoue", async () => {
    readDirMock.mockRejectedValueOnce(new Error("boom"));
    const ctx = await getProjectContext("/proj-x", "sess-err");
    expect(ctx).toBeDefined();
    expect(ctx.folderPath).toBe("/proj-x");
  });
});

describe("buildContextBlock — borne dure", () => {
  it("borne le bloc à MAX_CONTEXT_CHARS même avec un arbre énorme", () => {
    const ctx: ProjectContext = {
      folderPath: "/big",
      stack: ["Node/TypeScript"],
      tree: Array.from({ length: 5000 }, (_, i) => `src/deep/dir-${i}/file-${i}.ts`),
      keyFiles: ["package.json", "tsconfig.json"],
    };
    const block = buildContextBlock(ctx, { threadSummary: "x".repeat(10_000) });
    expect(block.length).toBeLessThanOrEqual(2400);
    expect(block.startsWith("<project-context>")).toBe(true);
    expect(block.endsWith("</project-context>")).toBe(true);
  });
});
