// ── Registry de commandes runtime (cœur de l'IDE) ────────────────────────────
//
// Contrairement à `src/lib/keybindings.ts` (registry *statique* utilisée pour
// l'affichage et le rebinding des raccourcis), ce module est une registry
// *runtime* : App y enregistre les handlers réels de chaque commande, et la
// Command Palette + le listener global les lisent via `subscribe` /
// `useSyncExternalStore`.
//
// Le but est d'avoir une source de vérité unique pour « quelles commandes
// existent et comment les exécuter », afin que la palette liste **toutes** les
// commandes VS Code-like sans liste codée en dur.

export interface RuntimeCommand {
  /** Identifiant stable, ex. "origin.save" ou "editor.formatDocument". */
  id: string;
  /** Libellé affiché dans la palette. */
  title: string;
  /** Groupe logique (File, Edit, View, Selection, Go, …). */
  category: string;
  /** Mots-clés supplémentaires pour la recherche fuzzy. */
  keywords?: string;
  /** Handler exécuté à l'invocation. Peut être async. */
  run: () => void | Promise<void>;
  /** Reflète un état activable (ex. sidebar ouverte). */
  enabled?: boolean;
}

type Listener = () => void;

const commands = new Map<string, RuntimeCommand>();
const listeners = new Set<Listener>();
let snapshot: RuntimeCommand[] = [];

function rebuildSnapshot(): void {
  snapshot = Array.from(commands.values());
}

function emit(): void {
  rebuildSnapshot();
  for (const l of listeners) l();
}

/**
 * Enregistre (ou remplace) une commande. Retourne une fonction de désinscription
 * idempotente — indispensable pour les `useEffect` de App qui se reconstruisent.
 */
export function registerCommand(cmd: RuntimeCommand): () => void {
  commands.set(cmd.id, cmd);
  emit();
  return () => {
    // Ne supprime que si la commande n'a pas été remplacée entre-temps.
    if (commands.get(cmd.id) === cmd) {
      commands.delete(cmd.id);
      emit();
    }
  };
}

/** Enregistre plusieurs commandes d'un coup. Retourne un désinscripteur groupé. */
export function registerCommands(cmds: RuntimeCommand[]): () => void {
  const disposers = cmds.map(registerCommand);
  return () => { for (const d of disposers) d(); };
}

/** Liste immuable de toutes les commandes (snapshot stable pour React). */
export function getCommands(): RuntimeCommand[] {
  return snapshot;
}

/** Récupère une commande par id. */
export function getCommand(id: string): RuntimeCommand | undefined {
  return commands.get(id);
}

/** Abonnement aux changements (ajout/suppression de commandes). */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Exécute une commande par id. Silencieux si absente. */
export async function runCommand(id: string): Promise<void> {
  const cmd = commands.get(id);
  if (!cmd) return;
  await cmd.run();
}
