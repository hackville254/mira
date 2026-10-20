import { describe, it, expect } from "vitest";

import {
  CONTEXT_KINDS,
  contextKindDescriptor,
  contextRefKey,
  hasContextRef,
  addContextRef,
  removeContextRef,
  getHashQuery,
  filterContextKinds,
  serializeContextRefs,
  parseContextRef,
  contextIconName,
  type ContextRef,
} from "../contextMentions";

describe("contextMentions — catalogue des types", () => {
  it("expose les six types réellement fonctionnels", () => {
    const kinds = CONTEXT_KINDS.map(k => k.kind).sort();
    expect(kinds).toEqual(["code", "file", "folder", "problems", "rule", "workspace"]);
  });

  it("n'expose PAS les types non résolus par Mira (#Doc, #Web, #Past Chats)", () => {
    const kinds = CONTEXT_KINDS.map(k => k.kind);
    expect(kinds).not.toContain("doc");
    expect(kinds).not.toContain("web");
    expect(kinds).not.toContain("pastchats");
  });

  it("chaque type a un libellé et une description non vides", () => {
    for (const k of CONTEXT_KINDS) {
      expect(k.label.length).toBeGreaterThan(0);
      expect(k.description.length).toBeGreaterThan(0);
    }
  });

  it("les types ciblés exigent un sélecteur, les types atomiques non", () => {
    expect(contextKindDescriptor("file")!.needsPicker).toBe(true);
    expect(contextKindDescriptor("folder")!.needsPicker).toBe(true);
    expect(contextKindDescriptor("rule")!.needsPicker).toBe(true);
    expect(contextKindDescriptor("workspace")!.needsPicker).toBe(false);
    expect(contextKindDescriptor("problems")!.needsPicker).toBe(false);
    expect(contextKindDescriptor("code")!.needsPicker).toBe(false);
  });

  it("contextKindDescriptor renvoie undefined pour un type inconnu", () => {
    expect(contextKindDescriptor("bogus" as never)).toBeUndefined();
  });

  it("contextIconName est l'identité du type", () => {
    expect(contextIconName("folder")).toBe("folder");
    expect(contextIconName("problems")).toBe("problems");
  });
});

describe("contextMentions — détection de la requête #", () => {
  it("détecte un # en fin de texte (menu des types)", () => {
    expect(getHashQuery("#")).toBe("");
    expect(getHashQuery("regarde #")).toBe("");
  });

  it("renvoie la requête partielle après le #", () => {
    expect(getHashQuery("regarde #fol")).toBe("fol");
    expect(getHashQuery("#work")).toBe("work");
  });

  it("ne capture que la requête la plus à droite", () => {
    expect(getHashQuery("#file puis #fol")).toBe("fol");
  });

  it("exige un début de texte ou un espace avant le #", () => {
    // Collé à du texte : couleur hexadécimale ou titre Markdown, pas une mention.
    expect(getHashQuery("couleur #ff00aa")).toBe("ff00aa");
    expect(getHashQuery("abc#def")).toBeNull();
  });

  it("un # suivi d'un espace n'est plus une requête active", () => {
    expect(getHashQuery("# ")).toBeNull();
    expect(getHashQuery("#foo bar")).toBeNull();
  });

  it("un second # dans la requête annule la détection", () => {
    expect(getHashQuery("#a#b")).toBeNull();
  });

  it("un texte sans # renvoie null", () => {
    expect(getHashQuery("aucun dieze ici")).toBeNull();
    expect(getHashQuery("")).toBeNull();
  });
});

describe("contextMentions — filtrage des types", () => {
  it("une requête vide renvoie tout le catalogue", () => {
    expect(filterContextKinds("").length).toBe(CONTEXT_KINDS.length);
  });

  it("filtre par préfixe de type", () => {
    const kinds = filterContextKinds("fol").map(k => k.kind);
    expect(kinds).toEqual(["folder"]);
  });

  it("filtre aussi sur le libellé, insensiblement à la casse", () => {
    const kinds = filterContextKinds("WORK").map(k => k.kind);
    expect(kinds).toEqual(["workspace"]);
  });

  it("une requête sans correspondance renvoie un tableau vide", () => {
    expect(filterContextKinds("zzz")).toEqual([]);
  });

  it("tolère les espaces autour de la requête", () => {
    expect(filterContextKinds("  file  ").map(k => k.kind)).toEqual(["file"]);
  });
});

describe("contextMentions — références de contexte", () => {
  const workspaceRef: ContextRef = { kind: "workspace", label: "Workspace" };
  const fileRef: ContextRef = { kind: "file", path: "/proj/src/a.ts", label: "a.ts" };
  const fileRefBis: ContextRef = { kind: "file", path: "/proj/src/a.ts", label: "a.ts" };

  it("la clé d'unicité combine type et chemin", () => {
    expect(contextRefKey(workspaceRef)).toBe("workspace:");
    expect(contextRefKey(fileRef)).toBe("file:/proj/src/a.ts");
  });

  it("détecte la présence d'une référence équivalente", () => {
    expect(hasContextRef([workspaceRef], workspaceRef)).toBe(true);
    expect(hasContextRef([fileRef], fileRefBis)).toBe(true);
    expect(hasContextRef([fileRef], workspaceRef)).toBe(false);
  });

  it("deux #Workspace sont considérés identiques (pas de doublon)", () => {
    const once = addContextRef([], workspaceRef);
    const twice = addContextRef(once, { kind: "workspace", label: "Projet" });
    expect(twice).toHaveLength(1);
  });

  it("ajoute une référence unique sans muter la liste d'origine", () => {
    const base: ContextRef[] = [];
    const next = addContextRef(base, fileRef);
    expect(next).toHaveLength(1);
    expect(base).toHaveLength(0);
  });

  it("ne duplique pas un fichier ajouté deux fois", () => {
    const once = addContextRef([], fileRef);
    const twice = addContextRef(once, fileRefBis);
    expect(twice).toHaveLength(1);
  });

  it("retire la référence à l'index demandé sans muter l'original", () => {
    const list = [workspaceRef, fileRef];
    const next = removeContextRef(list, 0);
    expect(next).toEqual([fileRef]);
    expect(list).toHaveLength(2);
  });

  it("un index hors bornes laisse la liste inchangée", () => {
    const list = [workspaceRef];
    expect(removeContextRef(list, -1)).toEqual(list);
    expect(removeContextRef(list, 5)).toEqual(list);
  });
});

describe("contextMentions — sérialisation vers le transport", () => {
  it("sérialise un type global en `kind` seul", () => {
    expect(serializeContextRefs([{ kind: "workspace", label: "Workspace" }])).toEqual(["workspace"]);
  });

  it("sérialise un type ciblé en `kind:path`", () => {
    const refs: ContextRef[] = [{ kind: "file", path: "/proj/src/a.ts", label: "a.ts" }];
    expect(serializeContextRefs(refs)).toEqual(["file:/proj/src/a.ts"]);
  });

  it("fait l'aller-retour sérialisation → parsing pour un fichier", () => {
    const ref: ContextRef = { kind: "folder", path: "/proj/src", label: "src" };
    const [entry] = serializeContextRefs([ref]);
    const parsed = parseContextRef(entry);
    expect(parsed).toEqual(ref);
  });

  it("fait l'aller-retour pour un type global (label reconstruit)", () => {
    const parsed = parseContextRef("workspace");
    expect(parsed).toEqual({ kind: "workspace", path: undefined, label: "Workspace" });
  });

  it("parse un chemin Windows en coupant au PREMIER deux-points", () => {
    const parsed = parseContextRef("file:C:\\proj\\src\\a.ts");
    expect(parsed!.kind).toBe("file");
    expect(parsed!.path).toBe("C:\\proj\\src\\a.ts");
    expect(parsed!.label).toBe("a.ts");
  });

  it("renvoie null pour un type inconnu — on ne devine jamais un type", () => {
    expect(parseContextRef("bogus:/x")).toBeNull();
    expect(parseContextRef("doc:https://x")).toBeNull();
    expect(parseContextRef("")).toBeNull();
  });

  it("un chemin de type fichier sans slash donne le chemin comme libellé", () => {
    expect(parseContextRef("file:a.ts")!.label).toBe("a.ts");
  });
});
