// ── Icône d'un rôle de sous-agent (résolution UI) ──────────────────────────────
//
// Le catalogue de rôles (`subagentRoles.ts`) est de la DONNÉE : chaque rôle porte
// un NOM d'icône lucide (`role.icon`) et un libellé (`role.label`). Les composants
// d'UI (carte de sous-agent, onglet Agents) affichent le libellé tel quel — il
// arrive pré-résolu par l'hôte — et résolvent l'icône via cette table locale.
//
// Pas d'`import *` de lucide-react (cela casserait le tree-shaking). Un rôle
// inconnu retombe proprement sur l'icône générique `Bot`.
//
// On expose un RENDU (`renderRoleIcon`) plutôt qu'un composant : résoudre un
// composant pendant le render (variable capitalisée) est un anti-pattern React
// et déclenche `react-hooks/static-components`.

import {
  Bot, Search, GitBranch, ShieldCheck, FlaskConical, BookOpen, type LucideIcon,
} from "lucide-react";
import type { CSSProperties } from "react";
import { listRoles } from "../../lib/agent/subagentRoles";

const ROLE_ICONS: Record<string, LucideIcon> = {
  Search, GitBranch, ShieldCheck, FlaskConical, BookOpen,
};

/** Cellule JSX de l'icône du rôle (par son LIBELLÉ affiché), sinon `Bot`. */
export function renderRoleIcon(label: string, props: { size?: number; style?: CSSProperties }) {
  const role = listRoles().find(r => r.label === label);
  const Icon = (role && ROLE_ICONS[role.icon]) || Bot;
  return <Icon {...props} />;
}
