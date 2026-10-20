/**
 * Origin — Client HEADLESS du sidecar Cline (pilotage Node pur, sans Tauri).
 *
 * (Voir la note de périmètre plus bas.)
 *
 * POURQUOI CE MODULE
 * ------------------
 * Le moteur d'agent de production (`src-tauri/cline-sidecar/src/index.ts`) est un
 * process Node AUTONOME qui parle un protocole NDJSON sur stdin/stdout. Rust ne
 * fait que relayer ce flux vers la webview Tauri via `invoke`/`listen`.
 * Conséquence : un harnais de benchmark lancé depuis la WEBVIEW dépend de l'UI
 * (montage React, injection `import.meta.env`, focus fenêtre) — fragile et
 * inutilisable en CI. Ce module reproduit le rôle de Rust (spawn + relais NDJSON)
 * en Node pur, ce qui rend un bench RÉEL reproductible et publiable.
 *
 * PÉRIMÈTRE / HONNÊTETÉ
 * ---------------------
 *  - On n'émule PAS le SDK : on lance le VRAI bundle `dist/index.mjs` (celui que
 *    Rust lance en dev), avec le VRAI modèle et les VRAIS exécuteurs d'outils
 *    (lecture, édition, shell, patch) du SDK Cline.
 *  - Les outils qui dépendent d'une capability Tauri (navigateur, index
 *    codebase) émettent un `tool_invoke` que PERSONNE ne peut honorer ici. On ne
 *    les DÉCLARE donc pas (`extraTools` omis) : le sidecar ne les crée pas et
 *    l'agent ne peut pas les appeler. Aucune fausse réussite.
 *  - Les approbations sont décidées LOCALEMENT selon une politique explicite et
 *    journalisée. Par défaut : tout est REFUSÉ (le plus sûr). Le runner de bench
 *    passe `autoApprove: true` pour un run non interactif, ce qui est journalisé.
 *
 * SÉCURITÉ
 * --------
 *  - `env_clear` + réinjection minimale (PATH, HOME, CLINE_DIR) : même politique
 *    que Rust (`sidecar.rs`) — pas de fuite de l'environnement du parent.
 *  - La clé d'API n'est JAMAIS journalisée ni écrite dans un résultat : elle
 *    transite une seule fois, dans la commande `start`, vers le sidecar.
 *  - `CLINE_DIR` est pointé vers un dossier jetable du run (stockage SQLite),
 *    jamais vers le `~/.cline` de l'utilisateur.
 *  - `kill_on_drop` équivalent : à la fermeture, on envoie `shutdown` puis on
 *    tue le process (groupe) pour ne jamais laisser de Node orphelin.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";

/** Événement normalisé du flux d'agent (sous-ensemble utilisé par le bench). */
export interface HeadlessEvent {
  /** Type d'origine du SDK (`message-part`, `step-finish`, `usage`, `done`, …). */
  type: string;
  /** Charge brute de l'événement (jamais ré-émise telle quelle dans un résultat). */
  raw: Record<string, unknown>;
}

/** Événement de contenu d'agent BRUT du SDK (sous-ensemble, cf. clineBridge). */
interface RawAgentEvent {
  type?: string;
  contentType?: "text" | "reasoning" | "media" | "tool";
  text?: string;
  reasoning?: string;
  toolName?: string;
  toolCallId?: string;
  iteration?: number;
  hadToolCalls?: boolean;
  toolCallCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  noticeType?: string;
  message?: string;
  reason?: string;
  error?: { message?: string } | string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

/** Enveloppe `CoreSessionEvent` émise sur stdout (`{kind:"event"}`). */
interface SessionEnvelope {
  type?: string;
  payload?: { sessionId?: string; event?: RawAgentEvent };
}

/** Demande d'approbation émise par le sidecar (`kind:"tool_approval"`). */
export interface ApprovalRequest {
  requestId: string;
  toolName: string;
  toolCallId?: string;
  input: unknown;
  policy?: unknown;
}

/** Politique d'approbation : décide, pour chaque demande, si l'outil s'exécute. */
export type ApprovalPolicy = (req: ApprovalRequest) => boolean;

/** Options du client headless. */
export interface HeadlessClientOptions {
  /** Chemin du bundle sidecar (`src-tauri/cline-sidecar/dist/index.mjs`). */
  sidecarPath: string;
  /** Dossier de données isolé (SQLite Cline). Créé par le sidecar. */
  dataDir: string;
  /** Binaire Node ≥ 22. Défaut : `process.execPath`. */
  nodePath?: string;
  /** Politique d'approbation. Défaut : refus de tout (le plus sûr). */
  approvalPolicy?: ApprovalPolicy;
  /** Reçoit chaque événement du flux (optionnel, pour debug/observabilité). */
  onEvent?: (e: HeadlessEvent) => void;
  /** Reçoit chaque trace de debug du client (jamais un secret). */
  onLog?: (msg: string) => void;
}

/** Paramètres d'un `start` (session neuve). Mêmes champs que le protocole. */
export interface HeadlessStartParams {
  cwd: string;
  providerId: string;
  baseUrl?: string;
  apiKey: string;
  modelId: string;
  systemPrompt: string;
  mode?: string;
  maxIterations?: number;
}

/** Métriques réellement observées sur un run (aucune estimation). */
export interface HeadlessRunMetrics {
  /** Nombre d'itérations de la boucle d'outils (un `step-finish` = un tour). */
  turns: number;
  /** Nombre d'appels d'outils émis par le modèle. */
  toolCalls: number;
  /** Tokens d'entrée cumulés (issus des événements `usage`). */
  inputTokens: number;
  /** Tokens de sortie cumulés. */
  outputTokens: number;
  /** Délai jusqu'au premier événement de contenu (ms), 0 si jamais émis. */
  ttftMs: number;
  /** Durée totale du run (ms). */
  totalMs: number;
  /** Message d'erreur terminal, si le run a échoué. */
  error?: string;
}

/** Handle d'un run headless : session + métriques + attente de fin. */
export interface HeadlessRun {
  /** Id de session côté SDK. */
  sessionId: string;
  /** Résolue quand le run se termine (`done`/`error`) ou après abort. */
  finished: Promise<void>;
  /** Métriques observées (remplies au fil du run, définitives à `finished`). */
  metrics: HeadlessRunMetrics;
  /**
   * Concaténation des blocs de texte RÉELLEMENT émis par l'agent sur ce tour
   * (événements `content_end` de type `text`). Sert au runner LCB pour extraire
   * la solution proposée. Chaîne vide si l'agent n'a produit aucun texte.
   */
  finalText: string;
  /** Interrompt proprement la session (best-effort). */
  abort: () => Promise<void>;
}

/** Erreur typée portant le code protocolaire du sidecar (jamais un secret). */
export class SidecarError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "SidecarError";
  }
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

/**
 * Client NDJSON du sidecar. Une instance = un process sidecar = un `CLINE_DIR`.
 * Les sessions (`start`/`send`) sont séquentielles côté bench : un seul run
 * actif à la fois, ce qui simplifie le routage des événements.
 */
export class ClineSidecarClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private rl: Interface | null = null;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly opts: HeadlessClientOptions;
  private readonly log: (msg: string) => void;
  /** Session courante : sortie d'événements + fin de run. */
  private current:
    | {
        sessionId: string;
        onEvent: (e: HeadlessEvent) => void;
        resolveDone: () => void;
      }
    | null = null;

  constructor(opts: HeadlessClientOptions) {
    this.opts = opts;
    this.log = opts.onLog ?? (() => {});
  }

  /** Démarre le process sidecar et attend la ligne `{kind:"ready"}`. */
  async start(): Promise<void> {
    if (!existsSync(this.opts.sidecarPath)) {
      throw new SidecarError("SIDECAR_MISSING", `bundle sidecar introuvable : ${this.opts.sidecarPath}`);
    }
    const node = this.opts.nodePath ?? process.execPath;
    // Le sidecar doit avoir un cwd valide : Rust le crée en amont, en headless
    // c'est à nous de le garantir (un cwd inexistant fait échouer spawn() avec
    // un ENOENT trompeur pointant sur le binaire Node).
    await mkdir(this.opts.dataDir, { recursive: true });
    // Même politique d'environnement que Rust : on n'hérite de RIEN sauf d'un
    // PATH fonctionnel, du HOME et du dossier de données isolé.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/local/bin",
      HOME: process.env.HOME ?? "",
      CLINE_DIR: this.opts.dataDir,
      CLINE_DATA_DIR: this.opts.dataDir,
    };
    this.child = spawn(node, [this.opts.sidecarPath], {
      cwd: this.opts.dataDir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // stderr = diagnostic du sidecar : on le relaie comme trace, jamais comme
    // résultat (aucune clé n'y transite, le sidecar ne ré-émet jamais apiKey).
    this.child.stderr.on("data", (b: Buffer) => {
      const s = b.toString().trim();
      if (s) this.log(`[sidecar stderr] ${s}`);
    });

    this.rl = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    const readyPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new SidecarError("SIDECAR_READY_TIMEOUT", "pas de `ready` en 60 s")), 60_000);
      this.rl!.on("line", (line) => {
        const handled = this.handleLine(line, () => {
          clearTimeout(timer);
          resolve();
        });
        if (!handled) this.log(`[sidecar inattendu] ${line.slice(0, 200)}`);
      });
      this.child!.on("exit", (code, sig) => {
        clearTimeout(timer);
        reject(new SidecarError("SIDECAR_EXIT", `sidecar terminé (code=${code} sig=${sig}) avant ready`));
      });
    });
    await readyPromise;
    this.log("[client] sidecar prêt");
  }

  /** Envoie une commande et attend sa réponse `{id, ok, result|error}`. */
  private command(type: string, fields: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.child) return Promise.reject(new SidecarError("NOT_STARTED", "client non démarré"));
    const id = ++this.seq;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const line = JSON.stringify({ id, type, ...fields });
      this.child!.stdin.write(`${line}\n`);
    });
  }

  /**
   * Route UNE ligne stdout. Renvoie `false` si la ligne n'est pas reconnue.
   * - `{id:numeric, ok:bool}` → réponse de commande.
   * - `{kind:"ready"}` → handshake.
   * - `{kind:"event"}` → événement de session.
   * - `{kind:"tool_approval"}` → décision locale (politique).
   * - `{kind:"tool_write"}` → acquittement immédiat (le bench ne fait pas de
   *   checkpoint undo/keep : acquitter est le comportement attendu ici).
   * - `{kind:"tool_invoke"}` → refus EXPLICITE (« capability Tauri absente »),
   *   pour que l'outil échoue vite et proprement au lieu d'attendre 30 s.
   */
  private handleLine(line: string, onReady: () => void): boolean {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return false;
    }

    if (typeof msg.id === "number" && typeof msg.ok === "boolean") {
      const p = this.pending.get(msg.id);
      if (!p) return true;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else {
        const err = msg.error as { code?: string; message?: string } | undefined;
        p.reject(new SidecarError(err?.code ?? "SIDECAR_ERROR", err?.message ?? "échec commande"));
      }
      return true;
    }

    const kind = msg.kind;
    if (kind === "ready") {
      onReady();
      return true;
    }
    if (kind === "event") {
      // Le sidecar enveloppe les événements : `{kind:"event", event:{type, payload:{event:{…}}}}`.
      // Seul `type === "agent_event"` porte du contenu d'agent ; les autres
      // (`chunk`, `status`, `session_snapshot`, `hook`, `ended`, …) sont du
      // transport. On ne remonte au runner que les événements d'agent.
      const env = (msg.event ?? {}) as SessionEnvelope;
      if (env.type === "agent_event" && env.payload?.event?.type) {
        this.current?.onEvent({ type: String(env.payload.event.type), raw: env.payload.event as Record<string, unknown> });
      } else if (env.type === "ended") {
        // La session s'est arrêtée côté moteur sans `done` : on clôt pour que le
        // run ne reste pas suspendu (même logique que `clineBridge.translateEnded`).
        this.current?.onEvent({ type: "ended", raw: env as Record<string, unknown> });
      }
      return true;
    }
    if (kind === "tool_approval") {
      const req: ApprovalRequest = {
        requestId: String(msg.requestId),
        toolName: String(msg.toolName),
        toolCallId: msg.toolCallId ? String(msg.toolCallId) : undefined,
        input: msg.input,
        policy: msg.policy,
      };
      const approved = this.opts.approvalPolicy ? this.opts.approvalPolicy(req) : false;
      void this.command("tool_approval_response", {
        requestId: req.requestId,
        approved,
        ...(approved ? {} : { reason: "headless: refusé par la politique du bank" }),
      }).catch(() => undefined);
      return true;
    }
    if (kind === "tool_write") {
      // Le bench n'entretient pas l'undo/keep : l'écriture est actée (acquittée).
      void this.command("tool_write_response", { requestId: String(msg.requestId) }).catch(() => undefined);
      return true;
    }
    if (kind === "tool_invoke") {
      // Aucune capability Tauri ici : on répond un échec EXPLICITE pour que
      // l'outil échoue immédiatement (pas de fausse réussite, pas d'attente 30 s).
      void this.command("tool_invoke_response", {
        requestId: String(msg.requestId),
        error: "capability Tauri indisponible en mode headless",
      }).catch(() => undefined);
      return true;
    }
    return false;
  }

  /**
   * Crée une session (`start`) puis exécute un tour (`send`). Résout quand le
   * tour est terminé (`done`/`error`) ou après `abort`.
   *
   * @returns handle exposant sessionId, métriques vivantes, et `finished`.
   */
  async runTurn(params: HeadlessStartParams, prompt: string): Promise<HeadlessRun> {
    const metrics: HeadlessRunMetrics = { turns: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, ttftMs: 0, totalMs: 0 };
    const t0 = Date.now();
    let firstContent = 0;
    const textParts: string[] = [];

    const result = (await this.command("start", {
      cwd: params.cwd,
      apiKey: params.apiKey,
      baseUrl: params.baseUrl,
      modelId: params.modelId,
      providerId: params.providerId,
      systemPrompt: params.systemPrompt,
      mode: params.mode ?? "act",
      ...(typeof params.maxIterations === "number" ? { maxIterations: params.maxIterations } : {}),
    })) as { sessionId?: string };
    const sessionId = result?.sessionId;
    if (!sessionId) throw new SidecarError("NO_SESSION", "`start` n'a pas renvoyé de sessionId");

    let resolveDone: () => void = () => {};
    const finished = new Promise<void>((r) => { resolveDone = r; });
    let settled = false;
    const settle = (): void => { if (!settled) { settled = true; resolveDone(); } };

    this.current = {
      sessionId,
      resolveDone: settle,
      onEvent: (e) => {
        // Agrégation PURE des métriques, sur les types RÉELS du SDK Cline
        // (cf. `clineBridge.ts`) : `iteration_end` = fin d'un tour, `usage` =
        // totaux cumulés, `content_end` de type `tool` = fin d'un appel d'outil,
        // `done` = fin de session. Aucune estimation.
        const t = e.type;
        const raw = e.raw as RawAgentEvent;
        if (t === "content_update" && (raw.contentType === "text" || raw.contentType === "reasoning")) {
          if (firstContent === 0) firstContent = Date.now();
        } else if (t === "content_end") {
          // Bloc de texte clos : c'est le contenu RÉEL du message de l'agent.
          if (raw.contentType === "text" && typeof raw.text === "string") textParts.push(raw.text);
        } else if (t === "iteration_end") {
          metrics.turns++;
          metrics.toolCalls += raw.toolCallCount ?? (raw.hadToolCalls ? 1 : 0);
        } else if (t === "usage") {
          // Le SDK fournit des TOTAUX cumulés : on les prend tels quels (dernier
          // `usage` = vérité du run), au lieu d'additionner des deltas.
          metrics.inputTokens = raw.totalInputTokens ?? raw.inputTokens ?? metrics.inputTokens;
          metrics.outputTokens = raw.totalOutputTokens ?? raw.outputTokens ?? metrics.outputTokens;
        } else if (t === "error") {
          const em = typeof raw.error === "string" ? raw.error : raw.error?.message;
          metrics.error = em ?? raw.message ?? "erreur agent";
          settle();
        } else if (t === "done") {
          // Le `done` porte l'usage TOTAL définitif : on l'écrit en dernier.
          if (raw.usage) {
            metrics.inputTokens = raw.usage.inputTokens ?? metrics.inputTokens;
            metrics.outputTokens = raw.usage.outputTokens ?? metrics.outputTokens;
          }
          if (raw.reason && raw.reason !== "completed") {
            metrics.error = metrics.error ?? `run terminé : ${raw.reason}`;
          }
          settle();
        } else if (t === "ended") {
          // Session arrêtée côté moteur sans `done` : on clôt sans inventer.
          settle();
        }
        this.opts.onEvent?.(e);
      },
    };

    void this.command("send", { sessionId, prompt }).catch((e) => {
      metrics.error = metrics.error ?? `send: ${e instanceof Error ? e.message : String(e)}`;
      // Un rejet de `send` (souvent un timeout d'acquittement côté canal) n'est
      // PAS une fin de run : on laisse `finished` se résoudre sur `done`/`error`
      // ou sur l'abort appelé par le timeout du runner.
    });

    const run: HeadlessRun = {
      sessionId,
      finished,
      metrics,
      get finalText(): string {
        return textParts.join("\n");
      },
      abort: async () => {
        await this.command("abort", { sessionId }).catch(() => undefined);
        settle();
      },
    };
    void finished.then(() => {
      metrics.totalMs = Date.now() - t0;
      metrics.ttftMs = firstContent > 0 ? firstContent - t0 : 0;
    });
    return run;
  }

  /** Arrête proprement le sidecar (`shutdown`) puis tue le process si besoin. */
  async dispose(): Promise<void> {
    if (!this.child) return;
    try {
      await Promise.race([
        this.command("shutdown"),
        new Promise((r) => setTimeout(r, 2000)),
      ]);
    } catch {
      // ignore : on tue de toute façon ci-dessous.
    }
    this.rl?.close();
    this.child.kill("SIGTERM");
    setTimeout(() => this.child?.kill("SIGKILL"), 1500).unref?.();
    this.child = null;
  }
}
