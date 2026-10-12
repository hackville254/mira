import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Faux système de fichiers en mémoire ───────────────────────────────────────
// On simule `../fs` pour tester les opérations de l'explorateur sans backend
// Tauri : déplacement, copie, résolution de collision de noms, garde workspace.
const mockFiles = new Set<string>();
const mockDirs = new Set<string>();

function norm(p: string): string {
  return p.replace(/[/\\]+$/, "");
}

vi.mock("../../fs", () => ({
  readDir: vi.fn(async (path: string) => {
    const base = norm(path);
    const out: { name: string; path: string; is_dir: boolean }[] = [];
    for (const d of mockDirs) {
      if (d !== base && d.startsWith(base + "/")) {
        const rest = d.slice(base.length + 1);
        if (!rest.includes("/")) out.push({ name: rest, path: d, is_dir: true });
      }
    }
    for (const f of mockFiles) {
      if (f.startsWith(base + "/")) {
        const rest = f.slice(base.length + 1);
        if (!rest.includes("/")) out.push({ name: rest, path: f, is_dir: false });
      }
    }
    return out;
  }),
  readFile: vi.fn(async (path: string) => {
    if (!mockFiles.has(norm(path))) throw new Error("not found");
    return "";
  }),
  writeFile: vi.fn(async (path: string) => { mockFiles.add(norm(path)); }),
  createDirCmd: vi.fn(async (path: string) => { mockDirs.add(norm(path)); }),
  deletePath: vi.fn(async (path: string) => {
    const p = norm(path);
    mockFiles.delete(p);
    mockDirs.delete(p);
  }),
  renamePath: vi.fn(async (from: string, to: string) => {
    const f = norm(from);
    const t = norm(to);
    if (mockFiles.has(t) || mockDirs.has(t)) throw new Error(`destination already exists: ${t}`);
    if (mockFiles.delete(f)) mockFiles.add(t);
    else if (mockDirs.delete(f)) mockDirs.add(t);
    else throw new Error("source not found");
  }),
  copyPath: vi.fn(async (from: string, to: string) => {
    const f = norm(from);
    const t = norm(to);
    if (mockFiles.has(t) || mockDirs.has(t)) throw new Error(`destination already exists: ${t}`);
    if (mockFiles.has(f)) mockFiles.add(t);
    else if (mockDirs.has(f)) mockDirs.add(t);
    else throw new Error("source not found");
  }),
  pathExists: vi.fn(async (path: string) => {
    const p = norm(path);
    return mockFiles.has(p) || mockDirs.has(p);
  }),
}));

import { uniquePath, moveInto, copyInto, renameEntry, createFile, type ExplorerOpsCtx } from "../ops";

const ROOT = "/ws";
function makeCtx(): ExplorerOpsCtx & { changed: string[][] } {
  const changed: string[][] = [];
  return { workspaceRoot: ROOT, onChanged: (d) => changed.push(d), changed };
}

beforeEach(() => {
  mockFiles.clear();
  mockDirs.clear();
  mockDirs.add(ROOT);
});

describe("uniquePath", () => {
  it("retourne le nom tel quel s'il est libre", async () => {
    const ctx = makeCtx();
    expect(await uniquePath(ctx, ROOT, "a.txt")).toBe("/ws/a.txt");
  });

  it("ajoute « copy » en cas de collision", async () => {
    mockFiles.add("/ws/a.txt");
    const ctx = makeCtx();
    expect(await uniquePath(ctx, ROOT, "a.txt")).toBe("/ws/a copy.txt");
  });

  it("incrémente « copy 2 » quand « copy » existe aussi", async () => {
    mockFiles.add("/ws/a.txt");
    mockFiles.add("/ws/a copy.txt");
    const ctx = makeCtx();
    expect(await uniquePath(ctx, ROOT, "a.txt")).toBe("/ws/a copy 2.txt");
  });

  it("préserve un nom sans extension", async () => {
    mockFiles.add("/ws/README");
    const ctx = makeCtx();
    expect(await uniquePath(ctx, ROOT, "README")).toBe("/ws/README copy");
  });

  it("respecte les noms réservés du lot courant", async () => {
    const ctx = makeCtx();
    const reserved = new Set<string>();
    const first = await uniquePath(ctx, ROOT, "a.txt", reserved);
    reserved.add(first);
    const second = await uniquePath(ctx, ROOT, "a.txt", reserved);
    expect(first).toBe("/ws/a.txt");
    expect(second).toBe("/ws/a copy.txt");
  });
});

describe("moveInto", () => {
  it("déplace un fichier dans un dossier", async () => {
    mockDirs.add("/ws/sub");
    mockFiles.add("/ws/a.txt");
    const ctx = makeCtx();
    const res = await moveInto(ctx, ["/ws/a.txt"], "/ws/sub");
    expect(res).toEqual([{ ok: true, path: "/ws/sub/a.txt" }]);
    expect(mockFiles.has("/ws/sub/a.txt")).toBe(true);
    expect(mockFiles.has("/ws/a.txt")).toBe(false);
  });

  it("renomme en « copy » en cas de fichier homonyme déjà présent", async () => {
    mockDirs.add("/ws/sub");
    mockFiles.add("/ws/a.txt");
    mockFiles.add("/ws/sub/a.txt");
    const ctx = makeCtx();
    const res = await moveInto(ctx, ["/ws/a.txt"], "/ws/sub");
    expect(res[0]).toEqual({ ok: true, path: "/ws/sub/a copy.txt" });
    expect(mockFiles.has("/ws/sub/a.txt")).toBe(true);      // original préservé
    expect(mockFiles.has("/ws/sub/a copy.txt")).toBe(true);
  });

  it("ignore un fichier déjà dans le dossier cible", async () => {
    mockDirs.add("/ws/sub");
    mockFiles.add("/ws/sub/a.txt");
    const ctx = makeCtx();
    const res = await moveInto(ctx, ["/ws/sub/a.txt"], "/ws/sub");
    expect(res).toEqual([]);
  });

  it("refuse de déplacer un dossier dans son propre sous-arbre", async () => {
    mockDirs.add("/ws/sub");
    mockDirs.add("/ws/sub/inner");
    const ctx = makeCtx();
    const res = await moveInto(ctx, ["/ws/sub"], "/ws/sub/inner");
    expect(res).toEqual([]); // ignoré sans erreur bloquante
  });

  it("refuse une cible hors workspace", async () => {
    const ctx = makeCtx();
    const res = await moveInto(ctx, ["/ws/a.txt"], "/other");
    expect(res[0].ok).toBe(false);
    expect(res[0].error).toMatch(/outside workspace/i);
  });

  it("notifie les dossiers source et cible après déplacement", async () => {
    mockDirs.add("/ws/sub");
    mockFiles.add("/ws/a.txt");
    const ctx = makeCtx();
    await moveInto(ctx, ["/ws/a.txt"], "/ws/sub");
    expect(ctx.changed.flat()).toContain("/ws/sub");
    expect(ctx.changed.flat()).toContain(ROOT);
  });
});

describe("copyInto", () => {
  it("copie sans supprimer la source", async () => {
    mockDirs.add("/ws/sub");
    mockFiles.add("/ws/a.txt");
    const ctx = makeCtx();
    const res = await copyInto(ctx, ["/ws/a.txt"], "/ws/sub");
    expect(res).toEqual([{ ok: true, path: "/ws/sub/a.txt" }]);
    expect(mockFiles.has("/ws/a.txt")).toBe(true);
    expect(mockFiles.has("/ws/sub/a.txt")).toBe(true);
  });

  it("résout la collision sans écraser l'existant", async () => {
    mockDirs.add("/ws/sub");
    mockFiles.add("/ws/a.txt");
    mockFiles.add("/ws/sub/a.txt");
    const ctx = makeCtx();
    const res = await copyInto(ctx, ["/ws/a.txt"], "/ws/sub");
    expect(res[0].path).toBe("/ws/sub/a copy.txt");
  });

  it("accepte une source externe (drop OS) et ne copie que dans le workspace", async () => {
    mockFiles.add("/external/photo.png"); // hors workspace : lisible
    const ctx = makeCtx();
    const res = await copyInto(ctx, ["/external/photo.png"], ROOT);
    expect(res).toEqual([{ ok: true, path: "/ws/photo.png" }]);
    expect(mockFiles.has("/ws/photo.png")).toBe(true);
  });
});

describe("renameEntry & createFile", () => {
  it("renomme un fichier", async () => {
    mockFiles.add("/ws/old.txt");
    const ctx = makeCtx();
    const res = await renameEntry(ctx, "/ws/old.txt", "new.txt");
    expect(res).toEqual({ ok: true, path: "/ws/new.txt" });
    expect(mockFiles.has("/ws/new.txt")).toBe(true);
  });

  it("refuse de renommer vers un nom déjà pris", async () => {
    mockFiles.add("/ws/old.txt");
    mockFiles.add("/ws/taken.txt");
    const ctx = makeCtx();
    const res = await renameEntry(ctx, "/ws/old.txt", "taken.txt");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/already exists/i);
  });

  it("refuse un nom contenant un séparateur", async () => {
    const ctx = makeCtx();
    const res = await createFile(ctx, ROOT, "bad/name.txt");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/invalid/i);
  });

  it("refuse un nom vide", async () => {
    const ctx = makeCtx();
    const res = await createFile(ctx, ROOT, "   ");
    expect(res.ok).toBe(false);
  });
});
