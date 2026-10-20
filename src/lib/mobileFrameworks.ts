/**
 * Détection des frameworks d'applications **mobiles natives** (et cross-platform).
 *
 * Objectif : reconnaître, à partir des **fichiers marqueurs** présents à la
 * racine d'un projet, la ou les stacks mobiles utilisées (Flutter, React Native,
 * Expo, Capacitor, Ionic, Android natif, iOS natif). Cette information sert à :
 *  - afficher un badge de stack dans la StatusBar ;
 *  - préparer le câblage de serveurs LSP dédiés (ex. dart analysis server).
 *
 * Sécurité : cette détection est **purement déclarative et passive**.
 *  - Elle ne lit que des **noms de fichiers** de premier niveau (jamais de
 *    récursion profonde) et, pour lever une ambiguïté, le **contenu** d'un
 *    petit nombre de fichiers marqueurs connus.
 *  - Le contenu lu sert uniquement à un test de sous-chaîne ou à un parsing
 *    JSON borné ; il n'est jamais interprété comme du code ni exécuté.
 *  - Aucune entrée utilisateur n'est concaténée dans un chemin en dehors du
 *    dossier racine fourni par l'application.
 */

import { useEffect, useState } from 'react';
import { readDir, readFile } from './fs';

/** Framework mobile reconnu. */
export interface MobileFramework {
  /** Identifiant stable (ex. "flutter"). */
  id: string;
  /** Libellé affiché (ex. "Flutter"). */
  label: string;
  /** Langage principal du framework (id du registre `languages.ts`). */
  language: string;
  /** Clé d'icône Material (bundle `themes/materialIcons.ts`). */
  icon: string;
  /** Fichiers marqueurs ayant déclenché la détection (informatif). */
  markers: string[];
}

/**
 * Sous-chaîne cherchée dans un `package.json` pour distinguer les stacks JS.
 * On borne la recherche à ces marqueurs **littéraux** : pas de regex dynamique,
 * pas d'évaluation.
 */
interface JsStackRule {
  /** Dépendance (clé attendue dans `dependencies`/`devDependencies`). */
  dep: string;
  framework: Omit<MobileFramework, 'markers'>;
}

/**
 * Règles appliquées au `package.json` : la présence de la dépendance suffit.
 * Ordre = priorité (le premier match « gagne » pour un fichier donné, mais on
 * collecte toutes les stacks distinctes détectées).
 */
const JS_STACK_RULES: JsStackRule[] = [
  {
    dep: 'react-native',
    framework: { id: 'react-native', label: 'React Native', language: 'typescriptreact', icon: 'react' },
  },
  {
    dep: 'expo',
    framework: { id: 'expo', label: 'Expo', language: 'typescriptreact', icon: 'react' },
  },
  {
    dep: '@capacitor/core',
    framework: { id: 'capacitor', label: 'Capacitor', language: 'typescript', icon: 'capacitor' },
  },
  {
    dep: '@ionic/react',
    framework: { id: 'ionic', label: 'Ionic', language: 'typescriptreact', icon: 'ionic' },
  },
  {
    dep: '@ionic/angular',
    framework: { id: 'ionic', label: 'Ionic', language: 'typescript', icon: 'ionic' },
  },
];

/** Règle basée sur la seule présence d'un fichier marqueur à la racine. */
interface FileRule {
  /** Nom de fichier marqueur (comparaison insensible à la casse). */
  file: string;
  framework: Omit<MobileFramework, 'markers'>;
}

const FILE_RULES: FileRule[] = [
  // Flutter : `pubspec.yaml` à la racine.
  { file: 'pubspec.yaml', framework: { id: 'flutter', label: 'Flutter', language: 'dart', icon: 'flutter' } },
  // Android natif : `settings.gradle`/`build.gradle` + manifeste.
  { file: 'androidmanifest.xml', framework: { id: 'android', label: 'Android', language: 'kotlin', icon: 'android' } },
  { file: 'settings.gradle', framework: { id: 'android', label: 'Android', language: 'kotlin', icon: 'android' } },
  { file: 'settings.gradle.kts', framework: { id: 'android', label: 'Android', language: 'kotlin', icon: 'android' } },
  // iOS natif : projet Xcode / Podfile.
  { file: 'podfile', framework: { id: 'ios', label: 'iOS', language: 'swift', icon: 'apple' } },
];

/**
 * Parse **borné** d'un `package.json` : on ne garde que les noms de dépendances
 * des sections `dependencies` / `devDependencies`. Toute anomalie (JSON
 * invalide, structure inattendue, fichier trop gros) est ignorée silencieusement
 * — la détection est un bonus, jamais un point de défaillance.
 */
function extractDependencies(raw: string): Set<string> {
  const deps = new Set<string>();
  // Garde-fou de taille : un package.json de plusieurs Mo est anormal.
  if (raw.length > 2_000_000) return deps;
  let pkg: unknown;
  try {
    pkg = JSON.parse(raw);
  } catch {
    return deps;
  }
  if (typeof pkg !== 'object' || pkg === null) return deps;
  for (const section of ['dependencies', 'devDependencies'] as const) {
    const block = (pkg as Record<string, unknown>)[section];
    if (typeof block !== 'object' || block === null) continue;
    for (const name of Object.keys(block)) deps.add(name);
  }
  return deps;
}

/**
 * Détecte les frameworks mobiles à partir de la liste des noms de fichiers de
 * premier niveau et, optionnellement, du contenu de `package.json`.
 *
 * @param rootNames Noms des entrées présentes à la racine du projet.
 * @param packageJsonRaw Contenu brut de `package.json` (ou `null`).
 * @returns Frameworks détectés, dédupliqués par `id`, ordre stable.
 */
export function detectMobileFrameworksFromNames(
  rootNames: string[],
  packageJsonRaw: string | null,
): MobileFramework[] {
  const lower = new Set(rootNames.map(n => n.toLowerCase()));
  const found = new Map<string, MobileFramework>();

  const add = (base: Omit<MobileFramework, 'markers'>, marker: string) => {
    const existing = found.get(base.id);
    if (existing) {
      if (!existing.markers.includes(marker)) existing.markers.push(marker);
      return;
    }
    found.set(base.id, { ...base, markers: [marker] });
  };

  for (const rule of FILE_RULES) {
    if (lower.has(rule.file.toLowerCase())) add(rule.framework, rule.file);
  }

  if (packageJsonRaw !== null) {
    const deps = extractDependencies(packageJsonRaw);
    for (const rule of JS_STACK_RULES) {
      if (deps.has(rule.dep)) add(rule.framework, `package.json:${rule.dep}`);
    }
  }

  return [...found.values()];
}

/** Indique si un ou plusieurs frameworks mobiles ont été détectés. */
export function isMobileProject(frameworks: MobileFramework[]): boolean {
  return frameworks.length > 0;
}

/**
 * Clés d'icônes Material utilisées par la détection mobile. Exposées pour que
 * le catalogue d'icônes reste aligné (test de cohérence).
 */
export const MOBILE_ICON_KEYS = [
  ...new Set(
    [...FILE_RULES, ...JS_STACK_RULES].map(r => r.framework.icon),
  ),
];

/**
 * Détecte les frameworks mobiles d'un projet en lisant sa racine.
 *
 * Lecture **superficielle** : uniquement les entrées de premier niveau. Le
 * `package.json` est lu seulement s'il est présent. Toute erreur d'E/S est
 * absorbée (résultat vide) : la détection ne doit jamais faire échouer l'IDE.
 *
 * @param folderPath Chemin absolu du dossier racine du projet.
 */
export async function detectMobileFrameworks(
  folderPath: string | null | undefined,
): Promise<MobileFramework[]> {
  if (!folderPath) return [];
  let entries: { name: string; is_dir: boolean }[];
  try {
    entries = await readDir(folderPath);
  } catch {
    return [];
  }
  const names = entries.map(e => e.name);
  const hasPackageJson = names.some(n => n.toLowerCase() === 'package.json');
  let pkgRaw: string | null = null;
  if (hasPackageJson) {
    // `readDir` renvoie le chemin absolu ; on le reconstruit ici de façon sûre
    // en réutilisant le chemin fourni par l'entrée si disponible.
    const pkgEntry = entries.find(n => n.name.toLowerCase() === 'package.json');
    const pkgPath = (pkgEntry as { path?: string } | undefined)?.path;
    if (pkgPath) {
      try {
        pkgRaw = await readFile(pkgPath);
      } catch {
        pkgRaw = null;
      }
    }
  }
  return detectMobileFrameworksFromNames(names, pkgRaw);
}

/**
 * Hook React : détecte les frameworks mobiles du dossier de travail courant.
 * Lancé une fois par changement de `folderPath`, résultat mémoïsé côté appelant
 * via l'état. Ne relance jamais en boucle (dépendance unique : `folderPath`).
 *
 * @param folderPath Dossier racine du workspace (ou `null`).
 */
export function useMobileProject(folderPath: string | null | undefined): MobileFramework[] {
  const [frameworks, setFrameworks] = useState<MobileFramework[]>([]);
  useEffect(() => {
    let cancelled = false;
    if (!folderPath) return;
    detectMobileFrameworks(folderPath)
      .then(result => { if (!cancelled) setFrameworks(result); })
      .catch(() => { if (!cancelled) setFrameworks([]); });
    return () => { cancelled = true; };
  }, [folderPath]);
  // Dérivation au rendu : aucun dossier ouvert ⇒ aucun projet mobile. Évite
  // toute mise à jour d'état synchrone dans l'effet (rendu en cascade).
  return folderPath ? frameworks : [];
}
