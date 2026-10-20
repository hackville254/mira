import { describe, it, expect, beforeEach } from "vitest";

// `inputCommands` lit/écrit `localStorage` pour la persistance du mode.
// L'environnement de test est `node` : on installe un polyfill en mémoire.
const store = new Map<string, string>();
(globalThis as { localStorage?: Storage }).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => Array.from(store.keys())[i] ?? null,
  get length() {
    return store.size;
  },
} as Storage;

import {
  AGENTS,
  SLASH_COMMANDS,
  MODE_STORAGE_KEY,
  isMode,
  agentLabel,
  readStoredMode,
  writeStoredMode,
  parseSlashCommand,
  filterSlashCommands,
  getSlashQuery,
  mergeSlashCommands,
  resolveHistoryNav,
} from "../inputCommands";

describe("inputCommands — modes d'agent", () => {
  it("expose les trois modes réels (agent, plan, ask)", () => {
    const ids = AGENTS.map(a => a.id).sort();
    expect(ids).toEqual(["agent", "ask", "plan"]);
  });

  it("`plan` est présent dans le menu (sinon il est inatteignable)", () => {
    expect(AGENTS.some(a => a.id === "plan")).toBe(true);
  });

  it("chaque agent a un libellé et un libellé d'icône non vides", () => {
    for (const a of AGENTS) {
      expect(a.label.length).toBeGreaterThan(0);
      expect(a.icon.length).toBeGreaterThan(0);
    }
  });

  it("isMode discrimine correctement", () => {
    expect(isMode("agent")).toBe(true);
    expect(isMode("plan")).toBe(true);
    expect(isMode("ask")).toBe(true);
    expect(isMode("garbage")).toBe(false);
    expect(isMode("")).toBe(false);
  });

  it("agentLabel renvoie un libellé connu pour chaque mode", () => {
    expect(agentLabel("agent")).toBeTruthy();
    expect(agentLabel("plan")).toBeTruthy();
    expect(agentLabel("ask")).toBeTruthy();
  });
});

describe("inputCommands — persistance du mode", () => {
  beforeEach(() => {
    localStorage.removeItem(MODE_STORAGE_KEY);
  });

  it("retombe sur 'agent' par défaut quand rien n'est mémorisé", () => {
    expect(readStoredMode()).toBe("agent");
  });

  it("relit le mode mémorisé", () => {
    writeStoredMode("plan");
    expect(readStoredMode()).toBe("plan");
    writeStoredMode("ask");
    expect(readStoredMode()).toBe("ask");
  });

  it("ignore une valeur mémorisée invalide et retombe sur le fallback", () => {
    localStorage.setItem(MODE_STORAGE_KEY, "bogus");
    expect(readStoredMode()).toBe("agent");
    expect(readStoredMode("plan")).toBe("plan");
  });
});

describe("inputCommands — parsing des slash-commands", () => {
  it("reconnaît /plan et retire le préfixe du reste", () => {
    const r = parseSlashCommand("/plan refactorise le module auth");
    expect(r.command?.name).toBe("plan");
    expect(r.rest).toBe("refactorise le module auth");
  });

  it("reconnaît /agent et /ask", () => {
    expect(parseSlashCommand("/agent fais un fix").command?.name).toBe("agent");
    expect(parseSlashCommand("/ask c'est quoi ce bug ?").command?.name).toBe("ask");
  });

  it("/chat est un alias de ask (même action)", () => {
    const chat = parseSlashCommand("/chat hello");
    const ask = parseSlashCommand("/ask hello");
    expect(chat.command?.action).toEqual(ask.command?.action);
  });

  it("applique l'action set-mode attendue", () => {
    expect(parseSlashCommand("/plan").command?.action).toEqual({ kind: "set-mode", mode: "plan" });
  });

  it("commande seule sans texte → rest vide", () => {
    const r = parseSlashCommand("/plan");
    expect(r.command?.name).toBe("plan");
    expect(r.rest).toBe("");
  });

  it("un texte sans slash initial n'est pas une commande", () => {
    const r = parseSlashCommand("plan refactorise");
    expect(r.command).toBeNull();
    expect(r.rest).toBe("plan refactorise");
  });

  it("un nom inconnu → command null mais le texte est conservé", () => {
    const r = parseSlashCommand("/bogus du texte");
    expect(r.command).toBeNull();
    expect(r.rest).toBe("du texte");
  });

  it("tolère les espaces avant le slash", () => {
    expect(parseSlashCommand("   /plan x").command?.name).toBe("plan");
  });

  it("la casse du nom est insensible", () => {
    expect(parseSlashCommand("/PLAN x").command?.name).toBe("plan");
  });

  it("le nom de commande s'arrête au premier espace", () => {
    const r = parseSlashCommand("/planner suite");
    expect(r.command).toBeNull(); // « planner » ≠ « plan »
    expect(r.rest).toBe("suite");
  });
});

describe("inputCommands — autocomplétion slash", () => {
  it("getSlashQuery détecte la requête en fin de texte", () => {
    expect(getSlashQuery("fais ça /pl")).toBe("pl");
    expect(getSlashQuery("/")).toBe("");
    expect(getSlashQuery("aucun slash")).toBeNull();
  });

  it("filterSlashCommands renvoie tout sur requête vide", () => {
    expect(filterSlashCommands("").length).toBe(SLASH_COMMANDS.length);
  });

  it("filterSlashCommands filtre par préfixe", () => {
    const names = filterSlashCommands("pla").map(c => c.name);
    expect(names).toContain("plan");
    expect(names).not.toContain("ask");
  });

  it("un préfixe sans correspondance renvoie un tableau vide", () => {
    expect(filterSlashCommands("zzz")).toEqual([]);
  });

  it("chaque slash-command a un nom unique", () => {
    const names = SLASH_COMMANDS.map(c => c.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("inputCommands — fusion avec les commandes runtime Cline", () => {
  it("sans runtime, renvoie le catalogue intégré tel quel", () => {
    expect(mergeSlashCommands().map(c => c.name)).toEqual(SLASH_COMMANDS.map(c => c.name));
  });

  it("ajoute les commandes runtime en action `insert`", () => {
    const merged = mergeSlashCommands([
      { id: "commit", name: "commit", description: "Fait un commit", kind: "workflow" },
    ]);
    const cmd = merged.find(c => c.name === "commit");
    expect(cmd).toBeDefined();
    expect(cmd!.action).toEqual({ kind: "insert", text: "/commit " });
    expect(cmd!.source).toBe("runtime");
  });

  it("les commandes intégrées gardent la priorité en cas de collision", () => {
    const merged = mergeSlashCommands([{ id: "plan", name: "plan", kind: "skill" }]);
    const plan = merged.filter(c => c.name === "plan");
    expect(plan).toHaveLength(1);
    expect(plan[0].source).toBe("builtin");
  });

  it("ignore les entrées runtime sans nom exploitable", () => {
    const base = SLASH_COMMANDS.length;
    expect(mergeSlashCommands([{ id: "", name: "", kind: "skill" }]).length).toBe(base);
  });

  it("normalise un nom préfixé par un slash", () => {
    const merged = mergeSlashCommands([{ id: "/release", name: "/release", kind: "workflow" }]);
    const cmd = merged.find(c => c.name === "release");
    expect(cmd).toBeDefined();
    expect(cmd!.action).toEqual({ kind: "insert", text: "/release " });
  });

  it("la description runtime est conservée quand fournie", () => {
    const merged = mergeSlashCommands([
      { id: "rev", name: "rev", description: "Revue de code", kind: "skill" },
    ]);
    expect(merged.find(c => c.name === "rev")!.description).toBe("Revue de code");
  });
});

describe("inputCommands — navigation dans l'historique", () => {
  const history = ["premier", "deuxième", "dernier"];

  it("remonte du brouillon vers le message le plus récent", () => {
    expect(resolveHistoryNav({ direction: "up", index: -1, history, draft: "brouillon" }))
      .toEqual({ index: 0, text: "dernier" });
  });

  it("remonte vers le plus ancien puis s'arrête", () => {
    const a = resolveHistoryNav({ direction: "up", index: 0, history, draft: "" })!;
    expect(a).toEqual({ index: 1, text: "deuxième" });
    const b = resolveHistoryNav({ direction: "up", index: a.index, history, draft: "" })!;
    expect(b).toEqual({ index: 2, text: "premier" });
    const c = resolveHistoryNav({ direction: "up", index: b.index, history, draft: "" })!;
    expect(c).toEqual({ index: 2, text: "premier" });
  });

  it("redescend puis restaure le brouillon", () => {
    const down = resolveHistoryNav({ direction: "down", index: 1, history, draft: "brouillon" })!;
    expect(down).toEqual({ index: 0, text: "dernier" });
    const restored = resolveHistoryNav({ direction: "down", index: 0, history, draft: "brouillon" })!;
    expect(restored).toEqual({ index: -1, text: "brouillon" });
  });

  it("ne fait rien sur un brouillon avec ↓ ou sur un historique vide", () => {
    expect(resolveHistoryNav({ direction: "down", index: -1, history, draft: "x" })).toBeNull();
    expect(resolveHistoryNav({ direction: "up", index: -1, history: [], draft: "x" })).toBeNull();
  });
});
