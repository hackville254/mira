// Sonde STATIQUE : on interroge le SDK Cline lui-même pour savoir
// (1) si `orvyx` est un provider built-in, (2) si `openai-compatible` l'est,
// (3) ce que renvoie `createProviderConfig` (ProviderSettings -> ProviderConfig)
// pour notre configuration réelle. Aucune requête réseau n'est émise.
import * as C from "@cline/core";

function line(label, v) {
  console.log(label, JSON.stringify(v));
}

line("BUILT_IN_PROVIDER_IDS =", C.BUILT_IN_PROVIDER_IDS);
console.log("isBuiltIn(orvyx) =", C.isBuiltInProviderId("orvyx"));
console.log("isBuiltIn(openai-compatible) =", C.isBuiltInProviderId("openai-compatible"));
console.log("isBuiltIn(openai) =", C.isBuiltInProviderId("openai"));

// `ProviderSettings` : { provider, model, apiKey, baseUrl, client, routingProviderId }
// -> c'est LA forme que le SDK convertit en `ProviderConfig`.
const cfg = C.createProviderConfig({
  provider: "orvyx",
  model: "deepseek-v4-flash-0731",
  apiKey: "oryx_test",
  baseUrl: "https://api.orvyx-ai.com/v1",
  client: "openai-compatible",
  routingProviderId: "openai-compatible",
});

line("createProviderConfig(orvyx) ->", cfg);
console.log("  providerId      =", cfg.providerId);
console.log("  clientType      =", cfg.clientType);
console.log("  routingProviderId =", cfg.routingProviderId);
console.log("  baseUrl         =", cfg.baseUrl);
console.log("  modelId         =", cfg.modelId);
