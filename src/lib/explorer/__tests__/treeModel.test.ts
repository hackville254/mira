import { describe, it, expect } from "vitest";
import {
  sepOf, parentOf, baseName, joinPath, normalize,
  isAncestorOrSelf, sortEntries, flattenTree, nextSelection,
} from "../treeModel";
import type { FsEntry } from "../../fs";

const f = (path: string, is_dir = false): FsEntry => ({
  name: path.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? path,
  path,
  is_dir,
});

describe("treeModel · chemins", () => {
  it("sepOf détecte le séparateur Windows", () => {
    expect(sepOf("C:\\dev\\app")).toBe("\\");
    expect(sepOf("/home/dev")).toBe("/");
  });

  it("parentOf retire le dernier segment", () => {
    expect(parentOf("/a/b/c.ts")).toBe("/a/b");
    expect(parentOf("C:\\a\\b")).toBe("C:\\a");
  });

  it("baseName renvoie le dernier segment", () => {
    expect(baseName("/a/b/c.ts")).toBe("c.ts");
    expect(baseName("/a/b/")).toBe("b");
  });

  it("joinPath conserve le séparateur du dossier", () => {
    expect(joinPath("/a/b", "c.ts")).toBe("/a/b/c.ts");
    expect(joinPath("/a/b/", "c.ts")).toBe("/a/b/c.ts");
    expect(joinPath("C:\\a", "c.ts")).toBe("C:\\a\\c.ts");
  });

  it("normalize retire les séparateurs de fin", () => {
    expect(normalize("/a/b/")).toBe("/a/b");
  });
});

describe("treeModel · isAncestorOrSelf (garde anti-évasion)", () => {
  it("accepte le chemin lui-même et un descendant", () => {
    expect(isAncestorOrSelf("/ws/a.ts", "/ws")).toBe(true);
    expect(isAncestorOrSelf("/ws/sub/a.ts", "/ws")).toBe(true);
  });

  it("rejette un frère au préfixe trompeur (wsX vs ws)", () => {
    expect(isAncestorOrSelf("/workspace-other/a.ts", "/workspace")).toBe(false);
  });

  it("rejette un chemin hors du dossier", () => {
    expect(isAncestorOrSelf("/etc/passwd", "/ws")).toBe(false);
  });
});

describe("treeModel · sortEntries", () => {
  it("place les dossiers avant les fichiers, puis A→Z insensible à la casse", () => {
    const out = sortEntries([f("/r/b.ts"), f("/r/Alpha", true), f("/r/a.ts"), f("/r/zeta", true)]);
    expect(out.map(e => e.name)).toEqual(["Alpha", "zeta", "a.ts", "b.ts"]);
  });
});

describe("treeModel · flattenTree", () => {
  const root = [f("/r/src", true), f("/r/README.md")];
  const kids: Record<string, FsEntry[]> = {
    "/r/src": [f("/r/src/index.ts"), f("/r/src/lib", true)],
    "/r/src/lib": [f("/r/src/lib/util.ts")],
  };

  it("n'affiche que les dossiers dépliés et leurs descendants", () => {
    const rows = flattenTree(root, new Set(["/r/src"]), p => kids[p]);
    expect(rows.map(r => r.entry.path)).toEqual(["/r/src", "/r/src/index.ts", "/r/src/lib", "/r/README.md"]);
    expect(rows.find(r => r.entry.path === "/r/src/lib")?.open).toBe(false);
  });

  it("descend récursivement quand les sous-dossiers sont dépliés", () => {
    const rows = flattenTree(root, new Set(["/r/src", "/r/src/lib"]), p => kids[p]);
    expect(rows.map(r => r.entry.path)).toEqual([
      "/r/src", "/r/src/index.ts", "/r/src/lib", "/r/src/lib/util.ts", "/r/README.md",
    ]);
  });

  it("gère un dossier vide déplié sans planter", () => {
    const rows = flattenTree([f("/r/empty", true)], new Set(["/r/empty"]), () => []);
    expect(rows.map(r => r.entry.path)).toEqual(["/r/empty"]);
  });
});

describe("treeModel · nextSelection", () => {
  const visible = ["/a", "/b", "/c", "/d"];

  it("clic simple : sélection unique + ancre", () => {
    const { selected, anchor } = nextSelection(visible, new Set(), null, "/b", {});
    expect([...selected]).toEqual(["/b"]);
    expect(anchor).toBe("/b");
  });

  it("Cmd/Ctrl+clic : bascule unitaire", () => {
    const r1 = nextSelection(visible, new Set(["/a"]), "/a", "/c", { meta: true });
    expect([...r1.selected].sort()).toEqual(["/a", "/c"]);
    const r2 = nextSelection(visible, r1.selected, r1.anchor, "/a", { meta: true });
    expect([...r2.selected]).toEqual(["/c"]);
  });

  it("Shift+clic : sélectionne la plage depuis l'ancre", () => {
    const { selected } = nextSelection(visible, new Set(["/b"]), "/b", "/d", { shift: true });
    expect([...selected]).toEqual(["/b", "/c", "/d"]);
  });

  it("Shift+clic inversé (vers le haut) fonctionne aussi", () => {
    const { selected } = nextSelection(visible, new Set(["/d"]), "/d", "/b", { shift: true });
    expect([...selected]).toEqual(["/b", "/c", "/d"]);
  });

  it("Shift sans ancre connue retombe sur une sélection simple", () => {
    const { selected } = nextSelection(visible, new Set(), null, "/c", { shift: true });
    expect([...selected]).toEqual(["/c"]);
  });
});
