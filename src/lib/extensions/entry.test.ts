import { describe, it, expect } from "vitest";
import { resolveEntry, entryCandidates, normalizeEntryPath } from "./entry";

/**
 * Ces tests couvrent le bug systémique « cannot read entrypoint » : des
 * extensions déclarent `main` sans suffixe `.js` (cas réel ms-python.python →
 * "./out/client/extension" alors que le fichier est "extension.js").
 *
 * Le testeur d'existence est injecté : on simule un système de fichiers par un
 * ensemble de chemins présents, ce qui reproduit fidèlement chaque fixture.
 */

/** Fabrique un `fileExists` à partir d'une liste de fichiers présents. */
function fsWith(files: string[]): (rel: string) => Promise<boolean> {
  const set = new Set(files);
  return async (rel) => set.has(rel);
}

describe("resolveEntry — 3 états", () => {
  it("thème sans `main` → Declarative (jamais une erreur)", async () => {
    // Fixture 1 : thème pur, aucun code.
    const res = await resolveEntry(undefined, fsWith([]));
    expect(res.kind).toBe("declarative");
    expect(res.path).toBeNull();
    expect(res.declared).toBeNull();

    const resNull = await resolveEntry(null, fsWith([]));
    expect(resNull.kind).toBe("declarative");
  });

  it("`main` sans extension mais fichier `.js` présent → Code(chemin .js)", async () => {
    // Fixture 2 : reproduit ms-python.python.
    const res = await resolveEntry("./out/client/extension", fsWith(["out/client/extension.js"]));
    expect(res.kind).toBe("code");
    expect(res.path).toBe("out/client/extension.js");
    expect(res.declared).toBe("./out/client/extension");
  });

  it("`main` déclaré mais introuvable partout → Missing (code non supporté léger)", async () => {
    // Fixture 3 : aucun fichier correspondant.
    const res = await resolveEntry("./dist/bundle", fsWith(["dist/other.js"]));
    expect(res.kind).toBe("missing");
    expect(res.path).toBeNull();
    expect(res.declared).toBe("./dist/bundle");
  });

  it("`main` exact présent → Code(tel quel)", async () => {
    const res = await resolveEntry("./out/extension.js", fsWith(["out/extension.js"]));
    expect(res.kind).toBe("code");
    expect(res.path).toBe("out/extension.js");
  });

  it("convention dossier → index.js", async () => {
    const res = await resolveEntry("./lib", fsWith(["lib/index.js"]));
    expect(res.kind).toBe("code");
    expect(res.path).toBe("lib/index.js");
  });
});

describe("entryCandidates / normalizeEntryPath — sécurité", () => {
  it("ordre des candidats : tel quel, +.js, /index.js", () => {
    expect(entryCandidates("./a/b")).toEqual(["a/b", "a/b.js", "a/b/index.js"]);
  });

  it("rejette un `main` absolu ou remontant (hors dossier extension)", () => {
    expect(normalizeEntryPath("/etc/passwd")).toBeNull();
    expect(normalizeEntryPath("../../evil.js")).toBeNull();
    expect(normalizeEntryPath("a/../../b")).toBeNull();
    expect(entryCandidates("/abs/x")).toEqual([]);
  });

  it("un `main` insalubre ne lit jamais de fichier → Missing", async () => {
    let called = false;
    const res = await resolveEntry("../../secret.js", async () => {
      called = true;
      return true;
    });
    expect(called).toBe(false);
    expect(res.kind).toBe("missing");
  });
});
