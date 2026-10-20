// ── Tests — recherche de code BM25 headless (parité comportementale Rust) ──────
//
// Objectif (Étape 2) : vérifier que l'index BM25 Node reproduit fidèlement
// l'algorithme de `src-tauri/src/indexing.rs` — même tokenisation, même tri,
// mêmes exclusions — afin que `codebase_search` soit fonctionnel en headless,
// sans Tauri. Ces tests ne dépendent ni du réseau ni du sidecar.

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  searchIndex,
  buildSearchIndex,
  clearSearchCache,
} from "../../../../bench/coding/headless/codeSearch";

const created: string[] = [];

async function makeWs(): Promise<string> {
  const ws = await mkdtemp(join(tmpdir(), "orvyx-search-test-"));
  created.push(ws);
  return ws;
}

afterEach(async () => {
  clearSearchCache();
  for (const ws of created.splice(0)) await rm(ws, { recursive: true, force: true });
});

describe("searchIndex — contrat et classement", () => {
  it("trouve le fichier pertinent et ignore les dossiers exclus", async () => {
    const ws = await makeWs();
    await mkdir(join(ws, "src"), { recursive: true });
    await mkdir(join(ws, "node_modules", "dep"), { recursive: true });
    await writeFile(join(ws, "src", "auth.ts"), "export function loginWithToken() { /* auth */ }");
    await writeFile(join(ws, "src", "render.ts"), "export function render() {}");
    // Ce fichier serait le meilleur match s'il était indexé : il NE DOIT PAS l'être.
    await writeFile(join(ws, "node_modules", "dep", "auth.js"), "loginWithToken auth login ".repeat(50));

    const hits = await searchIndex(ws, "loginWithToken", 10);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].rel).toBe("src/auth.ts");
    expect(hits.every(h => !h.rel.includes("node_modules"))).toBe(true);
  });

  it("le biais de chemin aide un fichier dont le CHEMIN porte le terme (corps identique)", async () => {
    const ws = await makeWs();
    await mkdir(join(ws, "widget"), { recursive: true });
    // Les deux corps sont IDENTIQUES (même terme, même fréquence, même longueur) :
    // seul le chemin distingue les documents. `widget/helper.ts` doit passer
    // devant `misc.ts` grâce à PATH_WEIGHT (port fidèle de `indexing.rs`).
    const body = "// widget\nexport function run() {}";
    await writeFile(join(ws, "widget", "helper.ts"), body);
    await writeFile(join(ws, "misc.ts"), body);
    const hits = await searchIndex(ws, "widget", 10);
    expect(hits[0].rel).toBe("widget/helper.ts");
  });

  it("découpe camelCase : une requête `parse context` retrouve parseContextRef", async () => {
    const ws = await makeWs();
    await writeFile(join(ws, "a.ts"), "export function parseContextRef() {}");
    await writeFile(join(ws, "b.ts"), "export function unrelatedStuff() {}");
    const hits = await searchIndex(ws, "parse context", 10);
    expect(hits.map(h => h.rel)).toContain("a.ts");
    expect(hits.map(h => h.rel)).not.toContain("b.ts");
  });

  it("renvoie un tableau vide si la requête ne matche rien", async () => {
    const ws = await makeWs();
    await writeFile(join(ws, "a.ts"), "const x = 1;");
    const hits = await searchIndex(ws, "zzzzzznonexistent", 10);
    expect(hits).toEqual([]);
  });

  it("refuse un workspace non absolu (confinement)", async () => {
    const hits = await searchIndex("relative/path", "auth", 10);
    expect(hits).toEqual([]);
  });

  it("renvoie un tableau vide pour une requête vide (aucun token exploitable)", async () => {
    const ws = await makeWs();
    await writeFile(join(ws, "a.ts"), "const x = 1;");
    const hits = await searchIndex(ws, "   ", 10);
    expect(hits).toEqual([]);
  });

  it("borne `limit` : jamais plus de MAX_LIMIT résultats", async () => {
    const ws = await makeWs();
    for (let i = 0; i < 5; i++) await writeFile(join(ws, `f${i}.ts`), "shared token here");
    const hits = await searchIndex(ws, "shared", 3);
    expect(hits.length).toBe(3);
  });

  it("score décroissant puis chemin croissant (déterminisme)", async () => {
    const ws = await makeWs();
    await writeFile(join(ws, "z.ts"), "alpha beta");
    await writeFile(join(ws, "a.ts"), "alpha beta");
    const hits = await searchIndex(ws, "alpha beta", 10);
    // Mêmes scores → ordre par chemin croissant (a.ts avant z.ts).
    expect(hits.map(h => h.rel)).toEqual(["a.ts", "z.ts"]);
  });
});

describe("searchIndex — robustesse", () => {
  it("ignore un fichier binaire (octet NUL) et un fichier vide", async () => {
    const ws = await makeWs();
    await writeFile(join(ws, "bin.dat"), Buffer.from([0x41, 0x00, 0x42]));
    await writeFile(join(ws, "empty.ts"), "");
    await writeFile(join(ws, "ok.ts"), "needle here");
    const hits = await searchIndex(ws, "needle", 10);
    expect(hits.map(h => h.rel)).toEqual(["ok.ts"]);
  });

  it("ne casse pas sur un workspace inexistant", async () => {
    const hits = await searchIndex("/nonexistent/does/not/exist", "auth", 10);
    expect(hits).toEqual([]);
  });

  it("buildSearchIndex renvoie le nombre de fichiers indexés et remplit le cache", async () => {
    const ws = await makeWs();
    await writeFile(join(ws, "a.ts"), "alpha");
    await writeFile(join(ws, "b.ts"), "beta");
    const count = await buildSearchIndex(ws);
    expect(count).toBe(2);
    const hits = await searchIndex(ws, "alpha", 10);
    expect(hits.map(h => h.rel)).toContain("a.ts");
  });

  it("réutilise un index persisté s'il correspond à la racine", async () => {
    const ws = await makeWs();
    await writeFile(join(ws, "a.ts"), "persisted content alpha");
    // Préchauffe puis retire le cache mémoire : la 2e recherche doit relire
    // (ou reconstruire) sans erreur et rester correcte.
    await buildSearchIndex(ws);
    clearSearchCache(ws);
    const hits = await searchIndex(ws, "persisted", 10);
    expect(hits.map(h => h.rel)).toEqual(["a.ts"]);
  });
});
