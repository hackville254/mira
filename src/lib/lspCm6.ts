/* eslint-disable @typescript-eslint/no-explicit-any -- LSP JSON-RPC payloads are protocol-defined, untyped JSON */
import { linter, lintGutter } from '@codemirror/lint';
import { keymap } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { LanguageServerClient, languageServerWithTransport } from 'codemirror-languageserver';
import type { Transport } from 'codemirror-languageserver';
import { getLspLanguageId, pathToUri, type LspServerId } from './lsp';
import type { LspPosition, LspRange, LspTextEdit, LspWorkspaceEdit } from './lspEdits';
import { KNOWN_SERVERS } from './lspConfig';
import type { KnownServer } from './lspConfig';
import { parseLspBinaryError } from './lspProbe';

// ── Tauri IPC Transport ───────────────────────────────────────────────────────
// Routes codemirror-languageserver JSON-RPC messages through the existing
// lsp_request / lsp_notify Tauri commands + lsp-notification-{lang} events.

class TauriLspTransport implements Transport {
  private messageCallbacks: ((msg: string) => void)[] = [];
  private closeCallbacks: (() => void)[] = [];
  private errorCallbacks: ((err: Error) => void)[] = [];
  private unlisten: UnlistenFn | null = null;

  constructor(private serverId: LspServerId) {
    listen(`lsp-notification-${serverId}`, (event) => {
      const payload = event.payload as any;
      const msg = JSON.stringify(payload);
      this.messageCallbacks.forEach(cb => cb(msg));
    }).then(fn => { this.unlisten = fn; });
  }

  send(message: string): void {
    let parsed: any;
    try { parsed = JSON.parse(message); } catch { return; }

    if (parsed.id !== undefined && parsed.method) {
      // Inject capabilities the package omits but typescript-language-server 5.x
      // requires before it will push textDocument/publishDiagnostics notifications.
      if (parsed.method === 'initialize' && parsed.params?.capabilities) {
        parsed.params.capabilities.textDocument = {
          ...parsed.params.capabilities.textDocument,
          publishDiagnostics: {
            relatedInformation: true,
            versionSupport: false,
            tagSupport: { valueSet: [1, 2] },
          },
        };
        parsed.params.capabilities.workspace = {
          ...parsed.params.capabilities.workspace,
          configuration: true,
        };
      }
      // JSON-RPC request: route through lsp_request, deliver response via onMessage.
      // Rust returns the full server response object; spread it and restore our original
      // id so the package can match it — avoids double-wrapping the result field.
      invoke('lsp_request', {
        language: this.serverId,
        method: parsed.method,
        params: parsed.params ?? {},
      }).then((rawMsg: any) => {
        const resp = JSON.stringify({ ...rawMsg, id: parsed.id });
        this.messageCallbacks.forEach(cb => cb(resp));
      }).catch((err: any) => {
        const errResp = JSON.stringify({
          jsonrpc: '2.0',
          id: parsed.id,
          error: { code: -32603, message: String(err) },
        });
        this.messageCallbacks.forEach(cb => cb(errResp));
      });
    } else if (parsed.method) {
      // JSON-RPC notification: fire and forget
      invoke('lsp_notify', {
        language: this.serverId,
        method: parsed.method,
        params: parsed.params ?? {},
      }).catch(() => {});
    }
  }

  onMessage(callback: (msg: string) => void): void { this.messageCallbacks.push(callback); }
  onClose(callback: () => void): void           { this.closeCallbacks.push(callback); }
  onError(callback: (err: Error) => void): void  { this.errorCallbacks.push(callback); }

  close(): void {
    this.unlisten?.();
    this.closeCallbacks.forEach(cb => cb());
  }
}

// ── Serveur LSP introuvable ────────────────────────────────────────────────────
// POLITIQUE PRODUIT : plus aucune commande shell manuelle. Quand un binaire est
// introuvable, on remonte les métadonnées du catalogue (`needs`) pour que l'UI
// propose une installation en un clic (`lsp_install`) ou explique pourquoi le
// serveur n'est pas installable automatiquement.

export interface MissingServerInfo {
  id: LspServerId;
  label: string;
  /** Code d'explication si le serveur n'est pas installable par l'app. */
  needs?: KnownServer['needs'];
}

function isMissingBinaryError(err: unknown): boolean {
  // Contract : Rust renvoie une erreur STRUCTURÉE (code stable) quand le binaire
  // est introuvable. Aucune heuristique sur le texte — voir `lspProbe.ts`.
  return parseLspBinaryError(err) !== null;
}

// Tracks which servers have already shown the install notification this session
const _missingNotified = new Set<LspServerId>();

// ── Shared client registry ────────────────────────────────────────────────────
// One LanguageServerClient per language+workspace; shared across all open files.

interface ClientEntry {
  client: LanguageServerClient;
  transport: TauriLspTransport;
}

const _clientMap      = new Map<string, ClientEntry>();
const _clientPromises = new Map<string, Promise<ClientEntry>>();

async function getOrCreateClient(
  serverId: LspServerId,
  rootPath: string,
  args?: string[],
  serverPath?: string,
): Promise<ClientEntry> {
  const key = `${serverId}::${rootPath}`;

  const existing = _clientMap.get(key);
  if (existing) return existing;

  const inFlight = _clientPromises.get(key);
  if (inFlight) return inFlight;

  const rootUri       = pathToUri(rootPath);
  const workspaceName = rootPath.split(/[/\\]/).pop() ?? 'workspace';

  const promise = (async () => {
    await invoke('lsp_start', { language: serverId, rootPath, args, serverPath: serverPath ?? null });
    const transport = new TauriLspTransport(serverId);
    const client    = new LanguageServerClient({
      transport,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: workspaceName }],
      documentUri: rootUri,   // placeholder — per-file URI is supplied by the plugin
      languageId: serverId,
    });
    const entry: ClientEntry = { client, transport };
    _clientMap.set(key, entry);
    return entry;
  })().finally(() => _clientPromises.delete(key));

  _clientPromises.set(key, promise);
  return promise;
}

/**
 * Invalide le(s) client(s) LSP d'un serveur venant d'être installé, pour que la
 * prochaine ouverture de fichier redémarre le serveur sur le nouveau binaire.
 * Appelé après `lsp_install` : c'est ce qui rend l'activation « zéro action »
 * (l'utilisateur n'a pas à rouvrir le projet).
 */
export function invalidateLspClient(serverId: LspServerId): void {
  const prefix = `${serverId}::`;
  for (const [key, entry] of _clientMap) {
    if (key.startsWith(prefix)) {
      entry.client.close();
      _clientMap.delete(key);
    }
  }
  _missingNotified.delete(serverId);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function posToOffset(doc: any, pos: { line: number; character: number }): number {
  if (pos.line >= doc.lines) return doc.length;
  const line = doc.line(pos.line + 1);
  return line.from + Math.min(pos.character, line.length);
}

export function uriToPath(uri: string): string {
  if (!uri.startsWith('file://')) return uri;
  // decodeURIComponent handles both file:///d%3A/foo and file:///d:/foo
  let p = decodeURIComponent(uri.slice('file://'.length));
  // file:///C:/foo → C:\foo on Windows
  if (p.startsWith('/') && /^\/[A-Za-z]:\//.test(p)) p = p.slice(1).replace(/\//g, '\\');
  return p;
}

// ── Public extension factory ──────────────────────────────────────────────────

export interface LspExtensionOptions {
  filePath: string;
  rootPath: string;
  /** Id du serveur LSP résolu depuis la config (allowlist Rust). */
  serverId: LspServerId;
  /** Argument additionnels (remplacent les défauts du serveur si fournis). */
  args?: string[];
  /** Chemin explicite du binaire du serveur (prioritaire sur le PATH). */
  serverPath?: string;
  onDefinitionJump?: (filePath: string, line: number, col: number) => void;
  onMissingServer?: (info: MissingServerInfo) => void;
}

export async function createLspExtension(opts: LspExtensionOptions): Promise<Extension> {
  const { filePath, rootPath, serverId, args, serverPath, onDefinitionJump } = opts;

  let entry: ClientEntry;
  try {
    entry = await getOrCreateClient(serverId, rootPath, args, serverPath);
  } catch (err) {
    if (isMissingBinaryError(err) && !_missingNotified.has(serverId)) {
      _missingNotified.add(serverId);
      const known = KNOWN_SERVERS.find(s => s.id === serverId);
      opts.onMissingServer?.({
        id: serverId,
        label: known?.label ?? serverId,
        needs: known?.needs,
      });
    }
    return [];
  }

  const { client, transport } = entry;
  const documentUri = pathToUri(filePath);
  const languageId  = getLspLanguageId(filePath);

  // Custom F12 handler placed before the package's keymap so it takes priority.
  // The package's jumpToDefinitionKeymap only handles same-file navigation;
  // this one additionally calls onDefinitionJump for cross-file results.
  const definitionKeymap = keymap.of([{
    key: 'F12',
    preventDefault: true,
    run: (view) => {
      const pos  = view.state.selection.main.head;
      const line = view.state.doc.lineAt(pos);
      client.textDocumentDefinition({
        textDocument: { uri: documentUri },
        position: { line: line.number - 1, character: pos - line.from },
      }).then((result: any) => {
        if (!result) return;
        const loc   = Array.isArray(result) ? result[0] : result;
        if (!loc) return;
        const uri   = (loc.uri   ?? loc.targetUri)   as string | undefined;
        const range =  loc.range ?? loc.targetRange;
        if (!uri || !range) return;
        if (uri === documentUri) {
          const from = posToOffset(view.state.doc, range.start);
          view.dispatch({ selection: { anchor: from }, scrollIntoView: true });
        } else {
          onDefinitionJump?.(uriToPath(uri), range.start.line + 1, range.start.character + 1);
        }
      }).catch(() => {});
      return true;
    },
  }]);

  const lspExtensions = languageServerWithTransport({
    client,
    // transport / rootUri / workspaceFolders are unused at runtime when `client` is
    // provided, but the TypeScript type still requires them.
    transport: transport as Transport,
    rootUri: null,
    workspaceFolders: null,
    documentUri,
    languageId,
  });

  return [
    // lintState must be in the view for codemirror-languageserver's setDiagnostics
    // dispatch to take effect — the package does not install it automatically.
    linter(() => [], { delay: Infinity }),
    lintGutter(),
    definitionKeymap,
    ...lspExtensions,
  ];
}

// ── Requêtes LSP ponctuelles (formatage, rename, code actions) ─────────────────
// Passent par `lsp_request` (même serveur que le client CM6, déjà démarré et
// initialisé). Le serveur répond avec les structures LSP brutes.

/** Options de formatage envoyées au serveur. */
export interface LspFormattingOptions { tabSize: number; insertSpaces: boolean }

/** `textDocument/formatting` → liste d'éditions (ou `null` si non supporté). */
export async function lspFormatDocument(
  serverId: LspServerId,
  filePath: string,
  options: LspFormattingOptions,
): Promise<LspTextEdit[] | null> {
  return invoke<LspTextEdit[] | null>('lsp_request', {
    language: serverId,
    method: 'textDocument/formatting',
    params: { textDocument: { uri: pathToUri(filePath) }, options },
  });
}

/** `textDocument/prepareRename` → plage + placeholder (ou `null`). */
export async function lspPrepareRename(
  serverId: LspServerId,
  filePath: string,
  position: LspPosition,
): Promise<{ range: LspRange; placeholder: string } | null> {
  const res = await invoke<unknown>('lsp_request', {
    language: serverId,
    method: 'textDocument/prepareRename',
    params: { textDocument: { uri: pathToUri(filePath) }, position },
  });
  if (!res || typeof res !== 'object') return null;
  const r = res as { range?: LspRange; placeholder?: string; start?: LspPosition; end?: LspPosition };
  if (r.range && r.placeholder !== undefined) return { range: r.range, placeholder: r.placeholder };
  if (r.start && r.end) return { range: { start: r.start, end: r.end }, placeholder: r.placeholder ?? '' };
  return null;
}

/** `textDocument/rename` → édition multi-fichiers (ou `null`). */
export async function lspRename(
  serverId: LspServerId,
  filePath: string,
  position: LspPosition,
  newName: string,
): Promise<LspWorkspaceEdit | null> {
  return invoke<LspWorkspaceEdit | null>('lsp_request', {
    language: serverId,
    method: 'textDocument/rename',
    params: { textDocument: { uri: pathToUri(filePath) }, position, newName },
  });
}

/** Élément renvoyé par `textDocument/codeAction` (Command ou CodeAction). */
export interface RawCodeAction {
  title?: string;
  kind?: string;
  isPreferred?: boolean;
  edit?: LspWorkspaceEdit;
  command?: string | { command: string; arguments?: unknown[] };
  arguments?: unknown[];
}

/** `textDocument/codeAction` → actions disponibles dans la plage. */
export async function lspCodeActions(
  serverId: LspServerId,
  filePath: string,
  range: LspRange,
  diagnostics: unknown[],
): Promise<RawCodeAction[]> {
  const res = await invoke<RawCodeAction[] | null>('lsp_request', {
    language: serverId,
    method: 'textDocument/codeAction',
    params: {
      textDocument: { uri: pathToUri(filePath) },
      range,
      context: { diagnostics, only: null, triggerKind: 1 },
    },
  });
  return res ?? [];
}

/** `workspace/executeCommand` — exécute la commande serveur d'une action. */
export async function lspExecuteCommand(
  serverId: LspServerId,
  command: string,
  args: unknown[],
): Promise<void> {
  await invoke('lsp_request', {
    language: serverId,
    method: 'workspace/executeCommand',
    params: { command, arguments: args },
  });
}
