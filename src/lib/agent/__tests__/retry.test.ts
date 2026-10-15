import { describe, it, expect, vi, afterEach } from "vitest";
import {
  classifyFailure, parseRetryAfter, retryDelayMs, containsCode,
  MAX_ATTEMPTS, BASE_DELAY_MS, MAX_RATE_LIMIT_WAIT_MS,
} from "../retry";

describe("classifyFailure", () => {
  it("classe les erreurs permanentes (auth, quota, requête invalide)", () => {
    expect(classifyFailure("401 Unauthorized", null)).toBe("permanent");
    expect(classifyFailure("Invalid API key provided", null)).toBe("permanent");
    expect(classifyFailure("You exceeded your current quota", null)).toBe("permanent");
    expect(classifyFailure("400 Bad Request: context_length_exceeded", null)).toBe("permanent");
  });

  it("classe les rate-limits (429, Retry-After, libellé)", () => {
    expect(classifyFailure("status 429", null)).toBe("rate-limited");
    expect(classifyFailure("anything", 5_000)).toBe("rate-limited");
    expect(classifyFailure("Too many requests", null)).toBe("rate-limited");
  });

  it("classe les erreurs transitoires (5xx, timeout, déconnexion)", () => {
    expect(classifyFailure("503 Service Unavailable", null)).toBe("transient");
    expect(classifyFailure("529 overloaded", null)).toBe("transient");
    expect(classifyFailure("connection reset by peer", null)).toBe("transient");
    expect(classifyFailure("request timed out", null)).toBe("transient");
  });

  // Contrat silencieux entre `run.ts` (qui LEVE ces messages à l'abandon d'une
  // tentative) et `retry.ts` (qui doit les classer « transient » pour déclencher
  // la cascade/reprise plutôt qu'un échec définitif). Si un message est reformulé
  // côté run.ts, ce test casse — c'est voulu : sinon un tour figé repartirait en
  // échec permanent silencieux.
  it("classe les abandons internes du harness en transitoires", () => {
    expect(classifyFailure("Model stream stalled mid-response (inactivity timeout)", null)).toBe("transient");
    expect(classifyFailure("Model first token timed out (TTFT above budget)", null)).toBe("transient");
    expect(classifyFailure("Model stream produced no output (timeout)", null)).toBe("transient");
  });

  it("ne confond pas un identifiant de requête avec un code HTTP", () => {
    // `req_15030` contient 5030, pas 503 ; et aucun marqueur ne matche.
    expect(containsCode("req_15030", "503")).toBe(false);
    expect(containsCode("error 503 while streaming", "503")).toBe(true);
  });

  it("par défaut (message inconnu) classe en permanent (pas de retry aveugle)", () => {
    expect(classifyFailure("something weird happened", null)).toBe("permanent");
  });
});

describe("parseRetryAfter", () => {
  it("renvoie null sans indication de retry", () => {
    expect(parseRetryAfter("boom")).toBeNull();
  });

  it("parse les secondes par défaut", () => {
    expect(parseRetryAfter("retry after 30")).toBe(30_000);
  });

  it("parse les unités ms / m / h", () => {
    expect(parseRetryAfter("retry after 500ms")).toBe(500);
    expect(parseRetryAfter("retry after 2m")).toBe(120_000);
    expect(parseRetryAfter("retry after 1h")).toBe(3_600_000);
  });
});

describe("retryDelayMs", () => {
  afterEach(() => vi.restoreAllMocks());

  it("ne réessaie jamais une erreur permanente", () => {
    expect(retryDelayMs("permanent", 1, null)).toBeNull();
  });

  it("arrête après MAX_ATTEMPTS", () => {
    expect(retryDelayMs("transient", MAX_ATTEMPTS + 1, null)).toBeNull();
  });

  it("applique un backoff exponentiel borné et jitteré", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5); // jitter neutre (×1.0)
    expect(retryDelayMs("transient", 1, null)).toBe(BASE_DELAY_MS);
    expect(retryDelayMs("transient", 2, null)).toBe(BASE_DELAY_MS * 2);
    // La tentative 3 (4× base = 12 s, sous 30 s) reste un backoff normal.
    expect(retryDelayMs("transient", 3, null)).toBe(BASE_DELAY_MS * 4);
  });

  it("privilégie le Retry-After serveur pour un rate-limit, dans la limite du cap", () => {
    expect(retryDelayMs("rate-limited", 1, 7_000)).toBe(7_000);
    // Un délai serveur minuscule est remonté à BASE_DELAY_MS.
    expect(retryDelayMs("rate-limited", 1, 100)).toBe(BASE_DELAY_MS);
    // Au-delà du cap, on abandonne plutôt que d'attendre trop longtemps.
    expect(retryDelayMs("rate-limited", 1, MAX_RATE_LIMIT_WAIT_MS + 1)).toBeNull();
  });

  it("sans Retry-After, un rate-limit n'est pas réessayé (le serveur ne l'a pas demandé)", () => {
    expect(retryDelayMs("rate-limited", 1, null)).toBeNull();
  });
});
