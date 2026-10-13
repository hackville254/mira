import type { Ref } from 'react';
import Editor, { type EditorHandle, type EditorContext } from './Editor';
import AiDiffPane, { type AiDiffTabData } from './AiDiffPane';
import WebPreviewPane from './WebPreviewPane';
import MarkdownPreviewPane from './MarkdownPreviewPane';
import ImageViewerPane from './ImageViewerPane';
import PdfViewerPane from './PdfViewerPane';
import VideoViewerPane from './VideoViewerPane';
import AudioViewerPane from './AudioViewerPane';
import UnsupportedFilePane from './UnsupportedFilePane';
import EditorEmptyState from './EditorEmptyState';
import EditorWelcome from './EditorWelcome';
import Breadcrumbs from '../breadcrumbs/Breadcrumbs';
import { fileKindOf } from '../../lib/fileKind';
import type { Tab } from './TabBar';
import type { MissingServerInfo } from '../../lib/lspCm6';
import type { AiCompletionFn } from '../../lib/aiAutocomplete';
import type { FileEdits } from '../../lib/lspEdits';

// ── EditorArea ────────────────────────────────────────────────────────────────
// Rend le contenu de l'onglet actif d'un « groupe » d'éditeurs. Extrait de
// App.tsx pour être réutilisé par les deux panneaux du split (et éviter la
// duplication du routage d'onglets). Le chrome (TabBar, terminal, DebugToolbar)
// reste géré par l'appelant.

export interface EditorAreaProps {
  folderPath: string | null;
  tabs: Tab[];
  activeTab: string | null;
  fileContents: Record<string, string>;
  binaryData: Record<string, { base64: string; mime: string }>;
  fileErrors: Record<string, string>;
  cursorPositions: Record<string, { line: number; col: number }>;
  /** Ligne du haut visible par fichier (synchronisation du scroll de la preview MD). */
  topLines: Record<string, number>;
  jumpRequest: { path: string; line: number; col: number; key: number } | null;
  editorRef: Ref<EditorHandle>;
  lspGeneration: number;
  getAiCompletion?: AiCompletionFn;
  onEditorChange: (path: string, value: string) => void;
  onCursorChange: (path: string, line: number, col: number) => void;
  /** Notifie la ligne du haut visible d'un fichier (défilement de l'éditeur). */
  onScrollLine: (path: string, line: number) => void;
  onCloseTab: (path: string) => void;
  onAddToAiContext: (ctx: EditorContext) => void;
  onAcceptDiff: (path: string) => void;
  onDefinitionJump: (filePath: string, line: number, col: number) => void;
  onMissingServer: (info: MissingServerInfo) => void;
  onToggleBreakpoint: (filePath: string, line: number) => void;
  /** Applique les éditions LSP (rename / code action) touchant d'autres fichiers. */
  onApplyWorkspaceEdits: (edits: FileEdits[]) => void;
  onOpenFolder: () => void;
  onOpenProject: (path: string) => void;
  /** Apparence de l'éditeur (commandes « Toggle … » de la palette). */
  minimap?: boolean;
  stickyScroll?: boolean;
  bracketColorization?: boolean;
}

export default function EditorArea(props: EditorAreaProps) {
  const {
    folderPath, tabs, activeTab, fileContents, binaryData, fileErrors,
    cursorPositions, topLines, jumpRequest, editorRef, lspGeneration, getAiCompletion,
    onEditorChange, onCursorChange, onScrollLine, onCloseTab, onAddToAiContext,
    onAcceptDiff, onDefinitionJump, onMissingServer, onToggleBreakpoint,
    onApplyWorkspaceEdits, onOpenFolder, onOpenProject,
    minimap, stickyScroll, bracketColorization,
  } = props;

  const fileName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

  if (!folderPath) {
    return <EditorEmptyState onOpenFolder={onOpenFolder} onOpenProject={onOpenProject} />;
  }
  if (tabs.length === 0) {
    return <EditorWelcome />;
  }
  if (activeTab?.startsWith('__diff__')) {
    const diffTab = tabs.find(t => t.path === activeTab) as AiDiffTabData | undefined;
    if (!diffTab) return null;
    return <AiDiffPane tab={diffTab} onClose={() => onCloseTab(activeTab)} />;
  }
  if (activeTab === '__preview__') {
    return <WebPreviewPane />;
  }
  if (activeTab?.startsWith('__mdpreview__')) {
    const mdTab = tabs.find(t => t.path === activeTab);
    const fp = mdTab?.filePath ?? activeTab.slice('__mdpreview__'.length);
    const src = fileContents[fp] ?? '';
    return (
      <MarkdownPreviewPane
        content={src}
        fileName={fileName(fp)}
        syncLine={topLines[fp] ?? null}
        syncTotalLines={src.length === 0 ? 1 : src.split('\n').length}
      />
    );
  }
  if (activeTab && fileKindOf(activeTab) === 'image') {
    if (binaryData[activeTab]) {
      return <ImageViewerPane base64={binaryData[activeTab].base64} mime={binaryData[activeTab].mime} fileName={fileName(activeTab)} />;
    }
    return fileErrors[activeTab]
      ? <UnsupportedFilePane fileName={fileName(activeTab)} reason={fileErrors[activeTab]} />
      : <LoadingPane />;
  }
  if (activeTab && fileKindOf(activeTab) === 'pdf') {
    if (binaryData[activeTab]) {
      return <PdfViewerPane base64={binaryData[activeTab].base64} fileName={fileName(activeTab)} />;
    }
    return fileErrors[activeTab]
      ? <UnsupportedFilePane fileName={fileName(activeTab)} reason={fileErrors[activeTab]} />
      : <LoadingPane />;
  }
  if (activeTab && fileKindOf(activeTab) === 'binary') {
    return <UnsupportedFilePane fileName={fileName(activeTab)} />;
  }
  if (activeTab && fileKindOf(activeTab) === 'video') {
    if (binaryData[activeTab]) {
      return <VideoViewerPane base64={binaryData[activeTab].base64} mime={binaryData[activeTab].mime} fileName={fileName(activeTab)} />;
    }
    return fileErrors[activeTab]
      ? <UnsupportedFilePane fileName={fileName(activeTab)} reason={fileErrors[activeTab]} />
      : <LoadingPane />;
  }
  if (activeTab && fileKindOf(activeTab) === 'audio') {
    if (binaryData[activeTab]) {
      return <AudioViewerPane base64={binaryData[activeTab].base64} mime={binaryData[activeTab].mime} fileName={fileName(activeTab)} />;
    }
    return fileErrors[activeTab]
      ? <UnsupportedFilePane fileName={fileName(activeTab)} reason={fileErrors[activeTab]} />
      : <LoadingPane />;
  }
  if (activeTab && fileContents[activeTab] !== undefined) {
    return (
      <div className="flex-1 flex flex-col overflow-hidden min-h-0">
        <Breadcrumbs
          activePath={activeTab}
          content={fileContents[activeTab]}
          rootPath={folderPath ?? undefined}
          cursorLine={cursorPositions[activeTab]?.line}
          onJump={(line, col) => onDefinitionJump(activeTab, line, col)}
        />
        <Editor
          ref={editorRef}
          path={activeTab}
          content={fileContents[activeTab]}
          onChange={v => onEditorChange(activeTab, v)}
          onCursorChange={(line, col) => onCursorChange(activeTab, line, col)}
          onScrollLine={line => onScrollLine(activeTab, line)}
          initialCursor={cursorPositions[activeTab]}
          jumpTo={jumpRequest?.path === activeTab ? jumpRequest : undefined}
          onAddToAiContext={onAddToAiContext}
          onAcceptDiff={() => onAcceptDiff(activeTab)}
          rootPath={folderPath}
          onDefinitionJump={onDefinitionJump}
          onMissingServer={onMissingServer}
          lspGeneration={lspGeneration}
          getAiCompletion={getAiCompletion}
          onToggleBreakpoint={onToggleBreakpoint}
          onApplyWorkspaceEdits={onApplyWorkspaceEdits}
          minimap={minimap}
          stickyScroll={stickyScroll}
          bracketColorization={bracketColorization}
        />
      </div>
    );
  }
  if (activeTab && fileErrors[activeTab]) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2">
        <p className="text-xs" style={{ color: 'var(--origin-semantic-error)' }}>Failed to read {fileName(activeTab)}</p>
        <p className="text-xs" style={{ color: 'var(--origin-fg-subtle)' }}>{fileErrors[activeTab]}</p>
      </div>
    );
  }
  return <LoadingPane />;
}

function LoadingPane() {
  return (
    <div className="flex-1 flex items-center justify-center">
      <span className="text-xs" style={{ color: 'var(--origin-fg-subtle)', opacity: 0.6, letterSpacing: '0.12em' }}>
        Loading<span style={{ animation: 'origin-ellipsis 1.2s steps(4, end) infinite' }}>…</span>
      </span>
    </div>
  );
}