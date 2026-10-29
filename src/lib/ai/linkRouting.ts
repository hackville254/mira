/**
 * Routage des liens cliqués dans un message de l'agent.
 *
 * Problème corrigé : le markdown rendait un `<a href>` nu, sans `onClick`. Un
 * clic déléguait donc au comportement par défaut de la webview Tauri principale,
 * qui naviguait vers le site externe — l'application entière se retrouvait
 * « noyée » dans la page web, sans aucun moyen de revenir. C'est le « truc que
 * je n'arrive pas à fermer ».
 *
 * Décision (pure, testable) :
 *  - Liens `http`/`https` → ouverture dans le panneau de prévisualisation INTÉGRÉ
 *    (contrôlable, refermable par onglet).
 *  - Liens `mailto:`/`tel:` → navigateur système (comportement attendu).
 *  - Tout autre schéma (`javascript:`, `data:`, `file:`, `vbscript:`…) ou URL
 *    illisible → refusé (aucune action). C'est une barrière de sécurité : un lien
 *    injecté dans un message ne doit jamais exécuter de code ni ouvrir un schéma
 *    dangereux.
 *  - Ancre interne (`#…`) → laissée au comportement natif du navigateur.
 */

export type LinkRouting =
  | { action: "preview"; url: string }
  | { action: "external"; url: string }
  | { action: "none" };

/** Normalise et valide une URL de lien markdown. Renvoie null si non http(s). */
function asHttpUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol === "http:" || u.protocol === "https:") return u.toString();
    return null;
  } catch {
    return null;
  }
}

/**
 * Décide du routage d'un `href`. Ne déclenche AUCUNE action (pas d'effet de
 * bord) : l'appelant applique le résultat. C'est ce qui la rend testable.
 */
export function routeMarkdownLink(href: string | undefined): LinkRouting {
  if (!href) return { action: "none" };
  const raw = href.trim();
  if (raw === "") return { action: "none" };

  // Ancre interne (#section) : on laisse le navigateur gérer sur place.
  if (raw.startsWith("#")) return { action: "none" };

  const http = asHttpUrl(raw);
  if (http) return { action: "preview", url: http };

  // Protocoles pris en charge par le système.
  if (/^mailto:/i.test(raw) || /^tel:/i.test(raw)) {
    return { action: "external", url: raw };
  }

  // Tout le reste (javascript:, data:, file:, vbscript:, schémas inconnus) est
  // refusé : on ne fait rien plutôt que d'ouvrir une surface non maîtrisée.
  return { action: "none" };
}
