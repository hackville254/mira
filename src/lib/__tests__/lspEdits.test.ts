import { describe, it, expect } from "vitest";
import {
  lspPosToOffset,
  offsetToLspPos,
  applyLspEdits,
  flattenWorkspaceEdit,
  type LspWorkspaceEdit,
} from "../lspEdits";

describe("lspPosToOffset", () => {
  it("maps the origin to offset 0", () => {
    expect(lspPosToOffset("abc\ndef", { line: 0, character: 0 })).toBe(0);
  });

  it("maps a position on the first line", () => {
    expect(lspPosToOffset("abc\ndef", { line: 0, character: 2 })).toBe(2);
  });

  it("accounts for the newline separator between lines", () => {
    // "abc\n" = 4 chars, then character 1 → offset 5
    expect(lspPosToOffset("abc\ndef", { line: 1, character: 1 })).toBe(5);
  });

  it("clamps a character beyond the line length", () => {
    expect(lspPosToOffset("abc\ndef", { line: 0, character: 99 })).toBe(3);
  });

  it("clamps a line beyond the document to the last line", () => {
    // line 9 → clamped to line 0; character 1 → offset 1
    expect(lspPosToOffset("abc", { line: 9, character: 1 })).toBe(1);
  });
});

describe("offsetToLspPos", () => {
  it("maps offset 0 to the origin", () => {
    expect(offsetToLspPos("abc\ndef", 0)).toEqual({ line: 0, character: 0 });
  });

  it("maps an offset right after a newline to the next line start", () => {
    expect(offsetToLspPos("abc\ndef", 4)).toEqual({ line: 1, character: 0 });
  });

  it("clamps an offset beyond the text", () => {
    expect(offsetToLspPos("abc", 99)).toEqual({ line: 0, character: 3 });
  });

  it("round-trips with lspPosToOffset", () => {
    const text = "const x = 1;\nconst y = 2;\n";
    for (let off = 0; off <= text.length; off++) {
      const pos = offsetToLspPos(text, off);
      expect(lspPosToOffset(text, pos)).toBe(off);
    }
  });
});

describe("applyLspEdits", () => {
  it("applies a single in-line edit", () => {
    const out = applyLspEdits("const x = 1;", [
      { range: { start: { line: 0, character: 10 }, end: { line: 0, character: 11 } }, newText: "2" },
    ]);
    expect(out).toBe("const x = 2;");
  });

  it("applies multiple edits regardless of their order (end → start)", () => {
    // Given in ascending order, the helper must still not corrupt offsets.
    const out = applyLspEdits("aaa bbb ccc", [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "XXX" },
      { range: { start: { line: 0, character: 8 }, end: { line: 0, character: 11 } }, newText: "ZZZ" },
      { range: { start: { line: 0, character: 4 }, end: { line: 0, character: 7 } }, newText: "YYY" },
    ]);
    expect(out).toBe("XXX YYY ZZZ");
  });

  it("handles insertions with an empty range", () => {
    const out = applyLspEdits("ab", [
      { range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } }, newText: "X" },
    ]);
    expect(out).toBe("aXb");
  });

  it("handles deletions with empty newText", () => {
    const out = applyLspEdits("aXb", [
      { range: { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } }, newText: "" },
    ]);
    expect(out).toBe("ab");
  });

  it("works across multiple lines", () => {
    const out = applyLspEdits("line1\nline2\nline3\n", [
      { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } }, newText: "LINE2" },
    ]);
    expect(out).toBe("line1\nLINE2\nline3\n");
  });
});

describe("flattenWorkspaceEdit", () => {
  const identity = (uri: string) => uri;

  it("flattens a `changes` map into file edits", () => {
    const edit: LspWorkspaceEdit = {
      changes: {
        "file:///a.ts": [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "A" }],
        "file:///b.ts": [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "B" }],
      },
    };
    const files = flattenWorkspaceEdit(edit, identity).sort((a, b) => a.path.localeCompare(b.path));
    expect(files.map(f => f.path)).toEqual(["file:///a.ts", "file:///b.ts"]);
    expect(files[0].edits).toHaveLength(1);
  });

  it("flattens `documentChanges` entries", () => {
    const edit: LspWorkspaceEdit = {
      documentChanges: [
        {
          textDocument: { uri: "file:///c.ts" },
          edits: [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } }, newText: "C" }],
        },
      ],
    };
    const files = flattenWorkspaceEdit(edit, identity);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("file:///c.ts");
    expect(files[0].edits[0].newText).toBe("C");
  });

  it("merges edits targeting the same file across `changes` and `documentChanges`", () => {
    const edit: LspWorkspaceEdit = {
      changes: {
        "file:///d.ts": [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "X" }],
      },
      documentChanges: [
        {
          textDocument: { uri: "file:///d.ts" },
          edits: [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } }, newText: "Y" }],
        },
      ],
    };
    const files = flattenWorkspaceEdit(edit, identity);
    expect(files).toHaveLength(1);
    expect(files[0].edits).toHaveLength(2);
  });

  it("drops entries with no edits", () => {
    const edit: LspWorkspaceEdit = { changes: { "file:///e.ts": [] } };
    expect(flattenWorkspaceEdit(edit, identity)).toEqual([]);
  });

  it("returns an empty array for an empty edit", () => {
    expect(flattenWorkspaceEdit({}, identity)).toEqual([]);
  });
});