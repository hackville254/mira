/**
 * Guard de prérequis d'extension (`extensionDependencies`).
 *
 * VS Code refuse d'activer une extension dont une dépendance déclarée n'est pas
 * installée. On reproduit ce contrat *avant* toute exécution de code : on
 * calcule la liste des ids requis absents du catalogue installé.
 *
 * Politique produit : jamais d'« error » brut. L'UI grise le bouton d'activation
 * et affiche une phrase courte (« Requiert : acme.core »). Le guard est la seule
 * autorité de décision — il est pur et testable (aucun accès disque/réseau).
 */

import type { ExtensionInfo } from '../extensions';

export interface PrerequisiteStatus {
  /** Peut être activée : aucune dépendance manquante. */
  satisfied: boolean;
  /** Ids requis mais non installés. Vide si `satisfied`. */
  missing: string[];
}

/**
 * Compare les `extensionDependencies` d'une extension à l'ensemble des ids
 * installés. Les ids sont comparés de façon insensible à la casse : VS Code
 * normalise `publisher.name` en minuscules.
 */
export function checkPrerequisites(
  ext: Pick<ExtensionInfo, 'extension_dependencies'>,
  installedIds: Iterable<string>,
): PrerequisiteStatus {
  const required = ext.extension_dependencies ?? [];
  if (required.length === 0) {
    return { satisfied: true, missing: [] };
  }

  const installed = new Set<string>();
  for (const id of installedIds) installed.add(id.toLowerCase());

  const missing = required.filter((id) => !installed.has(id.toLowerCase()));
  return { satisfied: missing.length === 0, missing };
}

/** Phrase courte pour l'UI : « Requiert : a, b ». Vide si aucun prérequis. */
export function describeMissing(missing: string[]): string {
  if (missing.length === 0) return '';
  return `Requiert : ${missing.join(', ')}`;
}
