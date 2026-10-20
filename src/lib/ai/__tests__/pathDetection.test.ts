import { describe, it, expect } from "vitest";
import { looksLikePath, guessPathKind, extractPathTokens } from "../pathDetection";

describe("looksLikePath", () => {
  it("accepte les chemins absolus POSIX", () => {
    expect(looksLikePath("/Users/moi/projets/api")).toBe(true);
    expect(looksLikePath("/etc/hosts")).toBe(true);
  });

  it("accepte les chemins absolus Windows", () => {
    expect(looksLikePath("C:\\Users\\moi\\api")).toBe(true);
    expect(looksLikePath("C:/Users/moi/api")).toBe(true);
  });

  it("accepte les chemins relatifs explicites", () => {
    expect(looksLikePath("./src/index.ts")).toBe(true);
    expect(looksLikePath("../lib/db.ts")).toBe(true);
  });

  it("accepte les chemins relatifs de projet avec extension", () => {
    expect(looksLikePath("src/lib/db.ts")).toBe(true);
    expect(looksLikePath("src/components/ai/AiPanel.tsx")).toBe(true);
  });

  it("accepte un dossier relatif terminé par un séparateur", () => {
    expect(looksLikePath("src/components/")).toBe(true);
  });

  it("refuse les URL et les schémas", () => {
    expect(looksLikePath("https://example.com/a/b")).toBe(false);
    expect(looksLikePath("mailto:a@b.com")).toBe(false);
    expect(looksLikePath("data:text/plain,hello")).toBe(false);
  });

  it("refuse les mots ordinaires et les faux positifs", () => {
    expect(looksLikePath("bonjour")).toBe(false);
    expect(looksLikePath("et/ou")).toBe(false);
    expect(looksLikePath("1/2")).toBe(false);
    expect(looksLikePath("")).toBe(false);
  });

  it("refuse un chemin contenant des espaces internes", () => {
    expect(looksLikePath("/Users/moi/mon dossier")).toBe(false);
  });
});

describe("guessPathKind", () => {
  it("détecte un dossier par séparateur final", () => {
    expect(guessPathKind("src/components/")).toBe("dir");
    expect(guessPathKind("/Users/moi/api/")).toBe("dir");
  });

  it("détecte un fichier par extension terminale", () => {
    expect(guessPathKind("src/lib/db.ts")).toBe("file");
    expect(guessPathKind("/etc/hosts.txt")).toBe("file");
  });

  it("renvoie unknown sans indice formel", () => {
    expect(guessPathKind("src/lib")).toBe("unknown");
  });
});

describe("extractPathTokens", () => {
  it("extrait les chemins d'une phrase et ignore le reste", () => {
    const tokens = extractPathTokens(
      "J'ai cloné le dépôt dans /Users/moi/projets/api et modifié src/lib/db.ts.",
    );
    expect(tokens).toContain("/Users/moi/projets/api");
    expect(tokens).toContain("src/lib/db.ts");
    expect(tokens).not.toContain("dépôt");
  });

  it("déduplique en préservant l'ordre", () => {
    const tokens = extractPathTokens("src/a.ts et src/a.ts encore");
    expect(tokens).toEqual(["src/a.ts"]);
  });
});
