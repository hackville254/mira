import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import {
  estimateTokens, estimateTokensWithOverhead, budgetLevel, emergencyTruncateToolResults,
  projectedUsage, shouldPreCompact,
  CHARS_PER_TOKEN, SYSTEM_OVERHEAD_TOKENS, IMAGE_TOKEN_COST,
  COMPACTION_THRESHOLD, CRITICAL_THRESHOLD, DEFAULT_TOKEN_BUDGET,
  EMERGENCY_TOOL_RESULT_MAX_CHARS,
} from "../tokenBudget";

const userMsg = (text: string): ModelMessage => ({ role: "user", content: text });

function toolResultMsg(value: string): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "read_file",
        output: { type: "text", value },
      },
    ],
  } as unknown as ModelMessage;
}

describe("estimateTokens", () => {
  it("compte le texte à chars/4", () => {
    expect(estimateTokens([userMsg("a".repeat(40))])).toBe(40 / CHARS_PER_TOKEN);
  });

  it("ignore le contenu non textuel vide", () => {
    expect(estimateTokens([])).toBe(0);
  });

  it("compte une image à coût forfaitaire (pas la taille base64)", () => {
    const withImage = {
      role: "user",
      content: [{ type: "image", image: "x".repeat(1_000_000) }],
    } as unknown as ModelMessage;
    expect(estimateTokens([withImage])).toBe(IMAGE_TOKEN_COST);
  });
});

describe("estimateTokensWithOverhead", () => {
  it("ajoute le surcoût système pour un budget réaliste", () => {
    const base = estimateTokens([userMsg("a".repeat(40))]);
    expect(estimateTokensWithOverhead([userMsg("a".repeat(40))])).toBe(base + SYSTEM_OVERHEAD_TOKENS);
  });

  it("n'ajoute pas le surcoût pour un budget trop petit", () => {
    const base = estimateTokens([userMsg("a".repeat(40))]);
    expect(estimateTokensWithOverhead([userMsg("a".repeat(40))], 1_000)).toBe(base);
  });
});

describe("budgetLevel", () => {
  it("ok loin du seuil", () => {
    expect(budgetLevel([userMsg("hello")])).toBe("ok");
  });

  it("compact au-delà du seuil de compaction", () => {
    // On vise ~ (seuil × budget) chars après déduction du surcoût système.
    const chars = Math.ceil((COMPACTION_THRESHOLD * DEFAULT_TOKEN_BUDGET - SYSTEM_OVERHEAD_TOKENS + 100) * CHARS_PER_TOKEN);
    expect(budgetLevel([userMsg("a".repeat(chars))])).toBe("compact");
  });

  it("critical au-delà de 95 %", () => {
    const chars = Math.ceil((CRITICAL_THRESHOLD * DEFAULT_TOKEN_BUDGET - SYSTEM_OVERHEAD_TOKENS + 100) * CHARS_PER_TOKEN);
    expect(budgetLevel([userMsg("a".repeat(chars))])).toBe("critical");
  });
});

describe("shouldPreCompact / projectedUsage", () => {
  // Objectif : à chars près, atteindre un usage donné (surcoût système inclus)
  // SANS marge. La marge du tour suivant est ajoutée par `shouldPreCompact`.
  const charsForUsage = (usage: number) =>
    Math.ceil((usage * DEFAULT_TOKEN_BUDGET - SYSTEM_OVERHEAD_TOKENS) * CHARS_PER_TOKEN);

  it("projette l'usage en ajoutant la marge du tour suivant", () => {
    const msgs = [userMsg("a".repeat(40))];
    const base = estimateTokensWithOverhead(msgs) / DEFAULT_TOKEN_BUDGET;
    const margin = 1_000;
    expect(projectedUsage(msgs, margin)).toBeCloseTo(base + margin / DEFAULT_TOKEN_BUDGET, 6);
  });

  it("ne précompacte pas sous le seuil même avec marge", () => {
    const chars = charsForUsage(0.5);
    expect(shouldPreCompact([userMsg("a".repeat(chars))], 1_000)).toBe(false);
  });

  it("précompacte dès que l'usage projeté franchit le seuil", () => {
    // Historique juste sous le seuil : sans marge on resterait « ok », avec marge on franchit.
    const chars = charsForUsage(COMPACTION_THRESHOLD - 0.01);
    const msgs = [userMsg("a".repeat(chars))];
    expect(shouldPreCompact(msgs, 5_000)).toBe(true);
  });

  it("le seuil de compaction est tardif (90 %), aligné sur Cline", () => {
    // Compacter tôt paierait une compaction inutile et casserait le cache de
    // préfixe fournisseur ; on ne le fait qu'à 90 % (cf. Cline 0.9).
    expect(COMPACTION_THRESHOLD).toBe(0.9);
  });
});

describe("emergencyTruncateToolResults", () => {
  it("tronque un gros tool result ancien avec tête + queue + marqueur", () => {
    const big = "A".repeat(EMERGENCY_TOOL_RESULT_MAX_CHARS * 3);
    const msgs = [userMsg("context"), toolResultMsg(big), userMsg("final")];
    const out = emergencyTruncateToolResults(msgs);
    const value = (out[1].content as { output: { value: string } }[])[0].output.value;
    expect(value.length).toBeLessThan(big.length);
    expect(value).toContain("chars truncated for context recovery");
    expect(value.startsWith("A".repeat(10))).toBe(true);
  });

  it("laisse un petit tool result intact", () => {
    const small = "mini";
    const out = emergencyTruncateToolResults([userMsg("ctx"), toolResultMsg(small), userMsg("final")]);
    expect(out[1]).toEqual(toolResultMsg(small));
  });

  it("ne touche jamais au dernier message (tour courant)", () => {
    const big = "B".repeat(EMERGENCY_TOOL_RESULT_MAX_CHARS * 3);
    const out = emergencyTruncateToolResults([userMsg("ctx"), toolResultMsg(big)]);
    // Le dernier message est un tool result : il reste intact.
    const value = (out[1].content as { output: { value: string } }[])[0].output.value;
    expect(value).toBe(big);
  });

  it("laisse les messages système/assistant non-tool inchangés", () => {
    const msgs = [userMsg("a"), { role: "assistant", content: "b" } as ModelMessage];
    expect(emergencyTruncateToolResults(msgs)).toEqual(msgs);
  });
});
