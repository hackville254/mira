/**
 * Origin — Outils CUSTOM `browser_*` (sidecar Cline) : navigateur piloté.
 *
 * RÔLE
 * ----
 * Parité Trae SOLO : l'agent doit pouvoir **piloter le navigateur embarqué**
 * (`WebPreviewPane`) — naviguer, lire le DOM/texte visible, inventorier les
 * éléments interactifs, cliquer, saisir, presser une touche, capturer l'écran.
 * Le SDK Cline n'expose rien de tel : on INJECTE donc ces outils dans la
 * session via `extraTools` (même mécanisme que `todoTool`).
 *
 * POURQUOI ICI (Node) ET PAS CÔTÉ FRONT
 * -------------------------------------
 * Les outils doivent vivre dans le MÊME process que le moteur, sinon le modèle
 * n'aurait jamais leur définition. Leur EXÉCUTION réelle, elle, appartient à
 * Rust (`src-tauri/src/browser.rs`) : le sidecar n'a AUCUN accès direct à la
 * webview. Chaque outil émettra donc un `tool_event` de type `browser_invoke`
 * que le front relaie à la commande Tauri correspondante et dont il renvoie le
 * résultat — exactement le schéma « effet d'outil » déjà utilisé pour la todo.
 *
 * SÉCURITÉ
 * --------
 *   - **Aucun code arbitraire** : chaque outil est un wrapper typé (zod) autour
 *     d'une commande Rust connue. Les entrées sont validées AVANT d'être
 *     transmises (bornes de taille incluses).
 *   - **Allowlist de commandes** : `BROWSER_COMMANDS` est une table fermée ; le
 *     sidecar ne peut demander QUE ces opérations, jamais une commande Tauri
 *     arbitraire.
 *   - **Le schéma d'URL est vérifié côté Rust** (défense en profondeur), pas ici
 *     seulement : le sidecar peut être contourné, Rust non.
 *   - **Navigation externe = confirmation** : la politique vit côté FRONT
 *     (une seule source de vérité, `permissions.ts`), le sidecar ne fait que
 *     transporter le verdict via `allow_external`.
 */

import { createTool } from "@cline/core";
import { z } from "zod";

/** Borne du texte lisible renvoyé au modèle (borne la fenêtre de contexte). */
const MAX_READ_CHARS = 40_000;
/** Borne du nombre de caractères saisis dans un champ. */
const MAX_TYPE_CHARS = 4_000;

/**
 * Table FERMÉE des opérations navigateur que le sidecar peut demander. Le front
 * la relaie vers la commande Tauri homonyme (`browser.rs`). Toute opération hors
 * de cette table est rejetée : un modèle ne peut pas provoquer d'invoke arbitraire.
 */
export const BROWSER_COMMANDS = [
  "browser_navigate",
  "browser_reload",
  "browser_status",
  "browser_read_text",
  "browser_read_dom",
  "browser_query",
  "browser_click",
  "browser_type",
  "browser_press_key",
  "browser_screenshot",
] as const;

export type BrowserCommand = (typeof BROWSER_COMMANDS)[number];

/**
 * Charge utile d'un effet d'outil navigateur, relayée au front.
 *
 * Le front (`clineClient` → commande Tauri `args`) la traduit en invoke puis
 * renvoie le résultat par le même canal que les autres `tool_event` bloquants.
 */
export interface BrowserInvokeRequest {
  /** Nom de la commande Tauri (contrainte à `BROWSER_COMMANDS`). */
  command: BrowserCommand;
  /** Arguments de la commande (données uniquement, jamais de code). */
  args: Record<string, unknown>;
}

/**
 * Callback d'exécution : émet la demande vers le front et attend le résultat
 * (chaîne) de la commande Tauri. C'est le pont Node→front→Rust.
 */
export type BrowserInvoke = (request: BrowserInvokeRequest) => Promise<string>;

/** Réduit une chaîne au plafond, en signalant la troncature. */
function clamp(text: string, max = MAX_READ_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]`;
}

/**
 * Construit les outils navigateur d'une session.
 *
 * @param invoke pont vers le front (émet la demande et attend le résultat Rust).
 */
export function buildBrowserTools(invoke: BrowserInvoke) {
  /**
   * `browser_navigate` : navigue la prévisualisation vers une URL.
   *
   * `allow_external` est le VERDICT D'APPROBATION calculé par le front
   * (loopback = direct, hôte externe = confirmation utilisateur). L'outil ne
   * décide jamais lui-même — il relaie le choix de l'utilisateur au moteur.
   */
  const navigate = createTool({
    name: "browser_navigate",
    description:
      "Navigate the embedded browser preview to an absolute http(s) URL. Use it to open a " +
      "page the user asked you to inspect, or the app under development (e.g. http://localhost:5173). " +
      "External hosts may require user confirmation.",
    inputSchema: z.object({
      url: z.string().url().describe("Absolute http(s) URL to open."),
    }),
    lifecycle: { completesRun: false },
    async execute(input: { url: string }) {
      const output = await invoke({ command: "browser_navigate", args: { url: input.url } });
      return { output: clamp(output), isError: false };
    },
  });

  /** `browser_reload` : recharge la page courante (après un build, par ex.). */
  const reload = createTool({
    name: "browser_reload",
    description: "Reload the current page in the embedded browser preview.",
    inputSchema: z.object({}),
    lifecycle: { completesRun: false },
    async execute() {
      const output = await invoke({ command: "browser_reload", args: {} });
      return { output: clamp(output), isError: false };
    },
  });

  /** `browser_status` : URL, titre, état de chargement et viewport. */
  const status = createTool({
    name: "browser_status",
    description:
      "Return the embedded browser preview status: current URL, page title, document " +
      "readyState and viewport size. Use it to check that a page finished loading.",
    inputSchema: z.object({}),
    lifecycle: { completesRun: false },
    async execute() {
      const output = await invoke({ command: "browser_status", args: {} });
      return { output: clamp(output), isError: false };
    },
  });

  /**
   * `browser_read_text` : texte VISIBLE de la page (ou d'un sélecteur).
   * C'est la lecture de référence : bien plus économe qu'un DOM brut.
   */
  const readText = createTool({
    name: "browser_read_text",
    description:
      "Read the visible text of the current page, or of a single element when `selector` is " +
      "given. Prefer this over `browser_read_dom` to understand page content.",
    inputSchema: z.object({
      selector: z
        .string()
        .max(500)
        .optional()
        .describe("CSS selector, or `text=Some label` to target by visible text. Omit for the whole page."),
    }),
    lifecycle: { completesRun: false },
    async execute(input: { selector?: string }) {
      const output = await invoke({
        command: "browser_read_text",
        args: input.selector ? { selector: input.selector } : {},
      });
      return { output: clamp(output), isError: false };
    },
  });

  /** `browser_read_dom` : HTML d'un élément (ou de `body`), plafonné. */
  const readDom = createTool({
    name: "browser_read_dom",
    description:
      "Read the HTML of an element (or of `body` when no selector is given). Use it to inspect " +
      "markup and attributes; prefer `browser_read_text` when you only need the content.",
    inputSchema: z.object({
      selector: z.string().max(500).optional().describe("CSS selector, or `text=Some label`. Omit for `<body>`."),
    }),
    lifecycle: { completesRun: false },
    async execute(input: { selector?: string }) {
      const output = await invoke({
        command: "browser_read_dom",
        args: input.selector ? { selector: input.selector } : {},
      });
      return { output: clamp(output), isError: false };
    },
  });

  /**
   * `browser_query` : inventaire STRUCTURÉ des éléments interactifs visibles.
   * Chaque entrée porte un `ref` stable (`e0`, `e1`…) réutilisable dans
   * `browser_click`/`browser_type` — bien plus fiable qu'un sélecteur deviné.
   */
  const query = createTool({
    name: "browser_query",
    description:
      "List the visible interactive elements of the page (links, buttons, inputs, selects, " +
      "textareas) with a stable `ref` for each. Call this BEFORE clicking or typing so you can " +
      "target elements by `ref` or by their visible text instead of guessing CSS.",
    inputSchema: z.object({}),
    lifecycle: { completesRun: false },
    async execute() {
      const output = await invoke({ command: "browser_query", args: {} });
      return { output: clamp(output), isError: false };
    },
  });

  /**
   * `browser_click` : clique un élément par `ref` (recommandé) ou `selector`.
   *
   * `allow_external` couvre le cas d'un lien sortant : le front demande la
   * confirmation AVANT d'autoriser la navigation hors hôte local.
   */
  const click = createTool({
    name: "browser_click",
    description:
      "Click an element in the embedded browser, identified by `ref` (from `browser_query`) or " +
      "by `selector` (CSS or `text=Some label`). Prefer `ref`.",
    inputSchema: z
      .object({
        ref: z.string().max(32).optional().describe("Element ref from `browser_query` (e.g. `e3`). Prefer this."),
        selector: z.string().max(500).optional().describe("CSS selector, or `text=Some label`."),
      })
      .refine((v) => Boolean(v.ref) || Boolean(v.selector), {
        message: "Provide either `ref` or `selector`.",
      }),
    lifecycle: { completesRun: false },
    async execute(input: { ref?: string; selector?: string }) {
      const args: Record<string, unknown> = {};
      if (input.ref) args.ref_id = input.ref;
      if (input.selector) args.selector = input.selector;
      const output = await invoke({ command: "browser_click", args });
      return { output: clamp(output), isError: false };
    },
  });

  /**
   * `browser_type` : saisit du texte dans un champ (par `ref` ou `selector`).
   * La valeur est écrite via le setter natif côté Rust pour que React/Vue la
   * voient — l'agent n'a pas à s'en soucier.
   */
  const type = createTool({
    name: "browser_type",
    description:
      "Type `text` into an input, textarea or contenteditable element, identified by `ref` " +
      "(from `browser_query`) or by `selector`. Prefer `ref`. The field is focused first and " +
      "input/change events are dispatched so frameworks such as React/Vue update.",
    inputSchema: z
      .object({
        text: z.string().max(MAX_TYPE_CHARS),
        ref: z.string().max(32).optional().describe("Element ref from `browser_query`. Prefer this."),
        selector: z.string().max(500).optional().describe("CSS selector, or `text=Some label`."),
      })
      .refine((v) => Boolean(v.ref) || Boolean(v.selector), {
        message: "Provide either `ref` or `selector`.",
      }),
    lifecycle: { completesRun: false },
    async execute(input: { text: string; ref?: string; selector?: string }) {
      const args: Record<string, unknown> = { text: input.text };
      if (input.ref) args.ref_id = input.ref;
      if (input.selector) args.selector = input.selector;
      const output = await invoke({ command: "browser_type", args });
      return { output: clamp(output), isError: false };
    },
  });

  /** `browser_press_key` : presse une touche clavier (Entrée, Tab, Escape…). */
  const pressKey = createTool({
    name: "browser_press_key",
    description:
      "Press a single keyboard key in the embedded browser (e.g. `Enter`, `Tab`, `Escape`). " +
      "Useful to submit a focused form without locating its button.",
    inputSchema: z.object({
      key: z.string().min(1).max(32).describe("Key name as in a DOM KeyboardEvent, e.g. `Enter`."),
    }),
    lifecycle: { completesRun: false },
    async execute(input: { key: string }) {
      const output = await invoke({ command: "browser_press_key", args: { key: input.key } });
      return { output: clamp(output), isError: false };
    },
  });

  /**
   * `browser_screenshot` : capture la prévisualisation (data-URL PNG).
   *
   * La capture est déléguée au front (voir `browser.rs`) : le sidecar ne touche
   * pas à l'API native, il reçoit simplement le data-URL produit par l'UI.
   */
  const screenshot = createTool({
    name: "browser_screenshot",
    description:
      "Capture the embedded browser preview as a PNG data URL. Use it to inspect visual layout, " +
      "styling or rendering that text alone cannot convey.",
    inputSchema: z.object({}),
    lifecycle: { completesRun: false },
    async execute() {
      const output = await invoke({ command: "browser_screenshot", args: {} });
      return { output: clamp(output), isError: false };
    },
  });

  return {
    tools: [
      navigate,
      reload,
      status,
      readText,
      readDom,
      query,
      click,
      type,
      pressKey,
      screenshot,
    ],
  };
}
