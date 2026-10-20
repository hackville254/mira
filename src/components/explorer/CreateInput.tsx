import { useEffect, useRef, useState } from "react";
import { FilePlus, FolderPlus } from "lucide-react";

/** Ligne de saisie inline pour créer un fichier ou un dossier dans l'arbre. */
export default function CreateInput({
  kind, depth, initialName, onCommit, onCancel, onEnsureVisible,
}: {
  kind: "file" | "folder";
  depth: number;
  initialName?: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
  onEnsureVisible?: () => void;
}) {
  const [name, setName] = useState(initialName ?? "");
  const ref = useRef<HTMLInputElement>(null);
  const committed = useRef(false);

  useEffect(() => {
    onEnsureVisible?.();
    ref.current?.focus();
  }, [onEnsureVisible]);

  function commit() {
    if (committed.current) return;
    const trimmed = name.trim();
    if (!trimmed) { committed.current = true; onCancel(); return; }
    committed.current = true;
    onCommit(trimmed);
  }

  const indent = depth * 12 + 6;
  return (
    <div style={{ height: 22, display: "flex", alignItems: "center", gap: 4, padding: `0 8px 0 ${indent}px` }}>
      {kind === "folder"
        ? <FolderPlus size={14} style={{ flexShrink: 0, color: "#eab308" }} />
        : <FilePlus size={14} style={{ flexShrink: 0, color: "var(--origin-fg-muted)" }} />}
      <input
        ref={ref}
        value={name}
        onChange={e => setName(e.target.value)}
        placeholder={kind === "folder" ? "folder name" : "file name"}
        onKeyDown={e => {
          e.stopPropagation();
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") { committed.current = true; onCancel(); }
        }}
        onBlur={commit}
        style={{
          flex: 1, fontSize: 12, padding: "1px 4px", minWidth: 0,
          backgroundColor: "var(--origin-bg-active)", color: "var(--origin-fg-default)",
          border: "1px solid var(--origin-accent-blue)", borderRadius: 3,
          outline: "none", fontFamily: "var(--font-sans)",
        }}
      />
    </div>
  );
}
