import { describe, it, expect } from "vitest";
import { assignLevels, type BracketToken } from "../bracketColorCm6";

/** Construit des tokens brackets à partir d'une chaîne (positions séquentielles). */
function tokensOf(s: string): BracketToken[] {
  const out: BracketToken[] = [];
  for (let i = 0; i < s.length; i++) {
    out.push({ from: i, to: i + 1, ch: s[i] });
  }
  return out;
}

/** Réduit la sortie en chaîne du type "(A)B" pour des assertions lisibles. */
function levelsOf(s: string): string {
  return assignLevels(tokensOf(s))
    .map(({ token, level }) => `${token.ch}${level}`)
    .join(" ");
}

describe("assignLevels", () => {
  it("colore une paire simple au niveau 0", () => {
    expect(levelsOf("()")).toBe("(0 )0");
  });

  it("incrémente le niveau à chaque imbrication", () => {
    expect(levelsOf("(())")).toBe("(0 (1 )1 )0");
  });

  it("gère des délimiteurs de types différents", () => {
    expect(levelsOf("[{()}]")).toBe("[0 {1 (2 )2 }1 ]0");
  });

  it("repart au niveau 0 après fermeture", () => {
    expect(levelsOf("()()")).toBe("(0 )0 (0 )0");
  });

  it("gère une fermeture orpheline sans planter", () => {
    expect(levelsOf(")(")).toBe(")0 (0");
  });

  it("ignore les tokens qui ne sont pas des délimiteurs", () => {
    // Seuls les brackets comptent ; les lettres n'ont pas de niveau.
    expect(levelsOf("a(b)")).toBe("(0 )0");
  });
});
