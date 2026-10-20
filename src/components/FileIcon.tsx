import { useTheme } from "../themes/ThemeContext";
import { resolveMaterialIcon } from "../themes/materialIcons";
import { getLanguageIcon } from "../lib/languages";

interface FileIconProps {
  name: string;
  isDir?: boolean;
  expanded?: boolean;
  size?: number;
}

/**
 * Rendu d'une icône de fichier/dossier dans l'explorateur.
 *
 * Ordre de résolution :
 *  1. **Thème d'icônes d'extension** (VS Code `contributes.iconThemes`) s'il est
 *     sélectionné dans l'apparence — il gagne, comme dans VS Code.
 *  2. **Bundle Material natif** (`themes/materialIcons.ts`), résolu à partir du
 *     **registre de langages** (`lib/languages.ts`) puis du nom/extension. C'est
 *     le comportement par défaut, disponible sans aucune extension installée.
 *
 * Sécurité : dans les deux cas l'icône est une data-URI SVG rendue via `<img>`
 * (média passif, jamais de markup vivant injecté dans le DOM).
 */
export default function FileIcon({ name, isDir = false, expanded = false, size = 14 }: FileIconProps) {
  const { iconResolver } = useTheme();

  // 1. Thème d'icônes d'extension (prioritaire).
  const themeUri = iconResolver?.resolve(name, isDir, expanded) ?? null;
  const uri = themeUri ?? resolveMaterialIcon(name, isDir, expanded, isDir ? null : getLanguageIcon(name));

  return (
    <img
      src={uri}
      alt=""
      width={size}
      height={size}
      style={{ flexShrink: 0, display: "block" }}
      draggable={false}
    />
  );
}
