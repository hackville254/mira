// ── Génération — persistance JSONL versionnée + reprise de campagne ───────────
//
// Pourquoi JSONL et pas un unique JSON ?
//  - une ligne = un résultat ; une campagne interrompue (Ctrl-C, crash, quota)
//    conserve TOUT ce qui est déjà écrit ;
//  - la reprise saute les tentatives déjà présentes, sans les refaire ;
//  - le fichier reste lisible par des outils standards et versionné
//    (`schemaVersion` figé par ligne).
//
// GARANTIE : aucune clé d'API n'apparaît jamais dans une ligne de résultat.
// `modelId` est un libellé public ; la clé ne vit que dans la requête HTTP.

import { readFile, appendFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

import {
  GENERATION_SCHEMA_VERSION,
  type GenerationAttempt,
  type GenerationResultLine,
} from "./types";

/** Clé d'unicité d'une tentative (benchmark + mode + modèle + run + tâche). */
export function attemptKey(a: Pick<GenerationAttempt, "benchmark" | "evalMode" | "modelId" | "run" | "taskId">): string {
  return `${a.benchmark}::${a.evalMode}::${a.modelId}::${a.run}::${a.taskId}`;
}

/** Vrai si la ligne contient une clé d'API (garde-fou anti-fuite). */
export function containsApiKey(line: GenerationResultLine): boolean {
  const json = JSON.stringify(line);
  // Les clés Orvyx commencent par `oryx_` ; les clés OpenAI par `sk-`.
  return /oryx_[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{16,}/.test(json);
}

/**
 * Charge les tentatives déjà présentes (JSONL), en ignorant les lignes
 * corrompues (on ne fait jamais échouer une reprise à cause d'une ligne
 * partielle écrite pendant un crash).
 */
export async function loadExisting(path: string): Promise<GenerationAttempt[]> {
  if (!existsSync(path)) return [];
  const text = await readFile(path, "utf8");
  const out: GenerationAttempt[] = [];
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const parsed = JSON.parse(s) as GenerationResultLine;
      if (parsed?.attempt?.taskId) out.push(parsed.attempt);
    } catch {
      // ligne partielle : ignorée (sera refaite).
    }
  }
  return out;
}

/** Ensemble des clés déjà traitées dans un fichier de résultats. */
export async function loadDoneKeys(path: string): Promise<Set<string>> {
  const attempts = await loadExisting(path);
  return new Set(attempts.map(attemptKey));
}

/**
 * Ajoute une tentative au fichier JSONL (création du dossier au besoin).
 * Refuse d'écrire une ligne contenant une clé d'API (défense en profondeur).
 */
export async function appendAttempt(path: string, attempt: GenerationAttempt): Promise<void> {
  const line: GenerationResultLine = {
    schemaVersion: GENERATION_SCHEMA_VERSION,
    recordedAt: new Date().toISOString(),
    attempt,
  };
  if (containsApiKey(line)) {
    throw new Error("refus d'écrire un résultat contenant une clé d'API (garde-fou de sécurité)");
  }
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(line)}\n`, "utf8");
}

/** Réécrit complètement un fichier JSONL (usage : reprise/normalisation). */
export async function rewriteAll(path: string, attempts: GenerationAttempt[]): Promise<void> {
  const lines = attempts.map(a => JSON.stringify({
    schemaVersion: GENERATION_SCHEMA_VERSION,
    recordedAt: new Date().toISOString(),
    attempt: a,
  } satisfies GenerationResultLine));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, lines.length > 0 ? `${lines.join("\n")}\n` : "", "utf8");
}
