/* eslint-disable react-refresh/only-export-components -- exports the useDiagnostics hook alongside the provider component */
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { onLspNotification, type LspServerId } from '../lib/lsp';
import { getSupportedLspServerIds } from '../lib/languages';

// ── Types ─────────────────────────────────────────────────────────────────────

export type DiagnosticSeverity = 'error' | 'warning' | 'info' | 'hint';

export interface DiagnosticEntry {
  /** Ligne 1-based (LSP est 0-based à la réception, converti ici). */
  line: number;
  /** Colonne 1-based. */
  col: number;
  severity: DiagnosticSeverity;
  message: string;
  /** Nom du code (ex. "TS2304") s'il est fourni par le serveur. */
  code?: string;
  source?: string;
}

/** Diagnostics groupés par chemin absolu de fichier. */
export type DiagnosticsByFile = Map<string, DiagnosticEntry[]>;

export interface DiagnosticsContextType {
  byFile: DiagnosticsByFile;
  errors: number;
  warnings: number;
  /** Nombre total de diagnostics (toutes sévérités). */
  total: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Écoute les notifications de tous les serveurs LSP connus du registre.
// (Le canal d'événement est keyé par serverId, pas par langage.)
const LSP_SERVER_IDS: LspServerId[] = getSupportedLspServerIds();

/**
 * Convertit un URI `file://` en chemin local absolu.
 * Inverse de `pathToUri` : gère le format Windows `file:///c%3A/...`.
 */
export function uriToPath(uri: string): string {
  let s = uri;
  if (s.startsWith('file://')) s = s.slice('file://'.length);
  // Windows drive-letter form: /c%3A/foo or /C:/foo
  const winMatch = /^\/?([A-Za-z])(?:%3A|:)(\/.*)$/.exec(s);
  if (winMatch) {
    return `${winMatch[1].toUpperCase()}:${decodeURIComponent(winMatch[2])}`;
  }
  s = decodeURIComponent(s);
  return s;
}

function normalizeSeverity(raw: unknown): DiagnosticSeverity {
  switch (raw) {
    case 1: return 'error';
    case 2: return 'warning';
    case 3: return 'info';
    case 4: return 'hint';
    default: return 'warning';
  }
}

interface RawDiagnostic {
  range?: { start?: { line?: number; character?: number } };
  severity?: number;
  message?: string;
  code?: string | number;
  source?: string;
}

function toEntries(diags: RawDiagnostic[]): DiagnosticEntry[] {
  return diags.map(d => ({
    line: (d.range?.start?.line ?? 0) + 1,
    col:  (d.range?.start?.character ?? 0) + 1,
    severity: normalizeSeverity(d.severity),
    message: d.message ?? '',
    code: d.code !== undefined ? String(d.code) : undefined,
    source: d.source,
  }));
}

// ── Context ───────────────────────────────────────────────────────────────────

const DiagnosticsContext = createContext<DiagnosticsContextType | null>(null);

export function useDiagnostics(): DiagnosticsContextType {
  const ctx = useContext(DiagnosticsContext);
  if (!ctx) throw new Error('useDiagnostics must be used inside DiagnosticsProvider');
  return ctx;
}

// ── Provider ──────────────────────────────────────────────────────────────────

export function DiagnosticsProvider({ children }: { children: React.ReactNode }) {
  const [byFile, setByFile] = useState<DiagnosticsByFile>(() => new Map());

  // Écoute les notifications LSP `textDocument/publishDiagnostics` de tous les
  // serveurs connus (canal keyé par serverId).
  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let cancelled = false;

    for (const serverId of LSP_SERVER_IDS) {
      onLspNotification(serverId, (msg: { method?: string; params?: { uri?: string; diagnostics?: RawDiagnostic[] } }) => {
        if (msg?.method !== 'textDocument/publishDiagnostics') return;
        const uri = msg.params?.uri;
        if (!uri) return;
        const path = uriToPath(uri);
        const diagnostics = toEntries(msg.params?.diagnostics ?? []);
        setByFile(prev => {
          const next = new Map(prev);
          if (diagnostics.length === 0) next.delete(path);
          else next.set(path, diagnostics);
          return next;
        });
      }).then(un => {
        if (cancelled) un();
        else unlisteners.push(un);
      }).catch(() => { /* listener registration failed — ignore */ });
    }

    return () => {
      cancelled = true;
      for (const un of unlisteners) un();
    };
  }, []);

  const { errors, warnings, total } = useMemo(() => {
    let e = 0, w = 0, t = 0;
    for (const entries of byFile.values()) {
      for (const d of entries) {
        t++;
        if (d.severity === 'error') e++;
        else if (d.severity === 'warning') w++;
      }
    }
    return { errors: e, warnings: w, total: t };
  }, [byFile]);

  const value = useMemo<DiagnosticsContextType>(
    () => ({ byFile, errors, warnings, total }),
    [byFile, errors, warnings, total],
  );

  return <DiagnosticsContext.Provider value={value}>{children}</DiagnosticsContext.Provider>;
}
