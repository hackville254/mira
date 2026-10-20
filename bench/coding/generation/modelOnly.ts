// ── Génération — MODE MODEL-ONLY (le modèle SEUL, sans harness) ───────────────
//
// POURQUOI CE MODE (Phase 3 de la mission)
// ----------------------------------------
// Pour attribuer un échec à la bonne couche, il faut pouvoir mesurer le MODÈLE
// sans les capacités du harness ORVYX Code : pas d'outils, pas d'édition de
// fichiers, pas de boucle d'itération, pas de vérification automatique. On
// appelle DIRECTEMENT l'endpoint OpenAI Chat Completions du fournisseur avec un
// prompt standardisé, et on note la réponse avec le MÊME évaluateur que le mode
// agent.
//
// Ce que ce mode mesure : la capacité intrinsèque du modèle à produire une
// fonction correcte en un seul tour.
// Ce qu'il NE mesure PAS : la planification, l'usage des outils, la vérification.
//
// SÉCURITÉ : la clé d'API transite une seule fois par requête ; elle n'est
// JAMAIS journalisée ni écrite dans un résultat.

/** Sortie d'un appel model-only. */
export interface ModelCallResult {
  /** Texte (concaténation des deltas de contenu). */
  text: string;
  /** Raison d'arrêt rapportée par le fournisseur (`stop`, `length`, …). */
  finishReason?: string;
  /** Statut HTTP (renseigné aussi en cas d'erreur). */
  httpStatus?: number;
  /** Classe d'erreur fournisseur, si l'appel a échoué. */
  errorClass?: "provider" | "timeout" | "truncated";
  /** Message d'erreur borné (jamais de secret). */
  error?: string;
  /** Métriques observées. */
  metrics: {
    totalMs: number;
    ttftMs?: number;
    inputTokens?: number;
    outputTokens?: number;
  };
}

export interface ModelOnlyOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Prompt système (standardisé, identique pour tous les modèles). */
  system: string;
  /** Enoncé de la tâche. */
  user: string;
  /** Budget de tokens de sortie. */
  maxTokens?: number;
  /** Timeout (ms). Défaut : 120 s. */
  timeoutMs?: number;
  /** Température (défaut 0 pour la reproductibilité). */
  temperature?: number;
}

/**
 * Appelle le fournisseur en streaming et renvoie le texte complet + métriques.
 * Ne lève jamais : toute erreur est classée et renvoyée dans le résultat.
 */
export async function callModelOnly(opts: ModelOnlyOptions): Promise<ModelCallResult> {
  const t0 = Date.now();
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const metrics: ModelCallResult["metrics"] = { totalMs: 0 };
  try {
    const body = {
      model: opts.model,
      stream: true,
      stream_options: { include_usage: true },
      temperature: opts.temperature ?? 0,
      max_tokens: opts.maxTokens ?? 1024,
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.user },
      ],
    };
    const res = await fetch(`${opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      metrics.totalMs = Date.now() - t0;
      return {
        text: "",
        httpStatus: res.status,
        // 429 et 5xx = fournisseur ; 4xx = configuration/harnais côté client.
        errorClass: res.status === 429 || res.status >= 500 ? "provider" : "provider",
        error: `HTTP ${res.status} ${text.slice(0, 200)}`,
        metrics,
      };
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let text = "";
    let ttft: number | undefined;
    let finishReason: string | undefined;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith("data:")) continue;
        const payload = s.slice(5).trim();
        if (payload === "[DONE]") continue;
        let j: {
          choices?: { delta?: { content?: string }; finish_reason?: string }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        try { j = JSON.parse(payload); } catch { continue; }
        if (j.usage) {
          metrics.inputTokens = j.usage.prompt_tokens ?? metrics.inputTokens;
          metrics.outputTokens = j.usage.completion_tokens ?? metrics.outputTokens;
        }
        const choice = j.choices?.[0];
        if (!choice) continue;
        if (choice.delta?.content) {
          if (ttft === undefined) ttft = Date.now() - t0;
          text += choice.delta.content;
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    }

    metrics.totalMs = Date.now() - t0;
    metrics.ttftMs = ttft;
    // Une réponse coupée pour cause de longueur est une réponse TRONQUÉE : on
    // l'étiquette comme telle pour ne pas la confondre avec un échec du modèle.
    if (finishReason === "length") {
      return { text, finishReason, errorClass: "truncated", error: "réponse tronquée (finish_reason=length)", metrics };
    }
    return { text, finishReason, metrics };
  } catch (e) {
    metrics.totalMs = Date.now() - t0;
    const isAbort = e instanceof Error && (e.name === "AbortError" || /aborted/i.test(e.message));
    return {
      text: "",
      errorClass: isAbort ? "timeout" : "provider",
      error: `${isAbort ? "timeout" : "erreur réseau"} : ${e instanceof Error ? e.message : String(e)}`.slice(0, 200),
      metrics,
    };
  } finally {
    clearTimeout(timer);
  }
}
