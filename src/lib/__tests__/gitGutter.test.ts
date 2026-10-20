import { describe, it, expect } from "vitest";
import { computeLineChanges, relativeToRoot, type LineChange } from "../gitGutter";

/** Réduit en map ligne→kind pour des assertions simples. */
function toMap(changes: LineChange[]): Record<number, string> {
  const m: Record<number, string> = {};
  for (const c of changes) m[c.line] = c.kind;
  return m;
}

describe("computeLineChanges", () => {
  it("ne signale rien quand le contenu est identique", () => {
    expect(computeLineChanges("a\nb\nc", "a\nb\nc")).toEqual([]);
  });

  it("marque une ligne modifiée", () => {
    const m = toMap(computeLineChanges("a\nb\nc", "a\nB\nc"));
    expect(m).toEqual({ 2: "modified" });
  });

  it("marque une ligne ajoutée en fin de fichier", () => {
    const m = toMap(computeLineChanges("a\nb", "a\nb\nc"));
    expect(m).toEqual({ 3: "added" });
  });

  it("marque une suppression sur la ligne de frontière", () => {
    const m = toMap(computeLineChanges("a\nb\nc", "a\nc"));
    expect(m).toEqual({ 2: "deleted" });
  });

  it("marque plusieurs lignes ajoutées", () => {
    const m = toMap(computeLineChanges("a", "a\nb\nc"));
    expect(m).toEqual({ 2: "added", 3: "added" });
  });

  it("normalise les CRLF avant comparaison", () => {
    // Même contenu logique, fins de ligne différentes → aucune différence.
    expect(computeLineChanges("a\r\nb\r\nc", "a\nb\nc")).toEqual([]);
  });

  it("renvoie les changements triés par ligne", () => {
    const changes = computeLineChanges("a\nb\nc\nd", "a\nX\nc\nd\ne");
    const lines = changes.map(c => c.line);
    expect(lines).toEqual([...lines].sort((x, y) => x - y));
  });
});

describe("relativeToRoot", () => {
  it("renvoie le chemin relatif simple", () => {
    expect(relativeToRoot("/root", "/root/src/a.ts")).toBe("src/a.ts");
  });

  it("tolère un slash final sur la racine", () => {
    expect(relativeToRoot("/root/", "/root/a.ts")).toBe("a.ts");
  });

  it("renvoie une chaîne vide pour la racine elle-même", () => {
    expect(relativeToRoot("/root", "/root")).toBe("");
  });

  it("renvoie null hors de la racine", () => {
    expect(relativeToRoot("/root", "/other/a.ts")).toBeNull();
  });

  it("ne confond pas un préfixe partiel avec la racine", () => {
    // `/rootX` ne doit pas être considéré comme situé sous `/root`.
    expect(relativeToRoot("/root", "/rootX/a.ts")).toBeNull();
  });

  it("normalise les séparateurs Windows", () => {
    expect(relativeToRoot("C:\\proj", "C:\\proj\\src\\a.ts")).toBe("src/a.ts");
  });
});
