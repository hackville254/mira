/**
 * Lot D — Tests du gate de TERMINAISON.
 *
 * Vérifie la seule règle qui compte : on refuse une clôture « succès » NON
 * PROUVÉE (écriture sans vérification), et on accepte tout le reste. Le gate ne
 * doit JAMAIS bloquer quand la vérification est impossible, quand l'utilisateur
 * est déjà sollicité, ou quand il a déjà été déclenché (pas de boucle).
 */

import { describe, it, expect } from "vitest";

import {
  claimsSuccess,
  isVerificationCommand,
  shouldBlockForVerification,
  VERIFY_BEFORE_FINISH_REMINDER,
  type TurnFacts,
} from "../terminationGate";

/** Faits « par défaut » : le cas normal d'un tour qui écrit et vérifie. */
const base: TurnFacts = {
  wroteWorkspace: true,
  ranVerification: true,
  askedUser: false,
  qualityToolsAvailable: true,
  guardFired: false,
};

describe("isVerificationCommand — détection des commandes de contrôle", () => {
  it("reconnaît les runners JS/TS", () => {
    expect(isVerificationCommand("npx tsc --noEmit")).toBe(true);
    expect(isVerificationCommand("npx vitest run src/lib")).toBe(true);
    expect(isVerificationCommand("npm test")).toBe(true);
    expect(isVerificationCommand("pnpm run lint")).toBe(true);
    expect(isVerificationCommand("yarn build")).toBe(true);
  });

  it("reconnaît les runners Rust / Python / Go", () => {
    expect(isVerificationCommand("cargo check")).toBe(true);
    expect(isVerificationCommand("cargo test --workspace")).toBe(true);
    expect(isVerificationCommand("pytest -q")).toBe(true);
    expect(isVerificationCommand("python -m mypy src")).toBe(true);
    expect(isVerificationCommand("go build ./...")).toBe(true);
    expect(isVerificationCommand("go test ./...")).toBe(true);
  });

  it("ne confond PAS une commande banale avec une vérification", () => {
    expect(isVerificationCommand("ls -la")).toBe(false);
    expect(isVerificationCommand("git status")).toBe(false);
    expect(isVerificationCommand("npm install")).toBe(false);
    expect(isVerificationCommand("cat package.json")).toBe(false);
    expect(isVerificationCommand("")).toBe(false);
  });

  it("détecte la vérification même noyée dans un enchaînement", () => {
    expect(isVerificationCommand("cd app && npm run typecheck")).toBe(true);
    expect(isVerificationCommand("cargo fmt && cargo clippy")).toBe(true);
  });
});

describe("claimsSuccess — détection d'une affirmation de succès", () => {
  it("repère les conclusions positives (anglais et français)", () => {
    expect(claimsSuccess("Done. The feature is implemented.")).toBe(true);
    expect(claimsSuccess("I've fixed the bug and all tests pass.")).toBe(true);
    expect(claimsSuccess("C'est fait, le build passe maintenant.")).toBe(true);
    expect(claimsSuccess("Everything works now.")).toBe(true);
  });

  it("ne déclenche PAS sur une description neutre / un aveu d'échec", () => {
    expect(claimsSuccess("I changed the file. Verification is not available here.")).toBe(false);
    expect(claimsSuccess("This is not done yet; I could not run the tests.")).toBe(false);
    expect(claimsSuccess("")).toBe(false);
  });
});

describe("shouldBlockForVerification — décision du gate", () => {
  it("REFUSE une clôture succès non prouvée après écriture", () => {
    const d = shouldBlockForVerification("Done, the fix is in place.", {
      ...base,
      ranVerification: false,
    });
    expect(d.action).toBe("verify");
    if (d.action === "verify") {
      expect(d.reminder).toBe(VERIFY_BEFORE_FINISH_REMINDER);
    }
  });

  it("ACCEPTE quand une vérification a été exécutée", () => {
    expect(shouldBlockForVerification("Done, all tests pass.", base).action).toBe("allow");
  });

  it("ACCEPTE quand le tour n'a rien écrit (lecture seule)", () => {
    expect(
      shouldBlockForVerification("Done, here is my analysis.", { ...base, wroteWorkspace: false, ranVerification: false }).action,
    ).toBe("allow");
  });

  it("ACCEPTE quand l'utilisateur est déjà sollicité (question posée)", () => {
    expect(
      shouldBlockForVerification("Done for now.", { ...base, ranVerification: false, askedUser: true }).action,
    ).toBe("allow");
  });

  it("ACCEPTE quand la vérification est IMPOSSIBLE (pas d'outillage)", () => {
    expect(
      shouldBlockForVerification("Done.", { ...base, ranVerification: false, qualityToolsAvailable: false }).action,
    ).toBe("allow");
  });

  it("ne bloque QU'UNE fois : pas de boucle après relance", () => {
    expect(
      shouldBlockForVerification("Done.", { ...base, ranVerification: false, guardFired: true }).action,
    ).toBe("allow");
  });

  it("ACCEPTE un tour sans affirmation de succès", () => {
    expect(
      shouldBlockForVerification("I edited the file. Tests are not available.", { ...base, ranVerification: false }).action,
    ).toBe("allow");
  });
});
