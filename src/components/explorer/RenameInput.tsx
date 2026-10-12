import { useEffect, useRef, useState } from "react";

/** Champ de renommage inline d'une ligne de l'explorateur. */
export default function RenameInput({
  initial, onCommit, onCancel,
}: {
  initial: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const committed = useRef(false);

  useEffect(() => {
    // Sélectionne le nom sans l'extension (comportement VS Code).
    const input = ref.current;
    if (!input) return;
    input.focus();
    const dot = initial.lastIndexOf(".");
    if (dot > 0) input.setSelectionRange(0, dot);
    else input.select();
  }, [initial]);

  function commit() {
    if (committed.current) return;
    committed.current = true;
    onCommit(name);
  }

  return (
    <input
      ref={ref}
      value={name}
      onChange={e => setName(e.target.value)}
      onKeyDown={e => {
        e.stopPropagation();
        if (e.key === "Enter") commit();
        else if (e.key === "Escape") { committed.current = true; onCancel(); }
      }}
      onBlur={commit}
      onClick={e => e.stopPropagation()}
      style={inputStyle}
    />
  );
}

const inputStyle: React.CSSProperties = {
  flex: 1, fontSize: 12, padding: "1px 4px", minWidth: 0,
  backgroundColor: "var(--origin-bg-active)", color: "var(--origin-fg-default)",
  border: "1px solid var(--origin-accent-blue)", borderRadius: 3,
  outline: "none", fontFamily: "var(--font-sans)",
};
