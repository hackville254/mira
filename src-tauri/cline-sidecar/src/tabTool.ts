/**
 * Origin — Outils CUSTOM de GESTION DES ONGLETS du navigateur intégré.
 *
 * RÔLE
 * ----
 * Parité Trae SOLO : l'agent ne doit pas seulement PILOTER la page courante
 * (`browser_*`, cf. `browserTool.ts`) — il doit aussi **gérer le navigateur
 * lui-même** : savoir combien d'onglets sont ouverts, en ouvrir, en fermer,
 * passer de l'un à l'autre, et cibler un onglet PRÉCIS pour ses lectures.
 *
 * Sans ces outils, l'agent est aveugle à la notion d'onglet : il ne peut viser
 * que « ce qui est affiché », et toute demande du type « ouvre cette page dans
 * un nouvel onglet » ou « qu'est-ce qui est ouvert ? » est hors de portée.
 *
 * POURQUOI DES OUTILS SÉPARÉS DE `browser_*`
 * ------------------------------------------
 * Un onglet n'est pas une page : ce sont deux cycles de vie distincts. La
 * gestion d'onglets appartient au FRONT (`previewTabs.ts`), pas à Rust : il n'y
 * a aucune webview à manipuler pour ouvrir/fermer un onglet, seulement un état
 * d'UI. On ne peut donc pas réutiliser le pont `browserInvoke` (qui injecte un
 * `panelId` de webview) : ces outils passent par `originInvoke` et demandent des
 * commandes Tauri résolues CÔTÉ FRONT, sans cible matérielle.
 *
 * SÉCURITÉ
 * --------
 *   - **Aucune cible devinable** : le modèle ne manipule jamais un `panelId` de
 *     webview (il pourrait le forger). Il travaille sur un `tabId` OPAQUE,
 *     renvoyé par `browser_list_tabs`, que le front seul sait traduire.
 *   - **Table FERMÉE de commandes** (`TAB_COMMANDS`) : le sidecar ne peut
 *     demander que ces opérations, jamais une commande Tauri arbitraire.
 *   - **URL vérifiée côté Rust** : l'ouverture d'un onglet suit le même chemin
 *     de navigation que `browser_navigate` (schéma http(s) imposé, confirmation
 *     utilisateur pour un hôte externe). Le sidecar ne fait que TRANSPORTER.
 *   - **Aucun code exécutable transporté** : uniquement des données typées.
 */

import { createTool } from "@cline/core";
import { z } from "zod";

/** Borne du nombre d'onglets visibles dans une réponse (borne le contexte). */
const MAX_TABS_REPORTED = 50;

/**
 * Table FERMÉE des opérations de gestion d'onglets. Le front la relaie vers sa
 * propre logique (`previewTabs.ts`) — jamais vers une commande Tauri arbitraire.
 */
export const TAB_COMMANDS = [
  "tabs_list",
  "tabs_open",
  "tabs_close",
  "tabs_activate",
] as const;

export type TabCommand = (typeof TAB_COMMANDS)[number];

/** Charge utile d'un effet d'outil de gestion d'onglets, relayée au front. */
export interface TabInvokeRequest {
  /** Nom de l'opération (contrainte à `TAB_COMMANDS`). */
  command: TabCommand;
  /** Arguments de l'opération (données uniquement, jamais de code). */
  args: Record<string, unknown>;
}

/** Pont d'exécution : émet la demande vers le front et attend le résultat. */
export type TabInvoke = (request: TabInvokeRequest) => Promise<string>;

/** Réduit une chaîne au plafond, en signalant la troncature. */
function clamp(text: string, max = 8_000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]`;
}

/**
 * Construit les outils de gestion d'onglets d'une session.
 *
 * @param invoke pont vers le front (émet la demande et attend le résultat).
 */
export function buildTabTools(invoke: TabInvoke) {
  /**
   * `browser_list_tabs` : inventaire des onglets ouverts.
   *
   * C'est l'outil d'ENTRÉE : il donne à l'agent les `tabId` opaques dont il a
   * besoin pour cibler un onglet précis dans les autres outils. On lui demande
   * donc de commencer par là plutôt que de deviner.
   */
  const listTabs = createTool({
    name: "browser_list_tabs",
    description:
      "List the currently open tabs of the embedded browser: for each tab, an opaque `tabId`, " +
      "its URL, a short title and whether it is the active (visible) one. Call this first " +
      "whenever you need to know what is open, or before targeting a specific tab by `tabId`.",
    inputSchema: z.object({
      max: z
        .number()
        .int()
        .min(1)
        .max(MAX_TABS_REPORTED)
        .optional()
        .describe(`Maximum number of tabs to report (default and cap: ${MAX_TABS_REPORTED}).`),
    }),
    lifecycle: { completesRun: false },
    async execute(input: { max?: number }) {
      const output = await invoke({
        command: "tabs_list",
        args: input.max ? { max: input.max } : {},
      });
      return { output: clamp(output), isError: false };
    },
  });

  /**
   * `browser_open_tab` : ouvre une URL dans un NOUVEL onglet.
   *
   * À utiliser quand plusieurs pages doivent être consultées en parallèle, ou
   * quand l'utilisateur demande explicitement un nouvel onglet. Ouvrir un onglet
   * rend celui-ci ACTIF : les outils `browser_*` s'appliquent alors à lui.
   */
  const openTab = createTool({
    name: "browser_open_tab",
    description:
      "Open an absolute http(s) URL in a NEW tab of the embedded browser, and make it the active " +
      "tab. Use it to keep several pages open side by side (the previous tab stays alive, " +
      "preserving its state). The active tab then becomes the target of the `browser_*` tools. " +
      "External hosts may require user confirmation.",
    inputSchema: z.object({
      url: z.string().url().describe("Absolute http(s) URL to open in a new tab."),
    }),
    lifecycle: { completesRun: false },
    async execute(input: { url: string }) {
      const output = await invoke({ command: "tabs_open", args: { url: input.url } });
      return { output: clamp(output), isError: false };
    },
  });

  /**
   * `browser_close_tab` : ferme un onglet par son `tabId`.
   *
   * L'agent doit fermer ce qu'il a ouvert quand il n'en a plus besoin : c'est de
   * la bonne citoyenneté (chaque onglet est une webview vivante en mémoire).
   */
  const closeTab = createTool({
    name: "browser_close_tab",
    description:
      "Close a browser tab by its `tabId` (from `browser_list_tabs`). Close the tabs you opened " +
      "once you are done with them: each tab is a live web view consuming resources.",
    inputSchema: z.object({
      tabId: z.string().min(1).max(64).describe("Tab identifier from `browser_list_tabs`."),
    }),
    lifecycle: { completesRun: false },
    async execute(input: { tabId: string }) {
      const output = await invoke({ command: "tabs_close", args: { tabId: input.tabId } });
      return { output: clamp(output), isError: false };
    },
  });

  /**
   * `browser_activate_tab` : rend un onglet ACTIF (visible) et en fait la cible
   * des outils `browser_*`.
   *
   * C'est l'outil de BASCULE : pour lire une autre page déjà ouverte, on active
   * son onglet puis on lit — sans jamais en ouvrir un nouveau ni perdre l'état
   * de la page quittée.
   */
  const activateTab = createTool({
    name: "browser_activate_tab",
    description:
      "Bring the tab identified by `tabId` to the foreground and make it the active tab (the " +
      "target of all `browser_*` tools). The page is NOT reloaded: its scroll and state are " +
      "preserved. Use it to switch between already-open pages instead of reopening them.",
    inputSchema: z.object({
      tabId: z.string().min(1).max(64).describe("Tab identifier from `browser_list_tabs`."),
    }),
    lifecycle: { completesRun: false },
    async execute(input: { tabId: string }) {
      const output = await invoke({ command: "tabs_activate", args: { tabId: input.tabId } });
      return { output: clamp(output), isError: false };
    },
  });

  return { tools: [listTabs, openTab, closeTab, activateTab] };
}
