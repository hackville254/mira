import { describe, it, expect } from "vitest";
import {
  findConflictBlocks,
  currentSide,
  incomingSide,
  resolveConflict,
} from "../gitConflict";

const CONFLICT = [
  "line1",
  "<<<<<<< HEAD",
  "our change",
  "=======",
  "their change",
  ">>>>>>> feature",
  "line2",
].join("\n");

describe("findConflictBlocks", () => {
  it("détecte un bloc simple", () => {
    const blocks = findConflictBlocks(CONFLICT);
    expect(blocks).toEqual([{ startLine: 2, separatorLine: 4, endLine: 6 }]);
  });

  it("ne détecte rien sans marqueurs", () => {
    expect(findConflictBlocks("a\nb\nc")).toEqual([]);
  });

  it("détecte plusieurs blocs et les trie", () => {
    const text = [
      "<<<<<<< HEAD",
      "a",
      "=======",
      "b",
      ">>>>>>> x",
      "middle",
      "<<<<<<< HEAD",
      "c",
      "=======",
      "d",
      ">>>>>>> y",
    ].join("\n");
    const blocks = findConflictBlocks(text);
    expect(blocks.map(b => b.startLine)).toEqual([1, 7]);
  });

  it("gère l'imbrication", () => {
    const text = [
      "<<<<<<< HEAD",
      "outer-a",
      "<<<<<<< HEAD",
      "inner-a",
      "=======",
      "inner-b",
      ">>>>>>> inner",
      "=======",
      "outer-b",
      ">>>>>>> outer",
    ].join("\n");
    const blocks = findConflictBlocks(text);
    // Le bloc interne se termine avant l'externe.
    expect(blocks).toHaveLength(2);
    expect(blocks.find(b => b.startLine === 1)?.endLine).toBe(10);
    expect(blocks.find(b => b.startLine === 3)?.endLine).toBe(7);
  });
});

describe("currentSide / incomingSide", () => {
  it("donne les bornes de la section actuelle", () => {
    const [b] = findConflictBlocks(CONFLICT);
    expect(currentSide(b)).toEqual({ firstLine: 3, lastLine: 3 });
  });
  it("donne les bornes de la section entrante", () => {
    const [b] = findConflictBlocks(CONFLICT);
    expect(incomingSide(b)).toEqual({ firstLine: 5, lastLine: 5 });
  });
});

describe("resolveConflict", () => {
  const [block] = findConflictBlocks(CONFLICT);

  it("Accept Current garde notre version", () => {
    const out = resolveConflict(CONFLICT, block, "current");
    expect(out).toBe("line1\nour change\nline2");
  });

  it("Accept Incoming garde la version entrante", () => {
    const out = resolveConflict(CONFLICT, block, "incoming");
    expect(out).toBe("line1\ntheir change\nline2");
  });

  it("Accept Both garde les deux sections dans l'ordre", () => {
    const out = resolveConflict(CONFLICT, block, "both");
    expect(out).toBe("line1\nour change\ntheir change\nline2");
  });

  it("résout plusieurs blocs successivement", () => {
    let text = [
      "a",
      "<<<<<<< HEAD",
      "x",
      "=======",
      "y",
      ">>>>>>> b",
      "c",
      "<<<<<<< HEAD",
      "p",
      "=======",
      "q",
      ">>>>>>> b",
    ].join("\n");
    text = resolveConflict(text, findConflictBlocks(text)[0], "current");
    text = resolveConflict(text, findConflictBlocks(text)[0], "incoming");
    expect(text).toBe("a\nx\nc\nq");
  });
});
