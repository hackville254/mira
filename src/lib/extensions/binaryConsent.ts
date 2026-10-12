/**
 * Consentement pour les **binaires tiers** embarqués par une extension.
 *
 * Règle produit : « tout binaire tiers demande confirmation au premier usage ».
 * Une extension peut embarquer des exécutables (déclarés `origin.binaries` dans
 * son manifest). On NE les lance JAMAIS silencieusement : l'utilisateur voit la
 * liste et approuve explicitement, binaire par binaire.
 *
 * Ce module est volontairement pur (hors `localStorage`) pour rester testable :
 * la normalisation des chemins et le calcul de l'état de consentement ne
 * dépendent d'aucun effet de bord.
 */

/** Clé stable d'un binaire : chemin normalisé (séparateurs `/`, sans `./`). */
export function normalizeBinaryPath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "")
    .replace(/\/{2,}/g, "/")
    .trim();
}

/** Normalise et dédoublonne une liste de chemins de binaires. */
export function normalizeBinaryList(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of paths) {
    const norm = normalizeBinaryPath(raw);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out;
}

/**
 * Binaires déclarés par l'extension qui n'ont PAS encore été consentis. Une
 * liste vide signifie « tout est approuvé » (ou « aucun binaire à approuver »).
 */
export function missingBinaryConsent(
  declared: readonly string[],
  granted: readonly string[],
): string[] {
  const have = new Set(granted.map(normalizeBinaryPath));
  return normalizeBinaryList(declared).filter((b) => !have.has(b));
}

/** Message court et actionnable listant les binaires à approuver. */
export function describeBinaries(missing: readonly string[]): string {
  const list = normalizeBinaryList(missing);
  if (list.length === 0) return "";
  return `Binaires tiers à approuver : ${list.join(", ")}`;
}

// ── Persistance du consentement ───────────────────────────────────────────────

const STORAGE_KEY = "origin-extension-binary-consents";

/** extensionId → chemins de binaires approuvés. */
type BinaryConsentMap = Record<string, string[]>;

function readMap(): BinaryConsentMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as BinaryConsentMap) : {};
  } catch {
    return {};
  }
}

function writeMap(map: BinaryConsentMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Stockage indisponible (mode privé) : le consentement ne persiste pas.
  }
}

/** Binaires déjà approuvés pour une extension. */
export function grantedBinaries(extensionId: string): string[] {
  return readMap()[extensionId] ?? [];
}

/** Enregistre les binaires approuvés pour une extension. */
export function setGrantedBinaries(extensionId: string, binaries: readonly string[]): void {
  const map = readMap();
  map[extensionId] = normalizeBinaryList(binaries);
  writeMap(map);
}

/**
 * Ajoute des binaires à l'ensemble déjà approuvé (on ne révoque jamais
 * implicitement : un ajout ultérieur s'accumule).
 */
export function addGrantedBinaries(extensionId: string, binaries: readonly string[]): void {
  const merged = normalizeBinaryList([...grantedBinaries(extensionId), ...binaries]);
  setGrantedBinaries(extensionId, merged);
}

/** Supprime tout consentement binaire d'une extension (désinstallation). */
export function clearBinaryConsent(extensionId: string): void {
  const map = readMap();
  delete map[extensionId];
  writeMap(map);
}

/** État de consentement des binaires pour une extension installée. */
export function binaryConsentStatus(
  extensionId: string,
  declared: readonly string[],
): { granted: boolean; missing: string[] } {
  const missing = missingBinaryConsent(declared, grantedBinaries(extensionId));
  return { granted: missing.length === 0, missing };
}
