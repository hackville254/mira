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
 * The only functional global we inject is an `origin` object (Origin's own
 * extension API, intentionally NOT the VS Code `vscode` API) whose methods are
 * host functions marshalled onto the {@link HostBridge} interface. Every host
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
   * `origin.extensions.getExtension` / `.all`. MUST be called before
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

/** One entry of the `origin.extensions.*` metadata snapshot. */
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
  installOriginApi(ctx, bridge, onLog);
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
 * Wrap extension source so it behaves like a CJS module with the `origin` import.
 *
 * Real `.vsix` bundles are produced by webpack/esbuild targeting Node.js, so
 * their preamble calls `require("path")`, `require("fs")`, ... before any of our
 * shim runs. We therefore expose a small, deliberately inert `require`:
 *
 *   - `origin` (and its legacy `vscode` alias) resolves to the injected API;
 *   - a tiny set of Node built-ins used at load time (`path`, `os`, `util`,
 *     `url`) resolve to minimal stubs so the bundle can initialise;
 *   - a webpack runtime (`__webpack_require__` + `__webpack_modules__` cache) is
 *     provided, because some bundles reference it from the entrypoint scope;
 *   - a missing, unneeded module resolves to `{}` (webpack `ignore` semantics)
 *     rather than throwing — a single `require("fs")` must not break an
 *     otherwise inert extension. The capability-gated `origin` API remains the
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
  if (name === 'origin' || name === 'vscode') return globalThis.__originApi;
  if (Object.prototype.hasOwnProperty.call(__originNodeShims, name)) return __originNodeShims[name];
  if (typeof name === 'string' && name.indexOf('node:') === 0) { var nn = name.slice(5); if (Object.prototype.hasOwnProperty.call(__originNodeShims, nn)) return __originNodeShims[nn]; }
  return {};
}
globalThis.__originRequire = __originRequire;
`;
  // Deliberately NO real `require`: only `origin` is functional; unknown modules
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
    // process: Node.js bundles produced for the desktop extension host read
    // process.platform / process.env / process.cwd() at module load. VS Code's
    // web extension host does NOT expose process either (see VS Code "Web
    // Extensions" docs: Node.js globals such as process, os, setImmediate,
    // path, util, url are unavailable) — web extensions must polyfill it
    // themselves. Origin's QuickJS sandbox sits in the same category, so we
    // provide the same kind of inert polyfill: enough surface to let a bundle
    // initialise, with ZERO host access (no real env/PATH, no stdin/stdout, no
    // FS reads). Anything host-bound stays gated behind the origin bridge.
    if (typeof globalThis.process === 'undefined') {
      var __originNoop = function(){};
      var __originEnv = { __proto__: null };
      var __originProcess = {
        platform: 'linux',
        arch: 'x64',
        type: 'extensionHost',
        // Keep the shape features expect, without inventing a real runtime.
        version: 'v20.0.0',
        versions: { node: '20.0.0', v8: '0.0.0', electron: '0.0.0' },
        env: __originEnv,
        argv: ['node', 'extensionHost'],
        execPath: '/usr/bin/node',
        cwd: function(){ return __originExtDir || '/'; },
        chdir: __originNoop,
        nextTick: function(fn){ var a = Array.prototype.slice.call(arguments, 1); return Promise.resolve().then(function(){ fn.apply(null, a); }); },
        hrtime: Object.assign(function(){ return [0, 0]; }, { bigint: function(){ return BigInt(0); } }),
        memoryUsage: function(){ return { rss: 0, heapTotal: 0, heapUsed: 0, external: 0 }; },
        uptime: function(){ return 0; },
        // EventEmitter surface: registration is accepted but never invoked, so a
        // bundle registering shutdown hooks cannot observe the host.
        on: __originNoop, once: __originNoop, off: __originNoop,
        removeListener: __originNoop, removeAllListeners: __originNoop,
        emit: function(){ return false; },
        listeners: function(){ return []; },
        // Explicitly absent host handles: accessed lazily so reading them is a
        // no-op object rather than a crash.
        stdin: { on: __originNoop, read: function(){ return null; } },
        stdout: { write: function(){ return true; }, on: __originNoop },
        stderr: { write: function(){ return true; }, on: __originNoop },
      };
      globalThis.process = __originProcess;
    }
    // global alias — Node bundles reference it directly.
    if (typeof globalThis.global === 'undefined') {
      globalThis.global = globalThis;
    }
    // setImmediate / clearImmediate — present in Node, absent in QuickJS.
    if (typeof globalThis.setImmediate !== 'function') {
      globalThis.setImmediate = function(fn){ var a = Array.prototype.slice.call(arguments, 1); return Promise.resolve().then(function(){ fn.apply(null, a); }); };
      globalThis.clearImmediate = function(){};
    }
    // Buffer — minimal, pure-JS shim for the subset bundles touch at load time
    // (from/alloc/concat + utf8 via TextEncoder). No host memory is referenced.
    if (typeof globalThis.Buffer === 'undefined') {
      var __originBuffer = {
        from: function(value){
          if (value && value.__originIsBuffer) return value;
          var bytes = typeof value === 'string'
            ? new TextEncoder().encode(value)
            : (value && value.buffer ? new Uint8Array(value.buffer, value.byteOffset || 0, value.byteLength) : new Uint8Array(value || 0));
          return { __originIsBuffer: true, data: bytes, length: bytes.length, toString: function(){ try { return new TextDecoder().decode(bytes); } catch(e){ return ''; } }, toJSON: function(){ return { type: 'Buffer', data: Array.prototype.slice.call(bytes) }; } };
        },
        alloc: function(size){ return globalThis.Buffer.from(new Uint8Array(size || 0)); },
        concat: function(list){
          var total = 0, i;
          for (i = 0; i < list.length; i++) total += (list[i] && list[i].length) || 0;
          var out = new Uint8Array(total), off = 0;
          for (i = 0; i < list.length; i++) { var d = list[i] && list[i].data ? list[i].data : new Uint8Array(0); out.set(d, off); off += d.length; }
          return globalThis.Buffer.from(out);
        },
        isBuffer: function(v){ return !!(v && v.__originIsBuffer); },
        byteLength: function(s){ return (typeof s === 'string' ? new TextEncoder().encode(s) : s || []).length; },
      };
      globalThis.Buffer = __originBuffer;
    }
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

// ── Shim: origin.* ────────────────────────────────────────────────────────────

/**
 * Build the `origin` namespace — Origin's own extension API — and expose it
 * both as a global and through `require("origin")`.
 *
 * This is deliberately a small, flat, Origin-native surface (`commands`,
 * `workspace`, `editors`, `extensions`, `notify`, `log`) rather than a clone of
 * the VS Code `vscode` API: our extensions are ours, and a narrower API is both
 * easier to reason about and a smaller attack surface. Every method here maps
 * 1:1 onto a capability-gated {@link HostBridge} call.
 */
function installOriginApi(ctx: QuickJSContext, bridge: HostBridge, onLog: LogFn): void {
  const api = ctx.newObject();

  const commands = buildOriginCommands(ctx, bridge, onLog);
  ctx.setProp(api, "commands", commands);
  commands.dispose();

  const workspace = buildOriginWorkspace(ctx, bridge);
  ctx.setProp(api, "workspace", workspace);
  workspace.dispose();

  const editors = buildOriginEditors(ctx, bridge);
  ctx.setProp(api, "editors", editors);
  editors.dispose();

  const extensions = buildOriginExtensions(ctx);
  ctx.setProp(api, "extensions", extensions);
  extensions.dispose();

  const notify = buildOriginNotify(ctx, bridge, onLog);
  ctx.setProp(api, "notify", notify);
  notify.dispose();

  const log = ctx.newFunction("log", (levelHandle, messageHandle) => {
    const level = String(ctx.dump(levelHandle));
    const message = String(ctx.dump(messageHandle));
    const allowed = level === "debug" || level === "info" || level === "warn" || level === "error";
    onLog(allowed ? (level as LogLevel) : "info", message);
  });
  ctx.setProp(api, "log", log);
  log.dispose();

  ctx.setProp(api, "version", ctx.newString("0.1.0"));

  // Export the API both as a global and as a required module.
  ctx.setProp(ctx.global, "__originApi", api);
  ctx.setProp(ctx.global, "origin", api);
  api.dispose();
}

/**
 * `origin.commands.*` — register/execute commands.
 *
 * `registerCommand` stores the QuickJS handler and forwards a host-side
 * callback; the actual invocation is done by the host through the command
 * registry, which enforces the `commands:register` capability at registration.
 */
function buildOriginCommands(
  ctx: QuickJSContext,
  bridge: HostBridge,
  onLog: LogFn,
): QuickJSHandle {
  const commands = ctx.newObject();

  const register = ctx.newFunction("registerCommand", (idHandle, handler) => {
    const id = ctx.dump(idHandle);
    if (typeof id !== "string") {
      throw new Error("origin.commands.registerCommand expects a string id");
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

  const list = ctx.newFunction("getCommands", () => toVmValue(ctx, bridge.getCommandIds()));

  ctx.setProp(commands, "registerCommand", register);
  ctx.setProp(commands, "executeCommand", execute);
  ctx.setProp(commands, "getCommands", list);
  register.dispose();
  execute.dispose();
  list.dispose();
  return commands;
}

/** `origin.workspace.*` — workspace root, file I/O, directory listing. */
function buildOriginWorkspace(ctx: QuickJSContext, bridge: HostBridge): QuickJSHandle {
  const workspace = ctx.newObject();

  const rootFn = ctx.newFunction("getWorkspaceRoot", () => {
    const root = bridge.getWorkspaceRoot();
    return root === null ? ctx.null : ctx.newString(root);
  });
  ctx.setProp(workspace, "getWorkspaceRoot", rootFn);
  rootFn.dispose();

  const readFile = ctx.newFunction("readFile", (pathHandle) => {
    const path = String(ctx.dump(pathHandle));
    return bridgeAsync(ctx, () => bridge.readFile(path));
  });
  const writeFile = ctx.newFunction("writeFile", (pathHandle, contentHandle) => {
    const path = String(ctx.dump(pathHandle));
    const content = String(ctx.dump(contentHandle));
    return bridgeAsync(ctx, () => bridge.writeFile(path, content).then(() => null));
  });
  const listDirectory = ctx.newFunction("listDirectory", (pathHandle) => {
    const path = pathHandle === undefined || ctx.typeof(pathHandle) === "undefined"
      ? undefined
      : String(ctx.dump(pathHandle));
    return bridgeAsync(ctx, () => bridge.listDirectory(path));
  });
  ctx.setProp(workspace, "readFile", readFile);
  ctx.setProp(workspace, "writeFile", writeFile);
  ctx.setProp(workspace, "listDirectory", listDirectory);
  readFile.dispose();
  writeFile.dispose();
  listDirectory.dispose();
  return workspace;
}

/** `origin.editors.*` — read the active editor, replace a document's text. */
function buildOriginEditors(ctx: QuickJSContext, bridge: HostBridge): QuickJSHandle {
  const editors = ctx.newObject();

  const getActive = ctx.newFunction("getActive", () => {
    const doc = bridge.getActiveEditor();
    if (!doc) return ctx.null;
    return toVmValue(ctx, { path: doc.path, uri: doc.uri, languageId: doc.languageId, text: doc.getText() });
  });
  const setText = ctx.newFunction("setText", (pathHandle, contentHandle) => {
    const path = String(ctx.dump(pathHandle));
    const content = String(ctx.dump(contentHandle));
    return bridgeAsync(ctx, () => bridge.setDocumentText(path, content).then(() => null));
  });
  ctx.setProp(editors, "getActive", getActive);
  ctx.setProp(editors, "setText", setText);
  getActive.dispose();
  setText.dispose();
  return editors;
}

/**
 * `origin.extensions.*` — installed-extension metadata.
 *
 * Metadata is snapshotted into the VM before evaluation (see
 * `setExtensionsSnapshot`) because it is read synchronously at module load.
 * Only metadata is exposed — never a cross-extension `exports` proxy, which
 * would let one sandbox reach into another's isolate.
 */
function buildOriginExtensions(ctx: QuickJSContext): QuickJSHandle {
  const ns = ctx.newObject();

  const getExtension = ctx.newFunction("getExtension", (idHandle) => {
    const id = String(ctx.dump(idHandle));
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

/** `origin.notify.*` — user-facing notifications (info/warning/error). */
function buildOriginNotify(ctx: QuickJSContext, bridge: HostBridge, onLog: LogFn): QuickJSHandle {
  const notify = ctx.newObject();
  const mk = (kind: "info" | "warning" | "error") =>
    ctx.newFunction(kind, (messageHandle) => {
      const message = String(ctx.dump(messageHandle));
      return bridgeAsync(ctx, () => bridge.showMessage(kind, message));
    });
  const info = mk("info");
  const warning = mk("warning");
  const error = mk("error");
  ctx.setProp(notify, "info", info);
  ctx.setProp(notify, "warning", warning);
  ctx.setProp(notify, "error", error);
  info.dispose();
  warning.dispose();
  error.dispose();

  // Output channel: the extension's own log sink. Lines go to the extension log
  // (same as `console`); purely a logging convenience, never a real terminal.
  const createOutputChannel = ctx.newFunction("createOutputChannel", (nameHandle) => {
    const name = String(ctx.dump(nameHandle));
    const channel = ctx.newObject();
    const appendLine = ctx.newFunction("appendLine", (v) => {
      onLog("info", `[${name}] ${String(ctx.dump(v))}`);
    });
    const noop = ctx.newFunction("__noop", () => ctx.undefined);
    ctx.setProp(channel, "append", appendLine);
    ctx.setProp(channel, "appendLine", appendLine);
    ctx.setProp(channel, "show", noop);
    ctx.setProp(channel, "hide", noop);
    ctx.setProp(channel, "clear", noop);
    ctx.setProp(channel, "dispose", noop);
    ctx.setProp(channel, "name", ctx.newString(name));
    appendLine.dispose();
    noop.dispose();
    return channel;
  });
  ctx.setProp(notify, "createOutputChannel", createOutputChannel);
  createOutputChannel.dispose();

  return notify;
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
