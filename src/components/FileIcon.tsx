import { File, Folder, FolderOpen } from "lucide-react";
import { useTheme } from "../themes/ThemeContext";
import { fileColor } from "../lib/fileColors";

interface FileIconProps {
  name: string;
  isDir?: boolean;
  expanded?: boolean;
  size?: number;
  /** CSS color used for the generic fallback glyph. Defaults to extension color. */
  color?: string;
}

/**
 * Renders a file/folder icon honouring the active VS Code file-icon theme.
 *
 * When an icon theme provides a match, its SVG is rendered through an `<img>`
 * data-URI (untrusted SVG must never be inlined as live markup). Otherwise we
 * fall back to the generic lucide glyph, keeping the per-extension tint.
 */
export default function FileIcon({ name, isDir = false, expanded = false, size = 14, color }: FileIconProps) {
  const { iconResolver } = useTheme();
  const uri = iconResolver?.resolve(name, isDir, expanded) ?? null;

  if (uri) {
    return <img src={uri} alt="" width={size} height={size} style={{ flexShrink: 0, display: "block" }} draggable={false} />;
  }

  if (isDir) {
    return expanded
      ? <FolderOpen size={size} style={{ flexShrink: 0, color: color ?? "#eab308" }} />
      : <Folder size={size} style={{ flexShrink: 0, color: color ?? "#eab308" }} />;
  }
  return <File size={size} style={{ flexShrink: 0, color: color ?? fileColor(name) }} />;
}
