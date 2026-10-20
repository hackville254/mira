/* eslint-disable react-refresh/only-export-components -- exports the useDebugContext hook alongside the provider component */
import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import {
  type DapBreakpoint,
  type DapCapabilities,
  type DapLaunchConfig,
  type DapScope,
  type DapSessionStatus,
  type DapStackFrame,
  type DapStoppedReason,
  type DapThread,
  dapRequest,
  dapStart,
  dapStop,
  onDapEvent,
} from '../lib/dap';
import { fromEvaluate, toSourceBreakpoints } from '../lib/dapWatch';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BreakpointEntry {
  line: number;
  verified: boolean;
  adapterBpId?: number;
  /** Condition d'arrêt (expression évaluée par l'adaptateur). */
  condition?: string;
  /** Nombre de passages (hit count, ex. "5" ou ">3"). */
  hitCondition?: string;
  /** Log point : message loggé au lieu d'arrêter (interpolation {expr}). */
  logMessage?: string;
}

/** Résultat d'une ligne de console / watch. */
export interface DebugEvalEntry {
  id: number;
  expression: string;
  value?: string;
  type?: string;
  variablesReference?: number;
  error?: string;
  /** Ligne de la debug console (REPL) plutôt que d'un watch. */
  kind: 'console' | 'watch';
}

export interface DebugSessionState {
  sessionId: string | null;
  status: DapSessionStatus;
  capabilities: DapCapabilities;
  stoppedThreadId: number | null;
  stoppedReason: DapStoppedReason | null;
  threads: DapThread[];
  stackFrames: DapStackFrame[];
  scopes: DapScope[];
  /** Absolute file path → breakpoint entries. Updated optimistically on toggle. */
  breakpoints: Map<string, BreakpointEntry[]>;
  outputLines: Array<{ category: string; text: string }>;
  /** Watch : expressions suivies, réévaluées à chaque arrêt. */
  watchExpressions: string[];
  /** Résultats d'évaluation (watch + debug console). */
  evalEntries: DebugEvalEntry[];
}

export interface DebugContextType {
  session: DebugSessionState;
  toggleBreakpoint: (filePath: string, line: number) => void;
  /** Met à jour (ou supprime si vide) la condition d'un breakpoint. */
  setBreakpointCondition: (filePath: string, line: number, condition: string) => void;
  /** Met à jour (ou supprime si vide) le hit count d'un breakpoint. */
  setBreakpointHitCondition: (filePath: string, line: number, hitCondition: string) => void;
  /** Met à jour (ou supprime si vide) le log message (log point) d'un breakpoint. */
  setBreakpointLogMessage: (filePath: string, line: number, logMessage: string) => void;
  /** Ajoute une expression au watch (dédoublonnée) et l'évalue si en pause. */
  addWatchExpression: (expression: string) => void;
  /** Retire une expression du watch. */
  removeWatchExpression: (expression: string) => void;
  /** Évalue une expression dans le contexte du point d'arrêt courant (Debug Console). */
  evaluateExpression: (expression: string) => Promise<void>;
  /** Vide le contenu de la Debug Console (résultats d'évaluation). */
  clearConsole: () => void;
  startSession: (config: DapLaunchConfig) => Promise<void>;
  stopSession: () => Promise<void>;
  continueExec: () => Promise<void>;
  stepOver: () => Promise<void>;
  stepIn: () => Promise<void>;
  stepOut: () => Promise<void>;
  pause: () => Promise<void>;
  /** Called by App.tsx so DebugContext can navigate the editor to a paused line. */
  setNavigationCallback: (cb: (filePath: string, line: number, col: number) => void) => void;
}

// ── Empty state ───────────────────────────────────────────────────────────────

const emptySession: DebugSessionState = {
  sessionId: null,
  status: 'idle',
  capabilities: {},
  stoppedThreadId: null,
  stoppedReason: null,
  threads: [],
  stackFrames: [],
  scopes: [],
  breakpoints: new Map(),
  outputLines: [],
  watchExpressions: [],
  evalEntries: [],
};

// ── Context ───────────────────────────────────────────────────────────────────

const DebugContext = createContext<DebugContextType | null>(null);

export function useDebugContext(): DebugContextType {
  const ctx = useContext(DebugContext);
  if (!ctx) throw new Error('useDebugContext must be used inside DebugProvider');
  return ctx;
}

// ── Provider ──────────────────────────────────────────────────────────────────

export function DebugProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<DebugSessionState>(emptySession);

  // Stable refs so closures inside event handlers always see current state
  const sessionRef      = useRef(session);
  // eslint-disable-next-line react-hooks/refs -- stable ref pattern: keep current session visible to event-handler closures
  sessionRef.current    = session;
  const unlistenRef     = useRef<(() => void) | null>(null);
  const navigationCbRef = useRef<((f: string, l: number, c: number) => void) | null>(null);
  const launchConfigRef = useRef<DapLaunchConfig | null>(null);

  // ── Helpers ───────────────────────────────────────────────────────────────

  function setStatus(status: DapSessionStatus) {
    setSession(prev => ({ ...prev, status }));
  }

  function setCapabilities(caps: DapCapabilities) {
    setSession(prev => ({ ...prev, capabilities: caps }));
  }

  // ── Event handler (wired in Phase 4 — stub logs for now) ─────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DAP event bodies are protocol-defined and vary per event type
  const handleEvent = useCallback(async (msg: { event: string; body?: any }) => {
    const sid = sessionRef.current.sessionId;
    if (!sid) return;

    switch (msg.event) {
      case 'initialized': {
        const config = launchConfigRef.current;
        if (!config) break;

        // Send setBreakpoints for each file
        for (const [filePath, bps] of config.sourceBreakpoints) {
          const result = await dapRequest(sid, 'setBreakpoints', {
            source: { path: filePath },
            breakpoints: bps,
          }).catch(() => ({ breakpoints: [] as DapBreakpoint[] }));

          // Update verified status from adapter response
          const verified: DapBreakpoint[] = result?.breakpoints ?? [];
          setSession(prev => {
            const next = new Map(prev.breakpoints);
            const entries = next.get(filePath);
            if (entries) {
              next.set(filePath, entries.map((e, i) => ({
                ...e,
                verified: verified[i]?.verified ?? false,
                adapterBpId: verified[i]?.id,
              })));
            }
            return { ...prev, breakpoints: next };
          });
        }

        await dapRequest(sid, 'setExceptionBreakpoints', { filters: [] }).catch(() => {});
        if (sessionRef.current.capabilities.supportsConfigurationDoneRequest) {
          await dapRequest(sid, 'configurationDone', {}).catch(() => {});
        }

        const { adapter, program, args = [], cwd, stopOnEntry = false } = config;
        await dapRequest(sid, 'launch', {
          type: adapter,
          request: 'launch',
          name: 'Launch',
          program,
          args,
          cwd: cwd ?? '',
          stopOnEntry,
        }).catch(() => {});

        setStatus('running');
        break;
      }

      case 'stopped': {
        const body = msg.body as { reason: DapStoppedReason; threadId?: number; allThreadsStopped?: boolean };
        setSession(prev => ({
          ...prev,
          status: 'paused',
          stoppedThreadId: body.threadId ?? null,
          stoppedReason: body.reason,
        }));

        // Fetch threads, stack, scopes, first-level variables
        const threadId = body.threadId ?? 0;
        const threadsRes = await dapRequest(sid, 'threads', {}).catch(() => ({ threads: [] }));
        const threads: DapThread[] = threadsRes?.threads ?? [];

        const stackRes = await dapRequest(sid, 'stackTrace', {
          threadId,
          startFrame: 0,
          levels: 20,
        }).catch(() => ({ stackFrames: [] }));
        const stackFrames: DapStackFrame[] = stackRes?.stackFrames ?? [];

        let scopes: DapScope[] = [];
        if (stackFrames.length > 0) {
          const scopesRes = await dapRequest(sid, 'scopes', { frameId: stackFrames[0].id })
            .catch(() => ({ scopes: [] }));
          scopes = scopesRes?.scopes ?? [];
        }

        setSession(prev => ({ ...prev, threads, stackFrames, scopes }));

        // Réévalue toutes les expressions de watch dans le contexte de la frame courante.
        const frameId = stackFrames[0]?.id;
        const watchExprs = sessionRef.current.watchExpressions;
        if (frameId !== undefined && watchExprs.length > 0) {
          const results = await Promise.all(watchExprs.map(async expr => {
            const res = await dapRequest(sid, 'evaluate', {
              expression: expr,
              frameId,
              context: 'watch',
            }).catch(() => ({ success: false, message: 'evaluation failed' }));
            return fromEvaluate(expr, res);
          }));
          setSession(prev => ({
            ...prev,
            evalEntries: [
              ...prev.evalEntries.filter(e => e.kind !== 'watch'),
              ...results.map((r, i) => ({
                id: Date.now() + i,
                expression: r.expression,
                value: r.value,
                type: r.type,
                variablesReference: r.variablesReference,
                error: r.error,
                kind: 'watch' as const,
              })),
            ],
          }));
        }

        // Navigate editor to the paused line
        const frame = stackFrames[0];
        if (frame?.source?.path && navigationCbRef.current) {
          navigationCbRef.current(frame.source.path, frame.line, frame.column);
        }
        break;
      }

      case 'continued':
        setSession(prev => ({
          ...prev,
          status: 'running',
          stoppedThreadId: null,
          stoppedReason: null,
          stackFrames: [],
          scopes: [],
        }));
        break;

      case 'terminated':
        setSession(prev => ({ ...prev, status: 'terminated', stackFrames: [], scopes: [], threads: [] }));
        unlistenRef.current?.();
        unlistenRef.current = null;
        await dapStop(sid).catch(() => {});
        break;

      case 'output': {
        const body = msg.body as { category?: string; output: string };
        setSession(prev => ({
          ...prev,
          outputLines: [...prev.outputLines, { category: body.category ?? 'console', text: body.output }],
        }));
        break;
      }

      case 'breakpoint': {
        // Adapter updated a breakpoint (verified/line changed)
        const body = msg.body as { reason: string; breakpoint: DapBreakpoint };
        const bp = body.breakpoint;
        if (!bp.id || !bp.source?.path) break;
        setSession(prev => {
          const next = new Map(prev.breakpoints);
          const filePath = bp.source!.path!;
          const entries = next.get(filePath);
          if (entries) {
            next.set(filePath, entries.map(e =>
              e.adapterBpId === bp.id ? { ...e, verified: bp.verified } : e
            ));
          }
          return { ...prev, breakpoints: next };
        });
        break;
      }
    }
  }, []);

  // ── Public API ────────────────────────────────────────────────────────────

  /** Applique une mutation aux breakpoints d'un fichier puis resynchronise l'adaptateur. */
  function mutateBreakpoints(
    filePath: string,
    fn: (entries: BreakpointEntry[]) => BreakpointEntry[],
  ) {
    // Calcule la liste cible à partir de l'état courant (source de vérité : ref).
    const updated = fn(sessionRef.current.breakpoints.get(filePath) ?? []);
    setSession(prev => {
      const next = new Map(prev.breakpoints);
      if (updated.length === 0) next.delete(filePath);
      else next.set(filePath, updated);
      return { ...prev, breakpoints: next };
    });
    // Pousse la valeur calculée (pas de dépendance au re-render asynchrone).
    const { sessionId: sid, status } = sessionRef.current;
    if (sid && (status === 'running' || status === 'paused')) {
      dapRequest(sid, 'setBreakpoints', {
        source: { path: filePath },
        breakpoints: toSourceBreakpoints(updated),
      }).catch(() => {});
    }
  }

  const toggleBreakpoint = useCallback((filePath: string, line: number) => {
    mutateBreakpoints(filePath, entries => {
      const idx = entries.findIndex(e => e.line === line);
      if (idx >= 0) return entries.filter((_, i) => i !== idx);
      return [...entries, { line, verified: false }];
    });
  }, []);

  /** Met à jour un champ texte d'un breakpoint ('' → supprime le champ). */
  function setBreakpointField(
    filePath: string,
    line: number,
    field: 'condition' | 'hitCondition' | 'logMessage',
    value: string,
  ) {
    const v = value.trim() ? value : undefined;
    mutateBreakpoints(filePath, entries =>
      entries.map(e => (e.line === line ? { ...e, [field]: v } : e)),
    );
  }

  const setBreakpointCondition = useCallback((filePath: string, line: number, condition: string) => {
    setBreakpointField(filePath, line, 'condition', condition);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setBreakpointField est stable
  }, []);

  const setBreakpointHitCondition = useCallback((filePath: string, line: number, hitCondition: string) => {
    setBreakpointField(filePath, line, 'hitCondition', hitCondition);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setBreakpointField est stable
  }, []);

  const setBreakpointLogMessage = useCallback((filePath: string, line: number, logMessage: string) => {
    setBreakpointField(filePath, line, 'logMessage', logMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setBreakpointField est stable
  }, []);

  const addWatchExpression = useCallback((expression: string) => {
    const expr = expression.trim();
    if (!expr) return;
    setSession(prev => ({
      ...prev,
      watchExpressions: prev.watchExpressions.includes(expr)
        ? prev.watchExpressions
        : [...prev.watchExpressions, expr],
    }));
    // Évalue immédiatement si une frame est disponible (session en pause).
    const { sessionId: sid, stackFrames } = sessionRef.current;
    const frameId = stackFrames[0]?.id;
    if (sid && frameId !== undefined) {
      dapRequest(sid, 'evaluate', { expression: expr, frameId, context: 'watch' })
        .catch(() => ({ success: false, message: 'evaluation failed' }))
        .then(res => {
          const r = fromEvaluate(expr, res);
          setSession(prev => ({
            ...prev,
            evalEntries: [
              ...prev.evalEntries,
              {
                id: Date.now(),
                expression: r.expression,
                value: r.value,
                type: r.type,
                variablesReference: r.variablesReference,
                error: r.error,
                kind: 'watch',
              },
            ],
          }));
        });
    }
  }, []);

  const removeWatchExpression = useCallback((expression: string) => {
    setSession(prev => ({
      ...prev,
      watchExpressions: prev.watchExpressions.filter(e => e !== expression),
      evalEntries: prev.evalEntries.filter(e => !(e.kind === 'watch' && e.expression === expression)),
    }));
  }, []);

  const evaluateExpression = useCallback(async (expression: string) => {
    const expr = expression.trim();
    const { sessionId: sid, stackFrames } = sessionRef.current;
    if (!sid || !expr) return;
    const frameId = stackFrames[0]?.id;
    const res = await dapRequest(sid, 'evaluate', {
      expression: expr,
      ...(frameId !== undefined ? { frameId } : {}),
      context: 'repl',
    }).catch(() => ({ success: false, message: 'evaluation failed' }));
    const r = fromEvaluate(expr, res);
    setSession(prev => ({
      ...prev,
      evalEntries: [
        ...prev.evalEntries,
        {
          id: Date.now(),
          expression: r.expression,
          value: r.value,
          type: r.type,
          variablesReference: r.variablesReference,
          error: r.error,
          kind: 'console',
        },
      ],
    }));
  }, []);

  const clearConsole = useCallback(() => {
    setSession(prev => ({ ...prev, evalEntries: [] }));
  }, []);

  const startSession = useCallback(async (config: DapLaunchConfig) => {
    const id = crypto.randomUUID();
    launchConfigRef.current = config;

    // Carry existing breakpoints (avec qualificatifs) into the launch config
    const currentBps = new Map(sessionRef.current.breakpoints);
    if (config.sourceBreakpoints.size === 0 && currentBps.size > 0) {
      for (const [fp, entries] of currentBps) {
        config.sourceBreakpoints.set(fp, toSourceBreakpoints(entries));
      }
    }

    setSession(prev => ({
      ...emptySession,
      breakpoints: prev.breakpoints, // preserve user-set breakpoints across sessions
      sessionId: id,
      status: 'starting',
    }));

    // Subscribe to events BEFORE starting the adapter process.
    // 'initialized' can arrive almost immediately after the initialize response.
    const unlisten = await onDapEvent(id, handleEvent);
    unlistenRef.current = unlisten;

    await dapStart(id, config.adapter, config.adapterPath);

    const caps = await dapRequest(id, 'initialize', {
      clientID: 'mira',
      clientName: 'Mira',
      adapterID: config.adapter,
      pathFormat: 'path',
      linesStartAt1: true,
      columnsStartAt1: true,
      supportsRunInTerminalRequest: false,
    });
    setCapabilities(caps ?? {});
    setStatus('configuring');
    // 'initialized' event drives the rest (see handleEvent above)
  }, [handleEvent]);

  const stopSession = useCallback(async () => {
    const { sessionId: sid } = sessionRef.current;
    if (!sid) return;
    await dapRequest(sid, 'disconnect', { terminateDebuggee: true }).catch(() => {});
    await dapStop(sid).catch(() => {});
    unlistenRef.current?.();
    unlistenRef.current = null;
    setSession(prev => ({ ...emptySession, breakpoints: prev.breakpoints }));
  }, []);

  const continueExec = useCallback(async () => {
    const { sessionId: sid, stoppedThreadId } = sessionRef.current;
    if (!sid) return;
    await dapRequest(sid, 'continue', { threadId: stoppedThreadId ?? 1 }).catch(() => {});
  }, []);

  const stepOver = useCallback(async () => {
    const { sessionId: sid, stoppedThreadId } = sessionRef.current;
    if (!sid) return;
    await dapRequest(sid, 'next', { threadId: stoppedThreadId ?? 1 }).catch(() => {});
  }, []);

  const stepIn = useCallback(async () => {
    const { sessionId: sid, stoppedThreadId } = sessionRef.current;
    if (!sid) return;
    await dapRequest(sid, 'stepIn', { threadId: stoppedThreadId ?? 1 }).catch(() => {});
  }, []);

  const stepOut = useCallback(async () => {
    const { sessionId: sid, stoppedThreadId } = sessionRef.current;
    if (!sid) return;
    await dapRequest(sid, 'stepOut', { threadId: stoppedThreadId ?? 1 }).catch(() => {});
  }, []);

  const pause = useCallback(async () => {
    const { sessionId: sid, threads } = sessionRef.current;
    if (!sid) return;
    await dapRequest(sid, 'pause', { threadId: threads[0]?.id ?? 1 }).catch(() => {});
  }, []);

  const setNavigationCallback = useCallback(
    (cb: (filePath: string, line: number, col: number) => void) => {
      navigationCbRef.current = cb;
    },
    [],
  );

  return (
    <DebugContext.Provider value={{
      session,
      toggleBreakpoint,
      setBreakpointCondition,
      setBreakpointHitCondition,
      setBreakpointLogMessage,
      addWatchExpression,
      removeWatchExpression,
      evaluateExpression,
      clearConsole,
      startSession,
      stopSession,
      continueExec,
      stepOver,
      stepIn,
      stepOut,
      pause,
      setNavigationCallback,
    }}>
      {children}
    </DebugContext.Provider>
  );
}
