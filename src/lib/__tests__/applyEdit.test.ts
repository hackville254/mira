import { describe, it, expect } from "vitest";
import { applyEdit, applyEditDetailed } from "../applyEdit";
import { canonicalize, similarity, levenshteinDistance } from "../editMatch";

describe("applyEdit", () => {
  it("replaces an exact match in the middle of the file", () => {
    expect(applyEdit("hello world foo", "world", "WORLD")).toBe("hello WORLD foo");
  });

  it("replaces a match at the start", () => {
    expect(applyEdit("function foo() {}", "function foo", "function bar"))
      .toBe("function bar() {}");
  });

  it("replaces a match at the end", () => {
    expect(applyEdit("const x = 1;", "= 1;", "= 2;")).toBe("const x = 2;");
  });

  it("replaces multi-line original", () => {
    const file = "function foo() {\n  return 1;\n}\n";
    const original = "  return 1;\n";
    const updated  = "  return 42;\n";
    expect(applyEdit(file, original, updated)).toBe("function foo() {\n  return 42;\n}\n");
  });

  it("returns null when the original is not found", () => {
    expect(applyEdit("hello world", "xyz", "XYZ")).toBeNull();
    expect(applyEdit("", "anything", "replaced")).toBeNull();
  });

  it("refuses to edit when the original is ambiguous (multiple occurrences)", () => {
    // Sécurité : appliquer une édition à une occurrence arbitraire est pire que
    // d'échouer. L'agent doit fournir plus de contexte pour lever l'ambiguïté.
    expect(applyEdit("foo foo foo", "foo", "bar")).toBeNull();
  });

  it("uses updated verbatim (does not trim updated)", () => {
    expect(applyEdit("x = 1", "x = 1", "  x = 2  ")).toBe("  x = 2  ");
  });

  it("handles empty updated (deletion)", () => {
    expect(applyEdit("aXb", "X", "")).toBe("ab");
  });

  it("returns null for an empty original", () => {
    expect(applyEdit("abc", "", "PREFIX")).toBeNull();
  });

  it("does not modify file when original not found even with trim", () => {
    expect(applyEdit("function foo() {}", "function bar", "function baz")).toBeNull();
  });
});

describe("applyEdit — tolérance (porté de Cline)", () => {
  it("matches after trimEnd per line (fuzz 100)", () => {
    const file = "function foo() {\n  return 1;\n}\n";
    // Le modèle a laissé des espaces en fin de lignes.
    const original = "function foo() {  \n  return 1;  \n}";
    const res = applyEditDetailed(file, original, "function foo() {\n  return 2;\n}");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.fuzz).toBe(100);
      expect(res.content).toBe("function foo() {\n  return 2;\n}\n");
    }
  });

  it("matches after full trim per line (fuzz 1000)", () => {
    const file = "function foo() {\n    return 1;\n}\n";
    // Indentation différente émise par le modèle.
    const original = "function foo() {\n  return 1;\n}";
    const res = applyEditDetailed(file, original, "function foo() {\n    return 99;\n}");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.fuzz).toBe(1000);
  });

  it("matches typographic punctuation (smart quotes / em-dash)", () => {
    const file = 'const s = "hello" \u2014 world;';
    const original = "const s = \u201Chello\u201D \u2013 world;"; // guillemets courbes + en-dash
    const res = applyEditDetailed(file, original, 'const s = "hi" - world;');
    expect(res.ok).toBe(true);
  });

  it("falls back to Levenshtein similarity ≥ 0.66 for near misses", () => {
    const file = "function computeTotal(items) {\n  return items.length;\n}";
    // Faute de frappe légère : le modèle écrit « compuetTotal ».
    const original = "function compuetTotal(items) {\n  return items.length;\n}";
    const res = applyEditDetailed(file, original, "function computeTotal(items) {\n  return 0;\n}");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.fuzz).toBe(1000);
  });

  it("refuses a match below the similarity threshold", () => {
    const file = "function computeTotal(items) {\n  return items.length;\n}";
    const original = "totally unrelated content here";
    expect(applyEdit(file, original, "x")).toBeNull();
  });

  it("reports ambiguity after canonicalisation too", () => {
    const file = 'a = "x";\nb = "x";\n';
    const original = 'a = \u201Cx\u201D;'; // une seule occurrence canonique → OK
    const res = applyEditDetailed(file, original, 'a = "y";');
    expect(res.ok).toBe(true);
  });
});

describe("editMatch — primitives", () => {
  it("levenshteinDistance basic cases", () => {
    expect(levenshteinDistance("", "")).toBe(0);
    expect(levenshteinDistance("abc", "abc")).toBe(0);
    expect(levenshteinDistance("abc", "abd")).toBe(1);
    expect(levenshteinDistance("kitten", "sitting")).toBe(3);
  });

  it("similarity returns 1 for identical strings", () => {
    expect(similarity("abc", "abc")).toBe(1);
  });

  it("canonicalize normalizes typographic punctuation", () => {
    expect(canonicalize("\u201Cquote\u201D")).toBe('"quote"');
    expect(canonicalize("a\u2014b")).toBe("a-b");
    expect(canonicalize("a\u00A0b")).toBe("a b");
  });
});
