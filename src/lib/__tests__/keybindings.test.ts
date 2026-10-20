import { describe, it, expect, beforeEach } from "vitest";

// `keybindings.ts` persiste dans `localStorage`. L'environnement de test est `node`
// (pas de DOM) : on installe un polyfill minimal en mémoire, sinon `resetKeybindings()`
// lève `localStorage is not defined`.
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
  COMMANDS,
  matchesEvent,
  getEffectiveKey,
  getCommandKeyMap,
  loadKeybindings,
  saveKeybindings,
  resetKeybindings,
  setKeybinding,
  parseEditorKeybindings,
} from "../keybindings";

/** Fabrique un évènement clavier minimal pour `matchesEvent`. */
function ev(key: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {}): KeyboardEvent {
  return {
    key,
    ctrlKey: !!mods.ctrl,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt,
    metaKey: !!mods.meta,
  } as KeyboardEvent;
}

describe("keybindings — undo / redo (Ctrl+Z / Ctrl+Y)", () => {
  beforeEach(() => {
    // localStorage est fourni par l'environnement de test ; on repart propre.
    resetKeybindings();
  });

  it("undo et redo sont déclarés par défaut sur ctrl+z et ctrl+y", () => {
    expect(COMMANDS.find(c => c.id === "origin.editorUndo")?.defaultKey).toBe("ctrl+z");
    expect(COMMANDS.find(c => c.id === "origin.editorRedo")?.defaultKey).toBe("ctrl+y");
  });

  it("ctrl+z déclenche Undo, pas Redo", () => {
    expect(matchesEvent(ev("z", { ctrl: true }), "ctrl+z")).toBe(true);
    expect(matchesEvent(ev("z", { ctrl: true }), "ctrl+y")).toBe(false);
  });

  it("ctrl+y déclenche Redo", () => {
    expect(matchesEvent(ev("y", { ctrl: true }), "ctrl+y")).toBe(true);
  });

  it("Cmd+Z (macOS) déclenche aussi Undo — ctrl et meta sont équivalents", () => {
    expect(matchesEvent(ev("z", { meta: true }), "ctrl+z")).toBe(true);
  });

  it("Ctrl+Shift+Z ne déclenche PAS Undo (différencie les modificateurs)", () => {
    expect(matchesEvent(ev("z", { ctrl: true, shift: true }), "ctrl+z")).toBe(false);
  });

  it("z sans modificateur ne déclenche PAS Undo", () => {
    expect(matchesEvent(ev("z"), "ctrl+z")).toBe(false);
  });

  it("la touche est insensible à la casse (Z majuscule)", () => {
    expect(matchesEvent(ev("Z", { ctrl: true }), "ctrl+z")).toBe(true);
  });

  it("la carte clavier contient bien les deux commandes avec leur touche effective", () => {
    const km = getCommandKeyMap();
    expect(km["origin.editorUndo"]).toBe("ctrl+z");
    expect(km["origin.editorRedo"]).toBe("ctrl+y");
  });
});

describe("keybindings — surcharge utilisateur", () => {
  beforeEach(() => resetKeybindings());

  it("une surcharge utilisateur remplace la touche par défaut", () => {
    setKeybinding("origin.editorUndo", "ctrl+u");
    expect(getEffectiveKey("origin.editorUndo")).toBe("ctrl+u");
    expect(getCommandKeyMap()["origin.editorUndo"]).toBe("ctrl+u");
    // Redo n'est pas affecté.
    expect(getEffectiveKey("origin.editorRedo")).toBe("ctrl+y");
  });

  it("passer null retire la surcharge et restaure le défaut", () => {
    setKeybinding("origin.editorUndo", "ctrl+u");
    setKeybinding("origin.editorUndo", null);
    expect(getEffectiveKey("origin.editorUndo")).toBe("ctrl+z");
  });

  it("les surcharges sont persistées puis relues", () => {
    setKeybinding("origin.editorRedo", "ctrl+shift+z");
    const stored = loadKeybindings();
    expect(stored.find(b => b.command === "origin.editorRedo")?.key).toBe("ctrl+shift+z");
    // Relecture indépendante.
    expect(getEffectiveKey("origin.editorRedo")).toBe("ctrl+shift+z");
  });

  it("rebinder ne crée pas de doublon (remplace l'entrée existante)", () => {
    setKeybinding("origin.editorUndo", "ctrl+u");
    setKeybinding("origin.editorUndo", "ctrl+j");
    const entries = loadKeybindings().filter(b => b.command === "origin.editorUndo");
    expect(entries).toHaveLength(1);
    expect(entries[0].key).toBe("ctrl+j");
  });

  it("saveKeybindings remplace tout l'ensemble", () => {
    saveKeybindings([{ key: "ctrl+m", command: "origin.editorUndo" }]);
    expect(getEffectiveKey("origin.editorUndo")).toBe("ctrl+m");
    expect(getEffectiveKey("origin.editorRedo")).toBe("ctrl+y");
  });
});

describe("keybindings — import VS Code", () => {
  it("mappe les commandes undo/redo de VS Code vers Origin", () => {
    const json = JSON.stringify([
      { key: "ctrl+z", command: "undo" },
      { key: "ctrl+shift+z", command: "redo" },
    ]);
    const { imported, bindings } = parseEditorKeybindings(json);
    expect(imported).toBe(2);
    expect(bindings).toContainEqual({ key: "ctrl+z", command: "origin.editorUndo" });
    expect(bindings).toContainEqual({ key: "ctrl+shift+z", command: "origin.editorRedo" });
  });

  it("ignore les entrées de négation (command préfixée par -)", () => {
    const json = JSON.stringify([{ key: "ctrl+z", command: "-undo" }]);
    expect(parseEditorKeybindings(json).imported).toBe(0);
  });

  it("ignore les commandes non mappées", () => {
    const json = JSON.stringify([{ key: "ctrl+k", command: "some.unknown.command" }]);
    expect(parseEditorKeybindings(json).imported).toBe(0);
  });

  it("renvoie 0 sur un JSON invalide sans lever", () => {
    expect(parseEditorKeybindings("{ not json")).toEqual({ imported: 0, bindings: [] });
  });

  it("supporte les commentaires // dans le JSON", () => {
    const json = `[
      // undo binding
      { "key": "ctrl+z", "command": "undo" }
    ]`;
    expect(parseEditorKeybindings(json).imported).toBe(1);
  });
});
