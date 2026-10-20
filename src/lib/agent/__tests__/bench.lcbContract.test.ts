// ── Tests — contrat de sortie LiveCodeBench ───────────────────────────────────
//
// Ces tests portent sur la CAUSE RACINE des 4/12 : l'ancien évaluateur imposait
// `class Solution` à tous les problèmes, y compris les 6 AtCoder (starter vide)
// qui exigent un programme complet sur stdin. Fixtures issues de la forme RÉELLE
// des problèmes (`abc335_a` : `'hello2023\n' → 'hello2024\n'`).

import { describe, it, expect } from "vitest";
import {
  detectContract,
  isInteractive,
  judgeEqual,
  normalizeJudgeOutput,
} from "../../../../bench/coding/livecodebench/contract";
import { buildRunner } from "../../../../bench/coding/livecodebench/evaluator";
import type { LcbInstance } from "../../../../bench/coding/livecodebench/instance";

function inst(over: Partial<LcbInstance>): LcbInstance {
  return {
    question_id: "x",
    question_title: "",
    question_content: "",
    platform: "leetcode",
    contest_id: "",
    contest_date: "",
    difficulty: "easy",
    starter_code: "",
    cases: [],
    ...over,
  };
}

describe("detectContract — format attendu par problème", () => {
  it("détecte le contrat fonctionnel (LeetCode, class Solution)", () => {
    const i = inst({
      question_id: "3228",
      platform: "leetcode",
      starter_code: "class Solution:\n    def maxOperations(self, s: str) -> int:\n        ",
    });
    expect(detectContract(i)).toBe("functional");
  });

  it("détecte le contrat stdin (AtCoder, starter vide)", () => {
    const i = inst({
      question_id: "abc335_a",
      platform: "atcoder",
      starter_code: "",
      cases: [{ input: "hello2023\n", output: "hello2024\n" }],
    });
    expect(detectContract(i)).toBe("stdin");
  });

  it("détecte Codeforces comme stdin", () => {
    expect(detectContract(inst({ platform: "codeforces", starter_code: "" }))).toBe("stdin");
  });

  it("classe un problème interactif comme `interactive` (abc337_e réel)", () => {
    const i = inst({
      question_id: "abc337_e",
      platform: "atcoder",
      starter_code: "",
      question_content:
        "This is an interactive problem (a type of problem where your program interacts with the judge program through Standard Input and Output).",
    });
    expect(isInteractive(i)).toBe(true);
    expect(detectContract(i)).toBe("interactive");
  });

  it("n'invente jamais `stdin` pour un problème fonctionnel sans plateforme connue mais avec class", () => {
    const i = inst({ platform: "unknown", starter_code: "class Solution:\n    def f(self): pass" });
    expect(detectContract(i)).toBe("functional");
  });

  it("utilise la forme des cas en dernier recours (texte brut ⇒ stdin)", () => {
    const i = inst({
      platform: "unknown",
      starter_code: "",
      cases: [{ input: "hello2023\n", output: "hello2024\n" }],
    });
    expect(detectContract(i)).toBe("stdin");
  });

  it("reste fonctionnel si les cas sont des littéraux Python", () => {
    const i = inst({
      platform: "unknown",
      starter_code: "",
      cases: [{ input: "[1, 2, 3]\n2\n", output: "5\n" }],
    });
    expect(detectContract(i)).toBe("functional");
  });
});

describe("buildRunner — le bon runner selon le contrat", () => {
  it("produit un runner stdin (subprocess) pour AtCoder", () => {
    const i = inst({
      platform: "atcoder",
      starter_code: "",
      cases: [{ input: "hello2023\n", output: "hello2024\n" }],
    });
    const r = buildRunner(i);
    expect(r).toContain("subprocess.run");
    expect(r).toContain("_judge_equal");
    expect(r).not.toContain("from solution import Solution");
  });

  it("produit un runner fonctionnel (Solution) pour LeetCode", () => {
    const i = inst({
      platform: "leetcode",
      starter_code: "class Solution:\n    def twoSum(self):\n        ",
      cases: [{ input: "[2,7]\n9\n", output: "[0,1]\n" }],
    });
    const r = buildRunner(i);
    expect(r).toContain("from solution import Solution");
    expect(r).not.toContain("subprocess.run");
  });
});

describe("comparaison de sortie (juge)", () => {
  it("ignore les espaces de fin de ligne", () => {
    expect(judgeEqual("1 2 3  \n", "1 2 3\n")).toBe(true);
  });

  it("ignore les lignes vides finales", () => {
    expect(judgeEqual("1 0\n\n\n", "1 0\n")).toBe(true);
  });

  it("détecte une vraie différence", () => {
    expect(judgeEqual("hello2023\n", "hello2024\n")).toBe(false);
  });

  it("normalise les CRLF", () => {
    expect(normalizeJudgeOutput("a\r\nb\r\n")).toBe("a\nb");
  });
});
