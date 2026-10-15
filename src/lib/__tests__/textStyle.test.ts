import { describe, it, expect } from "vitest";
import { sanitizeProse } from "../textStyle";

// ── Nettoyage défensif de la prose générée par le modèle ──────────────────────

describe("sanitizeProse", () => {
  it("retire les emojis décoratifs de la prose", () => {
    expect(sanitizeProse("Fait 📋 et vérifié ✅")).toBe("Fait et vérifié");
  });

  it("normalise les tirets longs (em/en) en tiret simple", () => {
    expect(sanitizeProse("a — b")).toBe("a - b");
    expect(sanitizeProse("a – b")).toBe("a - b");
    expect(sanitizeProse("a—b")).toBe("a-b");
  });

  it("préserve les blocs de code et le code inline intacts", () => {
    const md = "Texte — propre\n\n```ts\nconst a = 1; // — gardé\n```\n\n`x—y`";
    const out = sanitizeProse(md);
    expect(out).toContain("Texte - propre");
    expect(out).toContain("const a = 1; // — gardé");
    expect(out).toContain("`x—y`");
  });

  it("ne modifie pas un contenu sans emoji ni tiret long", () => {
    const s = "Juste du texte normal avec un - tiret.";
    expect(sanitizeProse(s)).toBe(s);
  });
});
