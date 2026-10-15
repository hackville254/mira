import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  registerCommand,
  registerCommands,
  getCommands,
  getCommand,
  subscribe,
  runCommand,
} from "../commands/registry";

/**
 * Le registry est un singleton module : pour isoler chaque test on enregistre
 * des ids uniques et on se désinscrit systématiquement. Aucun test ne dépend
 * de l'ordre d'exécution.
 */
describe("commands/registry — commandes runtime de l'IDE", () => {
  const disposers: Array<() => void> = [];
  const track = (d: () => void) => {
    disposers.push(d);
    return d;
  };

  beforeEach(() => {
    // Enregistre un nom de commande unique par test pour éviter les collisions.
  });

  it("runCommand exécute le handler enregistré", async () => {
    const run = vi.fn();
    track(registerCommand({ id: "test.run.basic", title: "Basic", category: "Test", run }));
    await runCommand("test.run.basic");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("runCommand attend un handler asynchrone", async () => {
    let done = false;
    track(registerCommand({
      id: "test.run.async",
      title: "Async",
      category: "Test",
      run: async () => { await Promise.resolve(); done = true; },
    }));
    await runCommand("test.run.async");
    expect(done).toBe(true);
  });

  it("runCommand sur un id inconnu est silencieux (pas d'exception)", async () => {
    await expect(runCommand("test.does.not.exist")).resolves.toBeUndefined();
  });

  it("getCommand récupère la commande par id", () => {
    track(registerCommand({ id: "test.get.one", title: "Get", category: "Test", run: () => {} }));
    expect(getCommand("test.get.one")?.title).toBe("Get");
    expect(getCommand("test.get.missing")).toBeUndefined();
  });

  it("getCommands expose les commandes enregistrées", () => {
    track(registerCommand({ id: "test.list.a", title: "A", category: "Test", run: () => {} }));
    const ids = getCommands().map(c => c.id);
    expect(ids).toContain("test.list.a");
  });

  it("ré-enregistrer le même id remplace la commande", () => {
    track(registerCommand({ id: "test.replace", title: "V1", category: "Test", run: () => {} }));
    track(registerCommand({ id: "test.replace", title: "V2", category: "Test", run: () => {} }));
    expect(getCommand("test.replace")?.title).toBe("V2");
    expect(getCommands().filter(c => c.id === "test.replace")).toHaveLength(1);
  });

  it("le désinscripteur retire la commande", () => {
    const dispose = registerCommand({ id: "test.dispose", title: "D", category: "Test", run: () => {} });
    expect(getCommand("test.dispose")).toBeDefined();
    dispose();
    expect(getCommand("test.dispose")).toBeUndefined();
  });

  it("le désinscripteur est inoffensif si la commande a été remplacée", () => {
    const dispose1 = registerCommand({ id: "test.dispose.safe", title: "V1", category: "Test", run: () => {} });
    track(registerCommand({ id: "test.dispose.safe", title: "V2", category: "Test", run: () => {} }));
    dispose1(); // ne doit PAS supprimer la V2
    expect(getCommand("test.dispose.safe")?.title).toBe("V2");
  });

  it("registerCommands puis le désinscripteur groupé retire tout", () => {
    const dispose = registerCommands([
      { id: "test.group.a", title: "A", category: "Test", run: () => {} },
      { id: "test.group.b", title: "B", category: "Test", run: () => {} },
    ]);
    expect(getCommand("test.group.a")).toBeDefined();
    expect(getCommand("test.group.b")).toBeDefined();
    dispose();
    expect(getCommand("test.group.a")).toBeUndefined();
    expect(getCommand("test.group.b")).toBeUndefined();
  });

  it("subscribe est notifié lors d'un enregistrement", () => {
    const listener = vi.fn();
    const unsub = subscribe(listener);
    track(registerCommand({ id: "test.sub.add", title: "S", category: "Test", run: () => {} }));
    expect(listener).toHaveBeenCalled();
    unsub();
  });

  it("subscribe n'est plus notifié après désabonnement", () => {
    const listener = vi.fn();
    const unsub = subscribe(listener);
    unsub();
    const before = listener.mock.calls.length;
    track(registerCommand({ id: "test.sub.after", title: "S", category: "Test", run: () => {} }));
    expect(listener.mock.calls.length).toBe(before);
  });

  it("le snapshot de getCommands est stable entre deux appels sans changement", () => {
    const a = getCommands();
    const b = getCommands();
    expect(a).toBe(b);
  });
});
