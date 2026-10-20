// Module de configuration — chargé depuis un fichier texte simple (clé=valeur).
// Bug de production : les valeurs numériques restent des chaînes, et les lignes
// vides / commentaires ne sont pas ignorés. Les tests décrivent l'attendu.

export function parseConfig(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const idx = line.indexOf("=");
    const key = line.slice(0, idx);
    const value = line.slice(idx + 1);
    out[key] = value;
  }
  return out;
}
