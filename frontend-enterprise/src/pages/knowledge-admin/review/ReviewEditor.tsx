/**
 * ReviewEditor.tsx — Git 式审阅编辑器组件。
 *
 * 不调用 API、不使用 useAppIntl/i18n（所有文案经 `labels` props 注入，原文行
 * 内容原样渲染、不翻译）。只依赖同目录下的四个纯函数模块
 * （lineDiff/hunkModel/staging/editorDom）与 shadcn `Button`。
 *
 * 每篇文档（`kind: 'modified'`）用一个独立的 `ModifiedDocumentEditor` 子组件
 * 承载自己的 contenteditable 行编辑器：`useMemo(buildModel, [stagedBase,
 * lines])` 保证按键只重算被编辑的那一篇文档，不影响其它文档（性能约束）。
 * `kind: 'added' | 'deleted'` 的整篇文档只提供"拒绝/恢复"整篇切换，不做逐行
 * 编辑（FR-044 只要求整篇拒绝/恢复，不要求这两类文档本身可编辑）。
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { Button } from '@/components/ui';
import { cn } from '@/lib/utils';
import { splitLines } from './lineDiff';
import {
  alignHunk,
  buildModel,
  charOps,
  innerHtml,
  restorePos,
  type AlignPair,
  type Hunk,
  type Row,
} from './hunkModel';
import {
  acceptAll,
  canUnstage,
  createState,
  hasWork as stagingHasWork,
  reject,
  rejectAll,
  reset,
  stage,
  unstage,
  type StagedRecord,
  type StagingState,
} from './staging';
import {
  deleteRange,
  getCaretPosition,
  getSelectionRange,
  insertTextAtRange,
  mergeWithNext,
  mergeWithPrevious,
  readAllLines,
  setCaretPosition,
} from './editorDom';

/** 单篇文档的输入形状：与服务端对比结果一一对应的 base/current 全文。 */
export interface ReviewEditorDocumentInput {
  lineageId: string;
  title: string;
  kind: 'added' | 'modified' | 'deleted';
  base: string;
  current: string;
}

/** 全部文案由父组件用 t() 注入，组件内部不含任何产品文案字面量。 */
export interface ReviewEditorLabels {
  pendingLabel: string;
  stagedLabel: string;
  allReviewedLabel: string;
  acceptButton: string;
  unacceptButton: string;
  rejectButton: string;
  resetButton: string;
  restoreLineAria: string;
  deleteLineAria: string;
  revertSelectionButton: string;
  rejectDocButton: string;
  restoreDocButton: string;
  stagedBadge: string;
  addedDocBadge: string;
  modifiedDocBadge: string;
  deletedDocBadge: string;
}

/** 单篇文档的输出：当前工作区行、暂存记录、整篇拒绝/恢复标记。 */
export interface ReviewEditorDocOutput {
  lineageId: string;
  kind: 'added' | 'modified' | 'deleted';
  lines: string[];
  staged: StagedRecord[];
  restore: boolean;
}

/** ReviewEditor 向上抛出的整体状态。 */
export interface ReviewEditorOutput {
  docs: ReviewEditorDocOutput[];
  pendingCount: number;
  stagedCount: number;
  hasWork: boolean;
}

export interface ReviewEditorProps {
  documents: ReviewEditorDocumentInput[];
  onChange: (state: ReviewEditorOutput) => void;
  labels: ReviewEditorLabels;
}

interface DocInternalState {
  staging: StagingState;
  restore: boolean;
}

/** 用文档输入初始化一份暂存状态：stagedBase 从 base 起步，lines 从 current 起步。 */
function createInitialDocState(doc: ReviewEditorDocumentInput): DocInternalState {
  return { staging: createState(splitLines(doc.base), splitLines(doc.current)), restore: false };
}

/** 字符串数组浅比较，用于判断整篇文档是否仍等于初始内容。 */
function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

/**
 * 审阅编辑器根组件：渲染文档列表，聚合每篇文档的暂存状态为
 * `{docs, pendingCount, stagedCount, hasWork}` 并通过 onChange 上抛。
 * 输入：documents/labels/onChange；无 API 调用，无 i18n 副作用。
 */
export function ReviewEditor({ documents, onChange, labels }: ReviewEditorProps) {
  const [docStates, setDocStates] = useState<Record<string, DocInternalState>>(() => {
    const map: Record<string, DocInternalState> = {};
    for (const doc of documents) map[doc.lineageId] = createInitialDocState(doc);
    return map;
  });

  const updateDoc = useCallback((lineageId: string, updater: (s: DocInternalState) => DocInternalState) => {
    setDocStates((prev) => {
      const cur = prev[lineageId];
      if (!cur) return prev;
      const next = updater(cur);
      if (next === cur) return prev;
      return { ...prev, [lineageId]: next };
    });
  }, []);

  const output = useMemo<ReviewEditorOutput>(() => {
    let pendingCount = 0;
    let stagedCount = 0;
    let hasWork = false;
    const docs: ReviewEditorDocOutput[] = documents.map((doc) => {
      const st = docStates[doc.lineageId];
      if (!st) {
        return { lineageId: doc.lineageId, kind: doc.kind, lines: [], staged: [], restore: false };
      }
      if (doc.kind === 'modified') {
        const { hunks } = buildModel(st.staging.stagedBase, st.staging.lines);
        pendingCount += hunks.length;
        stagedCount += st.staging.staged.length;
        if (stagingHasWork(st.staging)) hasWork = true;
        return {
          lineageId: doc.lineageId,
          kind: doc.kind,
          lines: st.staging.lines,
          staged: st.staging.staged,
          restore: false,
        };
      }
      if (!arraysEqual(st.staging.lines, st.staging.orig)) hasWork = true;
      return {
        lineageId: doc.lineageId,
        kind: doc.kind,
        lines: st.staging.lines,
        staged: st.staging.staged,
        restore: st.restore,
      };
    });
    return { docs, pendingCount, stagedCount, hasWork };
  }, [documents, docStates]);

  useEffect(() => {
    onChange(output);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [output]);

  return (
    <div className="flex flex-col gap-3 rounded-2xl bg-[#f7f8fa] p-3">
      <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-white px-4 py-2 text-sm">
        <span>
          {output.pendingCount === 0 ? labels.allReviewedLabel : `${labels.pendingLabel} ${output.pendingCount}`}
        </span>
        <span className="text-muted-foreground">
          {labels.stagedLabel} {output.stagedCount}
        </span>
      </div>
      {documents.map((doc) => {
        const st = docStates[doc.lineageId];
        if (!st) return null;
        if (doc.kind === 'modified') {
          return (
            <ModifiedDocumentEditor
              key={doc.lineageId}
              doc={doc}
              state={st.staging}
              labels={labels}
              onStagingChange={(updater) =>
                updateDoc(doc.lineageId, (s) => ({ ...s, staging: updater(s.staging) }))
              }
            />
          );
        }
        return (
          <WholeDocumentPanel
            key={doc.lineageId}
            doc={doc}
            state={st.staging}
            restore={st.restore}
            labels={labels}
            onToggleRestore={() =>
              updateDoc(doc.lineageId, (s) => {
                const nextRestore = !s.restore;
                const nextLines = nextRestore ? [...s.staging.base] : [...s.staging.orig];
                return { ...s, restore: nextRestore, staging: { ...s.staging, lines: nextLines } };
              })
            }
          />
        );
      })}
    </div>
  );
}

/** 转义为纯文本 HTML 片段（复用 hunkModel.innerHtml 的转义逻辑，避免重复实现）。 */
function plainHtml(text: string): string {
  return innerHtml([{ type: '=', text }], '-');
}

interface ModifiedDocumentEditorProps {
  doc: ReviewEditorDocumentInput;
  state: StagingState;
  labels: ReviewEditorLabels;
  onStagingChange: (updater: (s: StagingState) => StagingState) => void;
}

/** 单篇 `modified` 文档的逐行 diff 编辑器：contenteditable 行、事件接管、暂存折叠。 */
function ModifiedDocumentEditor({ doc, state, labels, onStagingChange }: ModifiedDocumentEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const pendingCaretRef = useRef<{ li: number; offset: number } | null>(null);
  const [selection, setSelection] = useState<{ startLi: number; endLi: number } | null>(null);

  const { rows, hunks } = useMemo(
    () => buildModel(state.stagedBase, state.lines),
    [state.stagedBase, state.lines],
  );
  const pairsByHunk = useMemo(() => {
    const map = new Map<number, AlignPair[]>();
    hunks.forEach((h) => map.set(h.id, alignHunk(h)));
    return map;
  }, [hunks]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const pending = pendingCaretRef.current;
    if (container && pending) {
      setCaretPosition(container, pending.li, pending.offset);
    }
    pendingCaretRef.current = null;
  }, [rows]);

  /** 用新的 lines 更新工作区，并记下下一次渲染后要恢复光标的 li/offset。 */
  function applyLines(lines: string[], caret?: { li: number; offset: number }) {
    pendingCaretRef.current = caret ?? null;
    onStagingChange((s) => ({ ...s, lines }));
  }

  /** 非组合期的整篇重算：从 DOM 读回全部行与当前光标，写回工作区状态。 */
  function syncFromDom() {
    const container = containerRef.current;
    if (!container) return;
    const lines = readAllLines(container);
    const caret = getCaretPosition(container);
    pendingCaretRef.current = caret;
    onStagingChange((s) => ({ ...s, lines }));
  }

  /** `input` 事件处理：组合期忽略（不重绘），否则整篇重算。 */
  function handleInput() {
    if (composingRef.current) return;
    syncFromDom();
  }

  /** 输入法组合开始：标记组合中，暂停整篇重算。 */
  function handleCompositionStart() {
    composingRef.current = true;
  }

  /** 输入法组合结束：解除标记并立即整篇重算一次。 */
  function handleCompositionEnd() {
    composingRef.current = false;
    syncFromDom();
  }

  /**
   * keydown 接管：Enter 拆行、Backspace 行首合并、Delete 行尾合并；
   * 跨行选区下的 Backspace/Delete/输入统一走 insertTextAtRange/deleteRange
   * 接管；行内单字符增删交给浏览器原生 contenteditable 处理。
   */
  function handleKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (composingRef.current) return;
    const container = containerRef.current;
    if (!container) return;
    const sel = getSelectionRange(container);
    if (!sel) return;
    const crossRow = sel.startLi !== sel.endLi;
    const hasSelection = crossRow || sel.startOffset !== sel.endOffset;

    if (e.key === 'Enter') {
      e.preventDefault();
      const result = insertTextAtRange(state.lines, sel.startLi, sel.startOffset, sel.endLi, sel.endOffset, '\n');
      applyLines(result.lines, { li: result.caretLi, offset: result.caretOffset });
      return;
    }
    if (e.key === 'Backspace') {
      if (hasSelection) {
        e.preventDefault();
        const result = deleteRange(state.lines, sel.startLi, sel.startOffset, sel.endLi, sel.endOffset);
        applyLines(result.lines, { li: result.caretLi, offset: result.caretOffset });
        return;
      }
      if (sel.startOffset === 0) {
        e.preventDefault();
        const merged = mergeWithPrevious(state.lines, sel.startLi);
        if (merged) applyLines(merged.lines, { li: merged.caretLi, offset: merged.caretOffset });
        return;
      }
      return; // 行内单字符删除交给浏览器原生 contenteditable 处理
    }
    if (e.key === 'Delete') {
      if (hasSelection) {
        e.preventDefault();
        const result = deleteRange(state.lines, sel.startLi, sel.startOffset, sel.endLi, sel.endOffset);
        applyLines(result.lines, { li: result.caretLi, offset: result.caretOffset });
        return;
      }
      if (sel.startOffset === (state.lines[sel.startLi] ?? '').length) {
        e.preventDefault();
        const merged = mergeWithNext(state.lines, sel.startLi);
        if (merged) applyLines(merged.lines, { li: merged.caretLi, offset: merged.caretOffset });
        return;
      }
      return;
    }
    if (crossRow && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      const result = insertTextAtRange(state.lines, sel.startLi, sel.startOffset, sel.endLi, sel.endOffset, e.key);
      applyLines(result.lines, { li: result.caretLi, offset: result.caretOffset });
    }
  }

  /** 粘贴：始终自己接管（避免原生粘贴把换行符塞进单行 .et），可含多行文本。 */
  function handlePaste(e: ReactClipboardEvent<HTMLDivElement>) {
    const container = containerRef.current;
    if (!container) return;
    const sel = getSelectionRange(container);
    if (!sel) return;
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    const result = insertTextAtRange(state.lines, sel.startLi, sel.startOffset, sel.endLi, sel.endOffset, text);
    applyLines(result.lines, { li: result.caretLi, offset: result.caretOffset });
  }

  /** 在 mouseup/keyup 时把当前 DOM 选区同步进 React 状态，供选区撤销按钮判断。 */
  function trackSelection() {
    const container = containerRef.current;
    if (!container) return;
    const sel = getSelectionRange(container);
    setSelection(sel ? { startLi: sel.startLi, endLi: sel.endLi } : null);
  }

  /** 判断某个块是否与当前选区（按 li 区间）相交，供"撤销选中行变更"使用。 */
  function hunkIntersectsSelection(hunk: Hunk): boolean {
    if (!selection) return false;
    const lo = Math.min(selection.startLi, selection.endLi);
    const hi = Math.max(selection.startLi, selection.endLi);
    if (hunk.added.length === 0) return hunk.insertAt >= lo && hunk.insertAt <= hi;
    const start = hunk.insertAt;
    const end = hunk.insertAt + hunk.added.length - 1;
    return start <= hi && end >= lo;
  }

  const intersectingHunks = hunks.filter(hunkIntersectsSelection);

  /** 工具条「接受」：把该块暂存进 stagedBase。 */
  function handleAccept(hunk: Hunk) {
    onStagingChange((s) => stage(s, hunk));
  }
  /** 工具条「拒绝」：把该块在工作区内回退为基线原文。 */
  function handleRejectHunk(hunk: Hunk) {
    onStagingChange((s) => reject(s, hunk));
  }
  /** 「撤销接受」：校验通过后把已暂存的块从 stagedBase 中退回。 */
  function handleUnstageRecord(recordId: number) {
    onStagingChange((s) => unstage(s, recordId));
  }
  /** 红行「↩」：配对则替换对应新增行，未配对则按 restorePos 插回工作区。 */
  function handleRestoreRow(hunk: Hunk, row: Row & { t: '-' }) {
    const pairs = pairsByHunk.get(hunk.id) ?? [];
    const pair = pairs.find((p) => p.ri === row.ri);
    if (pair) {
      const idx = hunk.insertAt + pair.ai;
      const newLines = [...state.lines];
      newLines[idx] = hunk.removed[row.ri];
      applyLines(newLines);
    } else {
      const pos = restorePos(hunk, row.ri, pairs);
      const newLines = [...state.lines.slice(0, pos), hunk.removed[row.ri], ...state.lines.slice(pos)];
      applyLines(newLines);
    }
  }
  /** 绿行「✕」：从工作区里整行删掉这条新增行。 */
  function handleDeleteAddedRow(row: Row & { t: '+' }) {
    const newLines = [...state.lines.slice(0, row.li), ...state.lines.slice(row.li + 1)];
    applyLines(newLines);
  }
  /** 「撤销选中行变更」：把与当前选区相交的全部块整体回退为基线原文。 */
  function handleRevertSelection() {
    if (intersectingHunks.length === 0) return;
    onStagingChange((s) => rejectAll(s, intersectingHunks));
  }

  type RenderItem = { kind: 'toolbar'; hunk: Hunk } | { kind: 'row'; row: Row; index: number };
  const renderItems: RenderItem[] = [];
  const seenHunks = new Set<number>();
  rows.forEach((row, index) => {
    if (row.h !== null && !seenHunks.has(row.h)) {
      seenHunks.add(row.h);
      const hunk = hunks.find((h) => h.id === row.h);
      if (hunk) renderItems.push({ kind: 'toolbar', hunk });
    }
    renderItems.push({ kind: 'row', row, index });
  });

  return (
    <div className="rounded-2xl border border-border/70 bg-white">
      <div className="flex items-center justify-between border-b px-4 py-2 text-sm">
        <span className="font-medium">{doc.title}</span>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="xs" variant="outline" onClick={() => onStagingChange((s) => acceptAll(s, hunks))}>
            {labels.acceptButton}
          </Button>
          <Button type="button" size="xs" variant="ghost" onClick={() => onStagingChange((s) => rejectAll(s, hunks))}>
            {labels.rejectButton}
          </Button>
          <Button type="button" size="xs" variant="ghost" onClick={() => onStagingChange((s) => reset(s))}>
            {labels.resetButton}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={intersectingHunks.length === 0}
            onClick={handleRevertSelection}
          >
            {labels.revertSelectionButton}
          </Button>
        </div>
      </div>
      <div
        ref={containerRef}
        className="review-body whitespace-pre-wrap px-1 py-2 font-mono text-sm leading-6"
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
        onMouseUp={trackSelection}
        onKeyUp={trackSelection}
      >
        {renderItems.map((item) => {
          if (item.kind === 'toolbar') {
            return (
              <div
                key={`toolbar-${item.hunk.id}`}
                contentEditable={false}
                className="flex items-center gap-2 border-y border-dashed border-border/60 bg-muted/40 px-3 py-1 text-xs"
              >
                <Button type="button" size="xs" variant="secondary" onClick={() => handleAccept(item.hunk)}>
                  {labels.acceptButton}
                </Button>
                <Button type="button" size="xs" variant="ghost" onClick={() => handleRejectHunk(item.hunk)}>
                  {labels.rejectButton}
                </Button>
              </div>
            );
          }
          const { row, index } = item;
          const hunk = row.h !== null ? hunks.find((h) => h.id === row.h) : undefined;
          const pairs = hunk ? pairsByHunk.get(hunk.id) ?? [] : [];

          if (row.t === '=') {
            const stagedRecord = state.staged.find(
              (rec) => row.bi >= rec.pos && row.bi < rec.pos + rec.added.length,
            );
            const isStagedFirstRow = !!stagedRecord && row.bi === stagedRecord.pos;
            return (
              <div key={index} className={cn('er flex items-start gap-2 px-3 py-0.5', stagedRecord && 'bg-emerald-50/60')}>
                <div
                  className="et flex-1 whitespace-pre-wrap outline-none"
                  contentEditable
                  suppressContentEditableWarning
                  data-li={row.li}
                  dangerouslySetInnerHTML={{ __html: plainHtml(row.text) }}
                />
                {isStagedFirstRow && stagedRecord && (
                  <span className="flex shrink-0 items-center gap-1 text-xs text-emerald-600">
                    <span aria-hidden="true">{labels.stagedBadge}</span>
                    <button
                      type="button"
                      contentEditable={false}
                      className="underline"
                      disabled={!canUnstage(state, stagedRecord.id)}
                      onClick={() => handleUnstageRecord(stagedRecord.id)}
                    >
                      {labels.unacceptButton}
                    </button>
                  </span>
                )}
              </div>
            );
          }

          if (row.t === '-') {
            const pair = pairs.find((p) => p.ri === row.ri);
            const html =
              pair && hunk ? innerHtml(charOps(row.text, hunk.added[pair.ai]), '-') : plainHtml(row.text);
            return (
              <div key={index} className="er flex items-start gap-2 bg-red-50 px-3 py-0.5">
                <button
                  type="button"
                  contentEditable={false}
                  className="row-btn shrink-0 text-red-600"
                  aria-label={labels.restoreLineAria}
                  onClick={() => hunk && handleRestoreRow(hunk, row)}
                >
                  ↩
                </button>
                <div
                  className="et flex-1 whitespace-pre-wrap text-red-700 line-through decoration-red-400"
                  contentEditable={false}
                  dangerouslySetInnerHTML={{ __html: html }}
                />
              </div>
            );
          }

          // row.t === '+'
          const pair = pairs.find((p) => p.ai === row.ai);
          const html = pair && hunk ? innerHtml(charOps(hunk.removed[pair.ri], row.text), '+') : plainHtml(row.text);
          return (
            <div key={index} className="er flex items-start gap-2 bg-emerald-50 px-3 py-0.5">
              <button
                type="button"
                contentEditable={false}
                className="row-btn shrink-0 text-emerald-700"
                aria-label={labels.deleteLineAria}
                onClick={() => handleDeleteAddedRow(row)}
              >
                ✕
              </button>
              <div
                className="et flex-1 whitespace-pre-wrap text-emerald-800 outline-none"
                contentEditable
                suppressContentEditableWarning
                data-li={row.li}
                dangerouslySetInnerHTML={{ __html: html }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface WholeDocumentPanelProps {
  doc: ReviewEditorDocumentInput;
  state: StagingState;
  restore: boolean;
  labels: ReviewEditorLabels;
  onToggleRestore: () => void;
}

/** `added`/`deleted` 整篇文档的只读展示 + 一键拒绝/恢复面板（不做逐行编辑）。 */
function WholeDocumentPanel({ doc, state, restore, labels, onToggleRestore }: WholeDocumentPanelProps) {
  const colorClass =
    doc.kind === 'added'
      ? 'text-emerald-800 bg-emerald-50'
      : 'text-red-700 bg-red-50 line-through decoration-red-400';
  const buttonLabel = doc.kind === 'added' ? labels.rejectDocButton : labels.restoreDocButton;
  return (
    <div className="rounded-2xl border border-border/70 bg-white">
      <div className="flex items-center justify-between border-b px-4 py-2 text-sm">
        <span className="font-medium">{doc.title}</span>
        <Button type="button" size="xs" variant="outline" aria-pressed={restore} onClick={onToggleRestore}>
          {buttonLabel}
        </Button>
      </div>
      <div className="whitespace-pre-wrap px-1 py-2 font-mono text-sm leading-6">
        {state.lines.map((text, i) => (
          <div key={i} className={cn('er px-3 py-0.5', colorClass)}>
            {text}
          </div>
        ))}
      </div>
    </div>
  );
}
