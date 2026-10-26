// Préchargement : patche globalThis.fetch pour journaliser CHAQUE appel
// réseau du SDK, puis démarre le vrai sidecar. Objectif : savoir si le SDK
// émet sa requête vers api.orvyx-ai.com (attendu) ou api.cline.bot (bogue).
const _f = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input?.url;
  process.stderr.write("[NETSPY] fetch " + url + "\n");
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
