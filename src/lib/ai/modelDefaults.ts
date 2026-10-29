/**
 * Mira — Défauts neutres du modèle actif.
 *
 * Il n'existe PLUS de catalogue de providers codé en dur : l'application ne
 * fonctionne qu'avec les modèles déclarés par le client (Settings → Models).
 * Ces deux constantes ne sont donc que des valeurs de REPLI neutres, utilisées
 * tant qu'aucun modèle n'a été configuré — jamais un catalogue implicite.
 *
 * Les identifiants sont volontairement reconnaissables : s'ils apparaissent
 * dans une requête, c'est qu'aucun modèle n'est configuré, ce qui est
 * exactement l'information à remonter à l'utilisateur.
 */
export const DEFAULT_MODEL_ID = "unconfigured-model";
export const DEFAULT_PROVIDER_ID = "unconfigured";
