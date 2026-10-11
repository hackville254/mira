/**
 * Sandboxed extension runtime (Level 2) — QuickJS/WASM.
 *
 * Extension code is untrusted: it comes from a downloaded `.vsix`. We never
 * `eval` it in the webview (that would hand it the DOM, `window`, Tauri's
 * `invoke`, localStorage, fetch, ...). Instead we run it inside a QuickJS
 * interpreter compiled to WebAssembly, a fresh isolate with NO ambient access:
 *
 *   - no DOM / no `window` / no `document`
 *   - no network (no `fetch` / `XMLHttpRequest`)
 *   - no `require` / `import` / filesystem
 *   - no `invoke` (so no Tauri command surface, no SSRF, no RCE)
 *
 * The only global we inject is a `vscode` object whose methods are host
 * functions marshalled onto the {@link HostBridge} interface. Every host
 * function runs through the permission mediator on the host side, so a
 * misbehaving extension cannot exceed what the user consented to.
 *
 * The WASM module is created once (lazy, memoised) — instantiating it is
 * expensive and must not happen per extension.
 */

import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSWASMModule,
  type QuickJSContext,
  type QuickJSHandle,
} from "quickjs-emscripten-core";
import releaseVariant from "@jitl/quickjs-singlefile-browser-release-sync";
import type { HostBridge } from "./hostBridge";

/** Result of `ctx.callFunction` / `ctx.evalCode` (not re-exported by the lib). */
type VmCallResult = ReturnType<QuickJSContext["callFunction"]>;

type LogLevel = "debug" | "info" | "warn" | "error";
type LogFn = (level: LogLevel, message: string) => void;

// ── Module singleton ──────────────────────────────────────────────────────────

let modulePromise: Promise<QuickJSWASMModule> | null = null;

/** Lazily create (once) the shared QuickJS WASM module. */
function getQuickJS(): Promise<QuickJSWASMModule> {
  if (!modulePromise) {
    modulePromise = newQuickJSWASMModuleFromVariant(releaseVariant);
  }
  return modulePromise;
}

// ── Marshalling helpers ───────────────────────────────────────────────────────

/** Recursively convert a host JS value into a QuickJS value in `ctx`. */
function toVmValue(ctx: QuickJSContext, value: unknown): QuickJSHandle {
  if (value === null || value === undefined) return ctx.null;
  switch (typeof value) {
    case "boolean":
      return value ? ctx.true : ctx.false;
    case "number":
      return ctx.newNumber(value);
    case "string":
      return ctx.newString(value);
    case "bigint":
      return ctx.newBigInt(value);
    case "object": {
      if (Array.isArray(value)) {
        const arr = ctx.newArray();
        value.forEach((v, i) => {
          const h = toVmValue(ctx, v);
          ctx.setProp(arr, i, h);
          h.dispose();
        });
        return arr;
      }
      const obj = ctx.newObject();
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const h = toVmValue(ctx, v);
        ctx.setProp(obj, k, h);
        h.dispose();
      }
      return obj;
    }
    default:
      return ctx.undefined;
  }
}

/**
 * Invoke an async host function from a synchronous QuickJS call site and return
 * a QuickJS Promise the sandbox can `await`.
 *
 * QuickJS `newFunction` handlers are synchronous, but our host APIs are async
 * (file I/O goes through Tauri). We bridge by creating a deferred promise in
 * the VM, kicking off the async host call, and settling the deferred when it
 * resolves — the sandbox sees a normal Promise.
 */
function bridgeAsync(ctx: QuickJSContext, work: () => Promise<unknown>): QuickJSHandle {
  const deferred = ctx.newPromise();
  // `settled` lets the runtime pump the VM microtask queue until the VM promise
  // resolves (QuickJS needs a manual `executePendingJobs` pass per turn).
  const settled = Promise.resolve().then(work).then(
    (result) => {
      try {
        const h = toVmValue(ctx, result);
        deferred.resolve(h);
        h.dispose();
      } catch {
        /* VM disposed mid-flight — ignore. */
      }
    },
    (err) => {
      try {
        const h = toVmValue(ctx, err instanceof Error ? err.message : String(err));
        deferred.reject(h);
        h.dispose();
      } catch {
        /* VM disposed mid-flight — ignore. */
      }
    },
  );
  // Expose the host-side settle signal on the handle so callers can await it.
  pendingSettles.set(deferred.handle, settled);
  return deferred.handle;
}

/**
 * Host-side wait for a VM promise returned by a bridged host call. Registers
 * the pending settle promise (see {@link bridgeAsync}) so `settleCallResult`
 * can await it.
 */
const pendingSettles = new WeakMap<object, Promise<void>>();

// ── Runtime handle ────────────────────────────────────────────────────────────

export interface ExtensionRuntime {
  /** Evaluate the extension entrypoint source inside this isolate. */
  evalModule: (source: string, filename?: string) => void;
  /**
   * Populate the in-VM extension metadata table read (synchronously) by
   * `vscode.extensions.getExtension` / `.all`. MUST be called before
   * {@link evalModule} — bundles read their own manifest at module load.
   */
  setExtensionsSnapshot: (entries: ExtensionSnapshotEntry[]) => void;
  /** Call `activate(context)` if the module exports one. */
  activate: (extensionId: string, extensionPath: string) => Promise<void>;
  /** Call `deactivate()` (best-effort, never throws). */
  deactivate: () => Promise<void>;
  /** Dispose the whole isolate. Idempotent. */
  dispose: () => void;
}

/** One entry of the `vscode.extensions.*` metadata snapshot. */
export interface ExtensionSnapshotEntry {
  id: string;
  extensionPath: string;
  isActive: boolean;
  packageJSON: Record<string, unknown>;
}

/**
 * Create an isolated QuickJS context wired to `bridge`.
 *
 * The context is a brand-new isolate: nothing global survives between
 * extensions except the WASM module itself (which holds no JS state).
 */
export async function createExtensionRuntime(
  bridge: HostBridge,
  extensionPath: string,
  onLog: LogFn,
): Promise<ExtensionRuntime> {
  const QuickJS = await getQuickJS();
  const ctx = QuickJS.newContext();
  let disposed = false;

  installConsole(ctx, onLog);
  installWebGlobals(ctx);
  installVscodeShim(ctx, bridge, onLog);
  runSetup(ctx, `globalThis.__originModule = {};`);
  // Empty metadata table by default; the host fills it before eval so bundles
  // that read their own manifest at module load get a synchronous answer.
  runSetup(
    ctx,
    `globalThis.__originExtensions = { __proto__: null };
     globalThis.__originExtensionsOrder = [];`,
  );

  return {
    setExtensionsSnapshot(entries) {
      const table = ctx.newObject();
      const order = ctx.newArray();
      entries.forEach((entry, i) => {
        const value = toVmValue(ctx, {
          id: entry.id,
          extensionPath: entry.extensionPath,
          isActive: entry.isActive,
          packageJSON: entry.packageJSON,
          exports: {},
        });
        ctx.setProp(table, entry.id, value);
        value.dispose();
        const key = ctx.newString(entry.id);
        ctx.setProp(order, i, key);
        key.dispose();
      });
      ctx.setProp(ctx.global, "__originExtensions", table);
      ctx.setProp(ctx.global, "__originExtensionsOrder", order);
      table.dispose();
      order.dispose();
    },

    evalModule(source, filename = "extension.js") {
      const result = ctx.evalCode(wrapCommonJs(source, extensionPath), filename);
      if (result.error) {
        const err = ctx.dump(result.error);
        result.error.dispose();
        throw new Error(`extension failed to load: ${formatVmError(err)}`);
      }
      result.value.dispose();
    },

    async activate(extensionId, extensionPath) {
      const activate = readModuleExport(ctx, "activate");
      if (!activate) return;
      const context = buildExtensionContext(ctx, extensionId, extensionPath);
      const result = ctx.callFunction(activate, ctx.undefined, [context]);
      activate.dispose();
      context.dispose();
      await settleCallResult(ctx, result, "activate");
    },

    async deactivate() {
      if (disposed) return;
      const deactivate = readModuleExport(ctx, "deactivate");
      if (!deactivate) return;
      const result = ctx.callFunction(deactivate, ctx.undefined, []);
      deactivate.dispose();
      // Deactivation errors must never propagate to the host UI.
      await settleCallResult(ctx, result, "deactivate").catch(() => {});
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        ctx.dispose();
      } catch {
        /* already torn down */
      }
    },
  };
}

// ── Module plumbing ───────────────────────────────────────────────────────────

/**
 * Wrap extension source so it behaves like a CJS module with the `vscode` import.
 *
 * Real `.vsix` bundles are produced by webpack/esbuild targeting Node.js, so
 * their preamble calls `require("path")`, `require("fs")`, ... before any of our
 * shim runs. We therefore expose a small, deliberately inert `require`:
 *
 *   - `vscode` resolves to the injected shim;
 *   - a tiny set of Node built-ins used at load time (`path`, `os`, `util`,
 *     `url`) resolve to minimal stubs so the bundle can initialise;
 *   - a webpack runtime (`__webpack_require__` + `__webpack_modules__` cache) is
 *     provided, because some bundles reference it from the entrypoint scope;
 *   - a missing, unneeded module resolves to `{}` (webpack `ignore` semantics)
 *     rather than throwing — a single `require("fs")` must not break an
 *     otherwise inert extension. The capability-gated `vscode` API remains the
 *     only *functional* surface; stubs never touch the host.
 */
function wrapCommonJs(source: string, extensionPath: string): string {
  const prelude = `
var __originExtDir = ${JSON.stringify(extensionPath)};
globalThis.__originExtDir = __originExtDir;
function __originJoin(a, b){ if(!a) return b||''; if(!b) return a; return a.replace(/[\\\\/]+$/,'') + '/' + String(b).replace(/^[\\\\/]+/,''); }
var __originPathShim = {
  sep: '/',
  delimiter: ':',
  join: function(){ return Array.prototype.slice.call(arguments).filter(function(x){return x!=null&&x!=='';}).map(String).join('/').replace(/\\\\/g,'/').replace(/\\/+/g,'/'); },
  resolve: function(){ return __originPathShim.join.apply(null, arguments); },
  dirname: function(p){ p = String(p||'').replace(/\\\\/g,'/'); var i = p.lastIndexOf('/'); return i <= 0 ? (i===0?'/':'') : p.slice(0, i); },
  basename: function(p, ext){ p = String(p||'').replace(/\\\\/g,'/').replace(/\\/+$/,''); var s = p.slice(p.lastIndexOf('/')+1); if(ext && s.slice(-ext.length)===ext) s = s.slice(0,-ext.length); return s; },
  extname: function(p){ p = String(p||'').replace(/\\\\/g,'/'); var b = p.slice(p.lastIndexOf('/')+1); var i = b.lastIndexOf('.'); return i <= 0 ? '' : b.slice(i); },
  relative: function(a, b){ return String(b); },
  normalize: function(p){ return String(p||'').replace(/\\\\/g,'/').replace(/\\/+/g,'/'); },
  isAbsolute: function(p){ return String(p||'').charAt(0) === '/'; },
};
var __originNodeShims = {
  path: __originPathShim,
  'path/posix': __originPathShim,
  os: { EOL: '\\n', platform: function(){ return 'linux'; }, homedir: function(){ return __originExtDir; }, tmpdir: function(){ return '.'; }, type: function(){ return 'Linux'; }, arch: function(){ return 'x64'; }, cpus: function(){ return []; } },
  util: { format: function(){ return Array.prototype.slice.call(arguments).map(String).join(' '); }, inspect: function(o){ try { return JSON.stringify(o); } catch(e){ return String(o); } }, inherits: function(){} },
  url: { parse: function(s){ return { href: String(s), protocol: '', pathname: String(s) }; } },
  assert: function(v, m){ if(!v) throw new Error(m||'Assertion failed'); },
  // Virtual, inert filesystem. We deliberately grant NO host FS access: reads
  // return empty results and writes are silently accepted so that extensions
  // whose activation probes the disk (e.g. Material Icon Theme checking for a
  // cached manifest) do not crash. existsSync reports true so bundles take the
  // "already present, skip regeneration" branch and never attempt a write.
  fs: {
    existsSync: function(){ return true; },
    readdirSync: function(){ return []; },
    readFileSync: function(){ return ''; },
    statSync: function(){ return { isFile: function(){ return false; }, isDirectory: function(){ return true; }, size: 0, mtimeMs: 0 }; },
    writeFileSync: function(){},
    mkdirSync: function(){},
    rmSync: function(){},
    unlinkSync: function(){},
    promises: {},
  },
  'fs/promises': {
    readFile: function(){ return Promise.resolve(''); },
    writeFile: function(){ return Promise.resolve(); },
    mkdir: function(){ return Promise.resolve(); },
    rm: function(){ return Promise.resolve(); },
    readdir: function(){ return Promise.resolve([]); },
    stat: function(){ return Promise.resolve({ isFile: function(){ return false; }, isDirectory: function(){ return true; }, size: 0, mtimeMs: 0 }); },
    access: function(){ return Promise.resolve(); },
    unlink: function(){ return Promise.resolve(); },
  },
};

// webpack's runtime global — some bundles reference it from the entrypoint scope.
var __originModules = {};
function __webpack_require__(id){
  if (Object.prototype.hasOwnProperty.call(__originModules, id)) return __originModules[id];
  var m = { exports: {} };
  __originModules[id] = m.exports;
  var hostReq = function(name){ return __originRequire(name); };
  try { __originVendorModules[id](m, m.exports, hostReq); } catch(e){ /* vendor chunk unavailable — leave exports empty */ }
  return m.exports;
}
__webpack_require__.d = function(exports, def){ for(var k in def) try { Object.defineProperty(exports, k, { enumerable:true, get: def[k] }); } catch(e){ exports[k] = def[k](); } };
__webpack_require__.r = function(exports){ try { Object.defineProperty(exports, '__esModule', { value: true }); } catch(e){} };
__webpack_require__.n = function(m){ var g = m && m.__esModule ? function(){ return m.default; } : function(){ return m; }; g.a = g(); return g; };
__webpack_require__.o = function(o, k){ return Object.prototype.hasOwnProperty.call(o, k); };
function __originRequire(name){
  if (name === 'vscode') return globalThis.__originVscode;
  if (Object.prototype.hasOwnProperty.call(__originNodeShims, name)) return __originNodeShims[name];
  if (typeof name === 'string' && name.indexOf('node:') === 0) { var nn = name.slice(5); if (Object.prototype.hasOwnProperty.call(__originNodeShims, nn)) return __originNodeShims[nn]; }
  return {};
}
globalThis.__originRequire = __originRequire;
`;
  // Deliberately NO real `require`: only `vscode` is functional; unknown modules
  // resolve to an inert `{}` (webpack `ignore` semantics) so a stray Node
  // built-in never aborts loading. No dynamic host access is possible.
  return `(function(){
${prelude}
__originVendorModules = { __proto__: null };
(function(module, exports, require){
${source}
})(globalThis.__originModule, globalThis.__originModule, __originRequire);
})();
`;
}

/**
 * Read a top-level export (`activate`) from the module object, or null.
 *
 * Bundlers commonly reassign `module.exports = <newObject>` (esbuild's
 * `__toCommonJS`, webpack). In real CJS the caller then receives that object,
 * so we must read from `module.exports` when it is an object distinct from
 * `module` itself — otherwise `activate` appears missing.
 */
function readModuleExport(ctx: QuickJSContext, name: string): QuickJSHandle | null {
  const mod = ctx.getProp(ctx.global, "__originModule");
  const exported = ctx.getProp(mod, "exports");
  // Prefer `module.exports` when it is an object (the reassigned CommonJS export).
  const target = ctx.typeof(exported) === "object" && exported !== ctx.null
    ? exported
    : mod;
  const fn = ctx.getProp(target, name);
  if (target !== mod) target.dispose();
  exported.dispose();
  mod.dispose();
  if (ctx.typeof(fn) === "function") return fn;
  fn.dispose();
  return null;
}

/**
 * If a host call returned a QuickJS Promise, await it on the host side so the
 * extension's activation is complete before we report success.
 */
async function settleCallResult(
  ctx: QuickJSContext,
  result: VmCallResult,
  label: string,
): Promise<void> {
  if (result.error) {
    const err = ctx.dump(result.error);
    result.error.dispose();
    throw new Error(`${label}() threw: ${formatVmError(err)}`);
  }
  const value = result.value;

  // If the extension awaited a bridged host call, its `activate()` returns a
  // pending VM promise. We wait for the host side to settle, pump the VM job
  // queue so the continuation runs, then re-inspect the state.
  const settle = pendingSettles.get(value);
  if (settle) {
    await settle;
    try {
      ctx.runtime.executePendingJobs();
    } catch {
      /* runtime gone */
    }
  }

  const state = ctx.getPromiseState(value);
  if (state.type === "rejected") {
    const err = ctx.dump(state.error);
    state.error.dispose();
    value.dispose();
    throw new Error(`${label}() rejected: ${formatVmError(err)}`);
  }
  value.dispose();
}

/** Evaluate trusted bootstrap code, throwing on failure. */
function runSetup(ctx: QuickJSContext, code: string): void {
  const r = ctx.evalCode(code, "__setup");
  if (r.error) {
    const err = ctx.dump(r.error);
    r.error.dispose();
    throw new Error(`runtime setup failed: ${formatVmError(err)}`);
  }
  r.value.dispose();
}

// ── Shim: console ─────────────────────────────────────────────────────────────

/** Minimal `console` shim that routes to the host log. */
function installConsole(ctx: QuickJSContext, onLog: LogFn): void {
  const consoleObj = ctx.newObject();
  const levels: Array<[LogLevel, "debug" | "log" | "info" | "warn" | "error"]> = [
    ["debug", "debug"],
    ["info", "log"],
    ["info", "info"],
    ["warn", "warn"],
    ["error", "error"],
  ];
  for (const [level, method] of levels) {
    const fn = ctx.newFunction(method, (...args) => {
      const parts = args.map((a) => stringifyArg(ctx.dump(a)));
      onLog(level, parts.join(" "));
    });
    ctx.setProp(consoleObj, method, fn);
    fn.dispose();
  }
  ctx.setProp(ctx.global, "console", consoleObj);
  consoleObj.dispose();
}

// ── Shim: web-standard globals ────────────────────────────────────────────────

/**
 * Provide inert, web-standard globals that real `.vsix` bundles reference from
 * their module scope. QuickJS ships a pure-ECMAScript environment, so common
 * browser/Node globals are absent and their mere *reference* can abort loading:
 *
 *   - `structuredClone` — used by several bundles for deep-cloning config
 *   - `queueMicrotask`  — scheduling
 *   - `setTimeout`/`clearTimeout`/`setInterval`/`clearInterval` — timers
 *   - `TextEncoder`/`TextDecoder`, `URL`/`URLSearchParams` — text/url utils
 *
 * NONE of these reach the host: timers run on the host event loop but the
 * callbacks stay inside the sandbox, and text/url helpers are pure. No network,
 * no filesystem, no DOM is introduced.
 */
function installWebGlobals(ctx: QuickJSContext): void {
  runSetup(ctx, `
    if (typeof globalThis.structuredClone !== 'function') {
      globalThis.structuredClone = globalThis.structuredClone || function(value, options) {
        if (value === null || typeof value !== 'object') return value;
        try {
          // JSON round-trip is enough for plain data (the only shapes extensions
          // clone from loaded config/JSON files).
          return JSON.parse(JSON.stringify(value));
        } catch (e) {
          return value;
        }
      };
    }
    if (typeof globalThis.queueMicrotask !== 'function') {
      globalThis.queueMicrotask = function(fn) { return Promise.resolve().then(fn); };
    }
    if (typeof globalThis.TextEncoder === 'undefined') {
      globalThis.TextEncoder = function() {
        this.encode = function(s) {
          s = String(s == null ? '' : s);
          var out = [];
          for (var i = 0; i < s.length; i++) {
            var c = s.charCodeAt(i);
            if (c < 0x80) out.push(c);
            else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
            else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
          }
          return new Uint8Array(out);
        };
      };
    }
    if (typeof globalThis.TextDecoder === 'undefined') {
      globalThis.TextDecoder = function() {
        this.decode = function(buf) {
          if (!buf) return '';
          var bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
          var out = '';
          for (var i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
          try { return decodeURIComponent(escape(out)); } catch (e) { return out; }
        };
      };
    }
    if (typeof globalThis.portal === 'undefined') {
      // no-op marker so feature-detection branches fall through cleanly
    }
  `);
}

// ── Shim: vscode.* ────────────────────────────────────────────────────────────

/** Build the `vscode` namespace object and attach it to the global. */
function installVscodeShim(ctx: QuickJSContext, bridge: HostBridge, onLog: LogFn): void {
  const vscode = ctx.newObject();

  const commands = buildCommands(ctx, bridge, onLog);
  ctx.setProp(vscode, "commands", commands);
  commands.dispose();

  const windowNs = buildWindow(ctx, bridge, onLog);
  ctx.setProp(vscode, "window", windowNs);
  windowNs.dispose();

  const workspace = buildWorkspace(ctx, bridge);
  ctx.setProp(vscode, "workspace", workspace);
  workspace.dispose();

  const uri = buildUri(ctx);
  ctx.setProp(vscode, "Uri", uri);
  uri.dispose();

  const mode = buildExtensionMode(ctx);
  ctx.setProp(vscode, "ExtensionMode", mode);
  mode.dispose();

  const extNs = buildExtensions(ctx);
  ctx.setProp(vscode, "extensions", extNs);
  extNs.dispose();

  const env = buildEnv(ctx);
  ctx.setProp(vscode, "env", env);
  env.dispose();

  const emitter = buildEventEmitter(ctx);
  ctx.setProp(vscode, "EventEmitter", emitter);
  emitter.dispose();

  ctx.setProp(vscode, "version", ctx.newString("1.90.0"));

  const disposable = ctx.newObject();
  const disposableCtor = ctx.newFunction("Disposable", (fn) => {
    const call = fn;
    const obj = ctx.newObject();
    const disposeFn = ctx.newFunction("dispose", () => {
      ctx.callFunction(call, ctx.undefined, []);
    });
    ctx.setProp(obj, "dispose", disposeFn);
    disposeFn.dispose();
    return obj;
  });
  ctx.setProp(disposable, "Disposable", disposableCtor);
  ctx.setProp(vscode, "Disposable", disposableCtor);
  disposableCtor.dispose();
  disposable.dispose();

  ctx.setProp(ctx.global, "__originVscode", vscode);
  vscode.dispose();
}

/**
 * `vscode.commands.*`
 *
 * `registerCommand` stores the QuickJS handler and forwards a host-side
 * callback that no-ops here: the actual invocation is done by the host through
 * {@link RuntimeCommandInvoker}, because the host owns the command registry.
 * To keep the wiring simple and safe, the host passes a per-extension invoker.
 */
function buildCommands(
  ctx: QuickJSContext,
  bridge: HostBridge,
  onLog: LogFn,
): QuickJSHandle {
  const commands = ctx.newObject();

  const register = ctx.newFunction("registerCommand", (idHandle, handler) => {
    const id = ctx.dump(idHandle);
    if (typeof id !== "string") {
      throw new Error("commands.registerCommand expects a string id");
    }
    const key = bridge.registerCommand(id, () => {
      if (!ctx.runtime.alive) return null;
      const r = ctx.callFunction(handler, ctx.undefined, []);
      if (r.error) {
        const e = ctx.dump(r.error);
        r.error.dispose();
        onLog("error", `command ${id} threw: ${formatVmError(e)}`);
        return null;
      }
      r.value.dispose();
      return null;
    });
    return buildDisposable(ctx, () => bridge.unregisterCommand(key));
  });

  const execute = ctx.newFunction("executeCommand", (idHandle, ...argHandles) => {
    const id = String(ctx.dump(idHandle));
    const args = argHandles.map((a) => ctx.dump(a));
    return bridgeAsync(ctx, () => bridge.executeCommand(id, args));
  });

  const getCommands = ctx.newFunction("getCommands", () =>
    toVmValue(ctx, bridge.getCommandIds()),
  );

  ctx.setProp(commands, "registerCommand", register);
  ctx.setProp(commands, "executeCommand", execute);
  ctx.setProp(commands, "getCommands", getCommands);
  register.dispose();
  execute.dispose();
  getCommands.dispose();
  return commands;
}

/** `vscode.window.*` */
function buildWindow(ctx: QuickJSContext, bridge: HostBridge, onLog: LogFn): QuickJSHandle {
  const win = ctx.newObject();

  const mk = (kind: "info" | "warning" | "error") =>
    ctx.newFunction("show", (messageHandle) => {
      const message = String(ctx.dump(messageHandle));
      return bridgeAsync(ctx, () => bridge.showMessage(kind, message));
    });

  const showInfo = mk("info");
  const showWarn = mk("warning");
  const showError = mk("error");

  ctx.setProp(win, "showInformationMessage", showInfo);
  ctx.setProp(win, "showWarningMessage", showWarn);
  ctx.setProp(win, "showErrorMessage", showError);
  // Legacy alias still used by older extensions.
  ctx.setProp(win, "showMessage", showInfo);

  // Output channel: the extension's own log sink. Lines are routed to the host
  // extension log (already captured from `console`); it never reaches a real
  // terminal. Purely a logging convenience, not a privileged surface.
  const createOutputChannel = ctx.newFunction("createOutputChannel", (nameHandle) => {
    const name = String(ctx.dump(nameHandle));
    const channel = ctx.newObject();
    const append = ctx.newFunction("append", (v) => {
      onLog("info", `[${name}] ${String(ctx.dump(v))}`);
    });
    const appendLine = ctx.newFunction("appendLine", (v) => {
      onLog("info", `[${name}] ${String(ctx.dump(v))}`);
    });
    const noop = ctx.newFunction("__noop", () => ctx.undefined);
    ctx.setProp(channel, "append", append);
    ctx.setProp(channel, "appendLine", appendLine);
    ctx.setProp(channel, "show", noop);
    ctx.setProp(channel, "hide", noop);
    ctx.setProp(channel, "clear", noop);
    ctx.setProp(channel, "replace", appendLine);
    ctx.setProp(channel, "dispose", noop);
    ctx.setProp(channel, "name", ctx.newString(name));
    append.dispose();
    appendLine.dispose();
    noop.dispose();
    return channel;
  });
  ctx.setProp(win, "createOutputChannel", createOutputChannel);
  createOutputChannel.dispose();

  // A read-only view of the active editor, refreshed on each access.
  const activeEditor = ctx.newFunction("__activeEditor", () => {
    const doc = bridge.getActiveEditor();
    if (!doc) return ctx.null;
    return toVmValue(ctx, {
      document: {
        uri: { scheme: "file", fsPath: doc.uri, path: doc.uri },
        languageId: doc.languageId,
        fileName: doc.uri,
        getText: undefined,
      },
    });
  });
  ctx.setProp(win, "__activeEditor", activeEditor);

  for (const h of [showInfo, showWarn, showError, activeEditor]) h.dispose();
  return win;
}

/** `vscode.workspace.*` and `vscode.workspace.fs` */
function buildWorkspace(ctx: QuickJSContext, bridge: HostBridge): QuickJSHandle {
  const workspace = ctx.newObject();

  const rootFn = ctx.newFunction("__workspaceRoot", () => {
    const root = bridge.getWorkspaceRoot();
    return root === null ? ctx.null : ctx.newString(root);
  });
  ctx.setProp(workspace, "__workspaceRoot", rootFn);
  rootFn.dispose();

  // vscode.workspace.fs — promises-based file API.
  const fs = ctx.newObject();
  const readFile = ctx.newFunction("readFile", (uriHandle) => {
    const path = uriToPath(ctx, uriHandle);
    return bridgeAsync(ctx, () => bridge.readFile(path).then((text) => encodeUtf8(text)));
  });
  const writeFile = ctx.newFunction("writeFile", (uriHandle, contentHandle) => {
    const path = uriToPath(ctx, uriHandle);
    const raw = ctx.dump(contentHandle);
    const text = Array.isArray(raw) ? decodeUtf8(raw) : String(raw);
    return bridgeAsync(ctx, () => bridge.writeFile(path, text));
  });
  const readDirectory = ctx.newFunction("readDirectory", (uriHandle) => {
    const path = uriHandle === undefined ? undefined : uriToPath(ctx, uriHandle);
    return bridgeAsync(ctx, async () => {
      const entries = await bridge.listDirectory(path);
      // VS Code FileType: File = 1, Directory = 2.
      return entries.map((e) => [e.name, e.isDirectory ? 2 : 1]);
    });
  });
  ctx.setProp(fs, "readFile", readFile);
  ctx.setProp(fs, "writeFile", writeFile);
  ctx.setProp(fs, "readDirectory", readDirectory);
  readFile.dispose();
  writeFile.dispose();
  readDirectory.dispose();
  ctx.setProp(workspace, "fs", fs);
  fs.dispose();

  // ── configuration ────────────────────────────────────────────────────────
  // Inert, read-only settings surface. Almost every extension calls
  // `getConfiguration(section).get(key, default)` in its activate; without it,
  // a `not a function` error aborts activation. We deliberately do NOT persist
  // or expose host state: `get` returns the caller's default, `inspect` reports
  // nothing set, and `update` is a no-op — the sandbox cannot read or mutate
  // real user configuration.
  const getConfiguration = ctx.newFunction("getConfiguration", (sectionHandle) => {
    const section = sectionHandle === undefined ? "" : String(ctx.dump(sectionHandle));
    const config = ctx.newObject();
    ctx.setProp(config, "section", ctx.newString(section));
    const get = ctx.newFunction("get", (_key, defHandle) => {
      // No host config is exposed; return the caller's default (or undefined).
      if (defHandle === undefined || ctx.typeof(defHandle) === "undefined") return ctx.undefined;
      return defHandle;
    });
    const has = ctx.newFunction("has", () => ctx.false);
    const inspect = ctx.newFunction("inspect", () => ctx.undefined);
    const update = ctx.newFunction("update", () =>
      bridgeAsync(ctx, () => Promise.resolve(null)),
    );
    ctx.setProp(config, "get", get);
    ctx.setProp(config, "has", has);
    ctx.setProp(config, "inspect", inspect);
    ctx.setProp(config, "update", update);
    config.dispose();
    get.dispose();
    has.dispose();
    inspect.dispose();
    update.dispose();
    return config;
  });
  ctx.setProp(workspace, "getConfiguration", getConfiguration);
  getConfiguration.dispose();

  const onDidChangeConfiguration = ctx.newFunction("onDidChangeConfiguration", () =>
    buildDisposable(ctx, () => {}),
  );
  ctx.setProp(workspace, "onDidChangeConfiguration", onDidChangeConfiguration);
  onDidChangeConfiguration.dispose();

  return workspace;
}

/** `vscode.Uri` — a minimal file-uri factory. */
function buildUri(ctx: QuickJSContext): QuickJSHandle {
  const uri = ctx.newObject();
  const file = ctx.newFunction("file", (pathHandle) => {
    const p = String(ctx.dump(pathHandle));
    return toVmValue(ctx, { scheme: "file", fsPath: p, path: p });
  });
  const parse = ctx.newFunction("parse", (valueHandle) => {
    const value = String(ctx.dump(valueHandle));
    const fsPath = value.startsWith("file://") ? value.slice("file://".length) : value;
    return toVmValue(ctx, { scheme: "file", fsPath, path: fsPath });
  });
  ctx.setProp(uri, "file", file);
  ctx.setProp(uri, "parse", parse);
  file.dispose();
  parse.dispose();
  return uri;
}

/** `vscode.ExtensionMode` enum stub. */
function buildExtensionMode(ctx: QuickJSContext): QuickJSHandle {
  const mode = ctx.newObject();
  ctx.setProp(mode, "Production", ctx.newNumber(1));
  ctx.setProp(mode, "Development", ctx.newNumber(2));
  ctx.setProp(mode, "Test", ctx.newNumber(3));
  return mode;
}

/**
 * `vscode.extensions.*`
 *
 * Many extensions probe for *other* extensions at load time (e.g. Material
 * Icon Theme checks whether its config helper is present). We expose a minimal,
 * host-backed namespace: `getExtension(id)` returns a descriptor for a known
 * extension (or `undefined`), and `all` lists the installed extensions.
 *
 * Only metadata is exposed — no cross-extension `exports` proxy, which would
 * let one sandbox reach into another's isolate.
 */
function buildExtensions(ctx: QuickJSContext): QuickJSHandle {
  const ns = ctx.newObject();

  const getExtension = ctx.newFunction("getExtension", (idHandle) => {
    const id = String(ctx.dump(idHandle));
    // Synchronous, like VS Code: extensions routinely call
    // `Object.keys(getExtension(id).packageJSON.contributes...)` at *module
    // load*, before any await. The metadata is therefore snapshotted into the
    // VM (see `setExtensionsSnapshot`) before the module is evaluated.
    const table = ctx.getProp(ctx.global, "__originExtensions");
    const entry = ctx.getProp(table, id);
    table.dispose();
    if (ctx.typeof(entry) === "undefined") {
      entry.dispose();
      return ctx.undefined;
    }
    return entry;
  });

  const allFn = ctx.newFunction("all", () => {
    const table = ctx.getProp(ctx.global, "__originExtensions");
    const order = ctx.getProp(ctx.global, "__originExtensionsOrder");
    const n = ctx.dump(ctx.getProp(order, "length")) as number;
    const arr = ctx.newArray();
    for (let i = 0; i < n; i++) {
      const idHandle = ctx.getProp(order, i);
      const entry = ctx.getProp(table, idHandle);
      ctx.setProp(arr, i, entry);
      entry.dispose();
      idHandle.dispose();
    }
    order.dispose();
    table.dispose();
    return arr;
  });

  ctx.setProp(ns, "getExtension", getExtension);
  ctx.setProp(ns, "all", allFn);
  getExtension.dispose();
  allFn.dispose();
  return ns;
}

/** `vscode.env.*` — inert metadata most extensions read at load time. */
function buildEnv(ctx: QuickJSContext): QuickJSHandle {
  const env = ctx.newObject();
  ctx.setProp(env, "appName", ctx.newString("Origin"));
  ctx.setProp(env, "appHost", ctx.newString("origin-desktop"));
  ctx.setProp(env, "language", ctx.newString("en"));
  ctx.setProp(env, "machineId", ctx.newString("origin"));
  ctx.setProp(env, "sessionId", ctx.newString("origin-session"));
  ctx.setProp(env, "uiKind", ctx.newNumber(1)); // UIKind.Desktop
  const clipboard = ctx.newObject();
  const noop = ctx.newFunction("__noop", () => ctx.undefined);
  ctx.setProp(clipboard, "readText", noop);
  ctx.setProp(clipboard, "writeText", noop);
  ctx.setProp(env, "clipboard", clipboard);
  noop.dispose();
  clipboard.dispose();
  return env;
}

/**
 * `vscode.EventEmitter` — a functional event source.
 *
 * This is pure in-isolate bookkeeping (no host access): `event` collects
 * listeners and `fire` invokes them. We expose it because it is a common
 * extension-composition primitive loaded at activation time (e.g. watches).
 */
function buildEventEmitter(ctx: QuickJSContext): QuickJSHandle {
  const ctor = ctx.newFunction("EventEmitter", () => {
    const emitter = ctx.newObject();
    const listeners = ctx.newArray();
    ctx.setProp(emitter, "__listeners", listeners);
    listeners.dispose();

    const event = ctx.newFunction("event", (listener) => {
      const arr = ctx.getProp(emitter, "__listeners");
      const len = ctx.dump(ctx.getProp(arr, "length")) as number;
      ctx.setProp(arr, len, listener);
      arr.dispose();
      // The returned Disposable removes just this listener.
      return buildDisposable(ctx, () => {
        const a = ctx.getProp(emitter, "__listeners");
        const size = ctx.dump(ctx.getProp(a, "length")) as number;
        for (let i = 0; i < size; i++) {
          const h = ctx.getProp(a, i);
          if (h === listener) ctx.setProp(a, i, ctx.undefined);
          h.dispose();
        }
        a.dispose();
      });
    });

    const fire = ctx.newFunction("fire", (value) => {
      const arr = ctx.getProp(emitter, "__listeners");
      const size = ctx.dump(ctx.getProp(arr, "length")) as number;
      for (let i = 0; i < size; i++) {
        const h = ctx.getProp(arr, i);
        if (ctx.typeof(h) === "function") {
          const r = ctx.callFunction(h, ctx.undefined, [value]);
          if (r.error) r.error.dispose();
          else r.value.dispose();
        }
        h.dispose();
      }
      arr.dispose();
    });

    const dispose = ctx.newFunction("dispose", () => {
      const arr = ctx.getProp(emitter, "__listeners");
      ctx.setProp(emitter, "__listeners", ctx.newArray());
      arr.dispose();
    });

    ctx.setProp(emitter, "event", event);
    ctx.setProp(emitter, "fire", fire);
    ctx.setProp(emitter, "dispose", dispose);
    event.dispose();
    fire.dispose();
    dispose.dispose();
    return emitter;
  });
  return ctor;
}

/** Build an `{ dispose() }` object backed by a host callback. */
function buildDisposable(ctx: QuickJSContext, onDispose: () => void): QuickJSHandle {
  const obj = ctx.newObject();
  const fn = ctx.newFunction("dispose", () => {
    onDispose();
  });
  ctx.setProp(obj, "dispose", fn);
  fn.dispose();
  return obj;
}

/** Build the `ExtensionContext` handed to `activate()`. */
function buildExtensionContext(
  ctx: QuickJSContext,
  extensionId: string,
  extensionPath: string,
): QuickJSHandle {
  const context = ctx.newObject();

  const subs = ctx.newArray();
  ctx.setProp(context, "subscriptions", subs);
  subs.dispose();

  ctx.setProp(context, "extensionPath", ctx.newString(extensionPath));
  const extensionUri = toVmValue(ctx, {
    scheme: "file",
    fsPath: extensionPath,
    path: extensionPath,
  });
  ctx.setProp(context, "extensionUri", extensionUri);
  extensionUri.dispose();

  const ext = ctx.newObject();
  ctx.setProp(ext, "id", ctx.newString(extensionId));
  ctx.setProp(ext, "extensionPath", ctx.newString(extensionPath));
  ctx.setProp(ext, "isActive", ctx.true);
  const pkg = ctx.newObject();
  ctx.setProp(ext, "packageJSON", pkg);
  pkg.dispose();
  ctx.setProp(context, "extension", ext);
  ext.dispose();

  ctx.setProp(context, "extensionMode", ctx.newNumber(1));

  const globalState = buildMemento(ctx);
  ctx.setProp(context, "globalState", globalState);
  globalState.dispose();
  const workspaceState = buildMemento(ctx);
  ctx.setProp(context, "workspaceState", workspaceState);
  workspaceState.dispose();

  return context;
}

/**
 * A minimal in-memory `Memento`. We deliberately do NOT back it with
 * localStorage: an extension must not be able to read or clobber host-persisted
 * state. Storage lives only for the lifetime of the isolate.
 */
function buildMemento(ctx: QuickJSContext): QuickJSHandle {
  const store = new Map<string, unknown>();
  const memento = ctx.newObject();
  const get = ctx.newFunction("get", (keyHandle, defHandle) => {
    const key = String(ctx.dump(keyHandle));
    if (store.has(key)) return toVmValue(ctx, store.get(key));
    return defHandle === undefined ? ctx.undefined : defHandle;
  });
  const update = ctx.newFunction("update", (keyHandle, valueHandle) => {
    const key = String(ctx.dump(keyHandle));
    store.set(key, ctx.dump(valueHandle));
    return ctx.undefined;
  });
  ctx.setProp(memento, "get", get);
  ctx.setProp(memento, "update", update);
  get.dispose();
  update.dispose();
  return memento;
}

// ── Small utilities ───────────────────────────────────────────────────────────

/** Extract a filesystem path from a Uri-like QuickJS value. */
function uriToPath(ctx: QuickJSContext, handle: QuickJSHandle): string {
  const dumped = ctx.dump(handle);
  if (typeof dumped === "string") return dumped;
  if (dumped && typeof dumped === "object") {
    const obj = dumped as Record<string, unknown>;
    if (typeof obj.fsPath === "string") return obj.fsPath;
    if (typeof obj.path === "string") return obj.path;
  }
  throw new Error("expected a Uri with a fsPath");
}

function stringifyArg(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Best-effort human message from a dumped VM error value. */
function formatVmError(err: unknown): string {
  if (err === null || err === undefined) return "unknown error";
  if (typeof err === "string") return err;
  if (typeof err === "object") {
    const o = err as Record<string, unknown>;
    if (typeof o.message === "string") return o.message;
    if (typeof o.name === "string") return o.name;
  }
  return stringifyArg(err);
}

/** Encode a string to a UTF-8 byte array (for `workspace.fs.readFile`). */
function encodeUtf8(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

/** Decode a UTF-8 byte array back to a string. */
function decodeUtf8(bytes: number[]): string {
  return new TextDecoder().decode(new Uint8Array(bytes));
}
