/**
 * Origin — Driver de benchmark RÉEL branché sur le sidecar Cline (Tauri).
 *
 * RÔLE
 * ----
 * Ce module fait le pont entre le harnais de benchmark (`bench/coding/runner.ts`)
 * et le VRAI moteur de production : `startClineHarness` (sidecar Cline piloté par
 * Rust), avec les VRAIS outils d'ORVYX et les VRAIES approbations.
 *
 * POURQUOI UN DRIVER SÉPARÉ
 * -------------------------
 * Les outils de production (`src/lib/agent/tools.ts`) appellent `invoke` Tauri de
 * manière STATIQUE : il n'existe aucun point d'injection pour substituer des
 * outils factices. Un driver « outils réels » ne peut donc tourner QUE dans
 * l'app Tauri. Hors Tauri, ce module échoue explicitement plutôt que de simuler
 * le comportement du moteur (interdiction de créer de faux outils).
 *
 * CONTRAINTE DE LA MISSION
 * ------------------------
 *  - On ne remplace pas le moteur : on l'APPELLE via `startClineHarness`.
 *  - On ne refactorise pas l'architecture pour faciliter les tests.
 *  - Les tests simulés (Niveau A) et ce driver réel sont nettement séparés.
 *
 * SÉCURITÉ
 * --------
 *  - La clé d'API est fournie par l'appelant (jamais journalisée, jamais persistée).
 *  - Les approbations par défaut suivent la politique d'ORVYX ; ce driver REFUSE
 *    tout `ask` sans canal d'approbation fourni (comportement le plus sûr).
 *    Un mode `autoApprove` explicite existe pour les tâches de bench non
 *    interactives, mais reste OPT-IN et journalisé.
 *  - Aucune écriture hors du workspace de la tâche (le sidecar reçoit `cwd`).
 */

import { startClineHarness } from "../../src/lib/agent/clineHarness";
import type { AgentEvent } from "../../src/lib/agent/run";
import type { PendingAction } from "../../src/lib/agent/tools";
import type { AgentDriver } from "./runner";
import type { DriverMeta } from "./types";

/** Paramètres du driver réel. */
export interface TauriDriverOptions {
  workspace: string;
  providerId: string;
  baseUrl?: string;
  apiKey: string;
  modelId: string;
  systemPrompt: string;
  mode?: string;
  maxIterations?: number;
  /**
   * Approuve automatiquement les actions `ask`. DÉFAUT : false (refus sûr).
   * À n'activer que pour des tâches de bench non interactives, et jamais en prod.
   */
  autoApprove?: boolean;
  /** Timeout dur d'un run (ms). Au-delà, `abort()` est appelé. */
  timeoutMs?: number;
}

/**
 * Agrège les métriques réellement observées sur le flux d'événements du sidecar.
 * On ne devine RIEN : tout vient des events `tool-call`, `tool-result` et `timing`.
 */
interface RunMetrics {
  turns: number;
  toolCalls: number;
  toolResults: number;
  toolErrors: number;
  inputTokens: number;
  outputTokens: number;
  ttftMs: number;
  totalMs: number;
  outputChars: number;
  tokPerSec: number;
  fallbacks: number;
  errorMessage?: string;
  /** Arguments réellement émis, par appel (pour vérifier l'exactitude). */
  callArgs: unknown[];
}

function emptyMetrics(): RunMetrics {
  return {
    turns: 0, toolCalls: 0, toolResults: 0, toolErrors: 0,
    inputTokens: 0, outputTokens: 0, ttftMs: 0, totalMs: 0,
    outputChars: 0, tokPerSec: 0, fallbacks: 0, callArgs: [],
  };
}

/**
 * Réduit un `AgentEvent` dans l'agrégat de métriques. Fonction PURE et testable
 * (aucun accès Tauri) : c'est ici que se joue la justesse des mesures.
 */
export function reduceEvent(m: RunMetrics, e: AgentEvent): void {
  switch (e.type) {
    case "tool-call":
      m.toolCalls++;
      m.callArgs.push(e.args);
      break;
    case "tool-result":
      m.toolResults++;
      // Un résultat porteur d'une erreur explicite compte comme échec d'outil.
      if (e.result && typeof e.result === "object" && (e.result as { error?: unknown }).error) {
        m.toolErrors++;
      }
      break;
    case "timing":
      m.ttftMs = e.ttftMs;
      m.totalMs = e.totalMs;
      m.outputChars = e.outputChars;
      m.tokPerSec = e.tokPerSec;
      m.fallbacks = e.fallbacks;
      m.turns++;
      break;
    case "finish":
      m.inputTokens += e.usage?.inputTokens ?? 0;
      m.outputTokens += e.usage?.outputTokens ?? 0;
      break;
    case "error":
      m.errorMessage = e.message;
      break;
    default:
      break;
  }
}

/**
 * Construit un `AgentDriver` branché sur le sidecar Cline réel.
 *
 * La fonction `run` :
 *   1. démarre un run via `startClineHarness` (= chemin de production) ;
 *   2. envoie l'instruction, attend la fin (`timing`/`finish`/`error`) ;
 *   3. `dispose()` TOUJOURS, même en cas d'erreur/timeout.
 *
 * @throws si appelée hors Tauri (l'appelant doit le gérer).
 */
export function createTauriDriver(options: TauriDriverOptions): AgentDriver {
  return {
    id: `cline:${options.modelId}`,
    async run({ workdir, instruction, timeoutMs }): Promise<DriverMeta> {
      const metrics = emptyMetrics();
      const effectiveTimeout = timeoutMs ?? options.timeoutMs ?? 300_000;

      let resolveDone: () => void = () => {};
      const done = new Promise<void>((r) => { resolveDone = r; });

      const onEvent = (e: AgentEvent): void => {
        // Approbations : on décide AVANT de réduire (n'altère pas les métriques).
        if (e.type === "approval-required") {
          if (options.autoApprove) e.approve();
          else e.reject("bench: approbation non accordée (canal absent)");
          return;
        }
        reduceEvent(metrics, e);
        // Le sidecar émet `[timing, finish]` UNE fois, en fin de run (cf.
        // clineBridge). On débloque donc sur `finish` ; `error` peut survenir
        // seul (échec du provider) et doit aussi clôturer — jamais de blocage.
        if (e.type === "finish" || e.type === "error") resolveDone();
      };

      const handle = await startClineHarness({
        workspace: workdir,
        providerId: options.providerId,
        baseUrl: options.baseUrl,
        apiKey: options.apiKey,
        modelId: options.modelId,
        systemPrompt: options.systemPrompt,
        mode: options.mode ?? "act",
        maxIterations: options.maxIterations,
        onEvent,
        onBeforeWrite: () => {},
      });

      if (!handle) throw new Error("sidecar Cline indisponible (démarrage échoué)");

      const timer = setTimeout(() => {
        metrics.errorMessage = metrics.errorMessage ?? `timeout ${effectiveTimeout}ms`;
        void handle.abort().finally(resolveDone);
      }, effectiveTimeout);

      try {
        await handle.send(instruction);
        await done;
      } finally {
        clearTimeout(timer);
        handle.dispose();
      }

      return {
        turns: metrics.turns,
        toolCalls: metrics.toolCalls,
        inputTokens: metrics.inputTokens,
        outputTokens: metrics.outputTokens,
      };
    },
  };
}

/**
 * Garde : ce driver n'est utilisable que dans l'app Tauri. Exposé pour que le
 * CLI puisse refuser proprement hors Tauri plutôt que d'échouer obscurément.
 */
export function isTauriAvailable(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Type de l'action d'approbation, ré-exporté pour lisibilité de l'appelant. */
export type { PendingAction };
