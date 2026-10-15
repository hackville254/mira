import { describe, it, expect } from "vitest";
import { truncateMiddle, clampToolResult, MAX_TOOL_RESULT_CHARS } from "../outputLimits";

describe("truncateMiddle", () => {
  it("ne touche pas un texte sous le plafond", () => {
    const s = "court";
    expect(truncateMiddle(s, 100, "hint")).toBe(s);
  });

  it("ne dépasse jamais le plafond demandé", () => {
    const big = "A".repeat(50_000);
    const out = truncateMiddle(big, 8_000, "hint");
    expect(out.length).toBeLessThanOrEqual(8_000);
  });

  it("garde la tête ET la queue (élision médiane)", () => {
    const big = "H" + "M".repeat(20_000) + "T";
    const out = truncateMiddle(big, 1_000, "hint");
    expect(out.startsWith("H")).toBe(true);
    expect(out.endsWith("T")).toBe(true);
  });

  it("place la notice de récupération dans une zone CONSERVÉE (tête)", () => {
    const big = "X".repeat(20_000);
    const out = truncateMiddle(big, 1_000, "Re-run narrower.");
    // La notice doit survivre à une coupe ultérieure → présente tôt dans la tête.
    expect(out.slice(0, 1_000)).toContain("Re-run narrower.");
  });

  it("rapporte le nombre de caractères élidés", () => {
    const big = "Y".repeat(10_000);
    const out = truncateMiddle(big, 2_000, "hint");
    expect(out).toMatch(/\[\d+ characters elided\. hint\]/);
  });
});

describe("clampToolResult", () => {
  it("laisse passer null / undefined", () => {
    expect(clampToolResult(null)).toBeNull();
    expect(clampToolResult(undefined)).toBeUndefined();
  });

  it("tronque une longue chaîne", () => {
    const big = "Z".repeat(100_000);
    const out = clampToolResult(big) as string;
    expect(out.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
    expect(out).toContain("characters elided");
  });

  it("ne tronque PAS un court résultat", () => {
    const small = { path: "a.ts", content: "hello" };
    expect(clampToolResult(small)).toEqual(small);
  });

  it("préserve la STRUCTURE d'un objet et ne tronque que les champs texte longs", () => {
    const obj = { path: "src/index.ts", content: "C".repeat(100_000), lineCount: 42 };
    const out = clampToolResult(obj) as Record<string, unknown>;
    // Structure intacte : les clés courtes restent telles quelles.
    expect(out.path).toBe("src/index.ts");
    expect(out.lineCount).toBe(42);
    // Seul le champ volumineux est élidé.
    expect((out.content as string).length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
    expect(out.content as string).toContain("characters elided");
  });

  it("tronque un tableau volumineux via sa sérialisation JSON", () => {
    const arr = Array.from({ length: 5_000 }, (_, i) => ({ i, name: `item-${i}` }));
    const out = clampToolResult(arr) as string;
    expect(typeof out).toBe("string");
    expect((out as string).length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
  });

  it("respecte un plafond personnalisé", () => {
    const big = "Q".repeat(5_000);
    const out = clampToolResult(big, 500) as string;
    expect(out.length).toBeLessThanOrEqual(500);
  });
});
