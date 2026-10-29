// Préchargement de diagnostic : patche globalThis.fetch pour journaliser CHAQUE
// appel réseau du SDK, puis démarre le vrai sidecar. Sert à vérifier vers quel
// hôte le SDK route réellement (api.orvyx-ai.com attendu), ce qu'il envoie
// (model / max_tokens / stream / tools) et le code HTTP renvoyé.
//
// Usage : node --import ./__netspy.mjs ... , ou via mira_diag.mjs.
const _f = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input?.url;
  const body = init?.body;
  process.stderr.write("[NETSPY] fetch " + url + "\n");
  if (url && String(url).includes("/chat/completions") && body) {
    const raw = typeof body === "string" ? body : "[non-string body]";
    try {
      const o = JSON.parse(raw);
      process.stderr.write(
        "[NETSPY] META " +
          JSON.stringify({
            model: o.model,
            max_tokens: o.max_tokens,
            stream: o.stream,
            messages: Array.isArray(o.messages) ? o.messages.length : null,
            tools: Array.isArray(o.tools) ? o.tools.length : null,
          }) +
          "\n",
      );
    } catch {
      process.stderr.write("[NETSPY] BODY " + raw.slice(0, 300) + "\n");
    }
  }
  try {
    const r = await _f(input, init);
    process.stderr.write("[NETSPY] <- " + r.status + " " + url + "\n");
    return r;
  } catch (e) {
    process.stderr.write("[NETSPY] !! " + String(e) + " " + url + "\n");
    throw e;
  }
};
await import("./dist/index.mjs");
