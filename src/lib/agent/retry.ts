// ── Reprise sur erreur transitoire (porté de jcode `turn_retry.rs`) ─────────────
//
// Un tour d'agent peut échouer sur une erreur que la tentative suivante résoudra
// probablement : connexion coupée, timeout, provider surchargé, rate-limit court.
// En revanche, tout ce qui échouera identiquement à chaque tentative (identifiants,
// facturation, quota, requête invalide, refus de garde-fou) n'est JAMAIS réessayé.
//
// Classification par précédence : Permanent > RateLimited > Transient > Permanent
// (défaut). Les codes HTTP sont reconnus comme nombres isolés, pour ne pas confondre
// un identifiant de requête (`req_15030`) avec un statut 503.

export type FailureKind = "permanent" | "rate-limited" | "transient";

export const MAX_ATTEMPTS = 3;              // tentatives automatiques par requête
export const BASE_DELAY_MS = 3_000;         // 3 s
export const MAX_DELAY_MS = 30_000;         // 30 s
export const MAX_RATE_LIMIT_WAIT_MS = 5 * 60_000; // 5 min

/** Rappel injecté en tour suivant pour reprendre sans rejouer les outils déjà faits. */
export const CONTINUATION_REMINDER =
  "[auto] The previous request failed with a transient error and was retried automatically. " +
  "Continue the task from where you left off. Do not repeat tool calls or edits that already completed.";

const RATE_LIMIT_CODES = ["429"];
const TRANSIENT_CODES = ["500", "502", "503", "504", "529"];

const PERMANENT_MARKERS = [
  "unauthorized", "status 401", "error 401", "403 forbidden", "forbidden",
  "invalid api key", "insufficient_quota", "payment required", "usage_limit_reached",
  "quota exceeded", "400 bad request", "invalid_request_error", "context_length_exceeded",
  "request too large", "payload too large", "invalid model", "unsupported parameter",
  "content_policy_violation", "safety_violation", "guardrail",
  "interrupted by user", "cancelled", "canceled",
];

const RATE_LIMIT_MARKERS = ["rate limit", "rate_limit", "ratelimit", "too many requests"];

const TRANSIENT_MARKERS = [
  "connection reset", "connection closed", "broken pipe", "unexpected eof", "close_notify",
  "stream error", "stream stalled", "no data received", "timed out", "timeout",
  "500 internal server error", "internal server error", "bad gateway", "service unavailable",
  "gateway timeout", "overloaded", "server_error", "api_error", "temporarily unavailable",
  "try again",
];

/** Le code numérique apparaît-il comme un token isolé (pas dans `req_15030`) ? */
export function containsCode(lower: string, code: string): boolean {
  let from = 0;
  for (;;) {
    const idx = lower.indexOf(code, from);
    if (idx === -1) return false;
    const before = idx > 0 ? lower[idx - 1] : "";
    const after = idx + code.length < lower.length ? lower[idx + code.length] : "";
    const isAlnum = (c: string) => c !== "" && /[a-z0-9]/.test(c);
    if (!isAlnum(before) && !isAlnum(after)) return true;
    from = idx + code.length;
  }
}

/** Parse un délai « Retry-After » textuel (ms / s / m / h). `null` si absent. */
export function parseRetryAfter(lower: string): number | null {
  const retryIdx = lower.indexOf("retry");
  if (retryIdx === -1) return null;
  const words = lower.slice(retryIdx).split(/\s+/).slice(0, 8);
  for (const w of words) {
    const m = w.match(/^(\d+)/);
    if (!m) continue;
    const value = Number(m[1]);
    if (!Number.isFinite(value) || value <= 0) continue;
    if (/ms|milliseconds?/.test(w)) return value;
    if (/h|hrs?|hours?/.test(w)) return value * 3_600_000;
    if (/m|mins?|minutes?/.test(w) && !/ms/.test(w)) return value * 60_000;
    return value * 1_000;
  }
  return null;
}

export function classifyFailure(message: string, retryAfterMs: number | null): FailureKind {
  const lower = message.toLowerCase();

  if (PERMANENT_MARKERS.some(m => lower.includes(m))) return "permanent";

  const isRateLimited =
    retryAfterMs != null ||
    RATE_LIMIT_CODES.some(c => containsCode(lower, c)) ||
    RATE_LIMIT_MARKERS.some(m => lower.includes(m));
  if (isRateLimited) return "rate-limited";

  if (TRANSIENT_CODES.some(c => containsCode(lower, c))) return "transient";
  if (TRANSIENT_MARKERS.some(m => lower.includes(m))) return "transient";

  return "permanent";
}

/**
 * Délai avant la tentative `attempt` (1-based), ou `null` s'il ne faut pas réessayer.
 * Backoff exponentiel `base * 2^(attempt-1)` avec jitter ±20 % (anti-thundering-herd),
 * plafonné à `MAX_DELAY_MS`. Un délai serveur (`Retry-After`) prime, à condition de
 * rester sous `MAX_RATE_LIMIT_WAIT_MS`.
 */
export function retryDelayMs(kind: FailureKind, attempt: number, retryAfterMs: number | null): number | null {
  const maxAttempts = MAX_ATTEMPTS;
  if (kind === "permanent") return null;
  if (attempt > maxAttempts) return null;

  if (kind === "rate-limited") {
    if (retryAfterMs == null) return null;
    if (retryAfterMs > MAX_RATE_LIMIT_WAIT_MS) return null;
    return Math.max(retryAfterMs, BASE_DELAY_MS);
  }

  const exp = BASE_DELAY_MS * 2 ** Math.min(attempt - 1, 16);
  const jittered = exp * (0.8 + Math.random() * 0.4);
  return Math.min(jittered, MAX_DELAY_MS);
}
