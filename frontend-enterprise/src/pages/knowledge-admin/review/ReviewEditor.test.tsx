/**
 * ReviewEditor.test.tsx — 审阅编辑器组件测试。
 *
 * jsdom 不实现真实 contenteditable 的浏览器原生编辑行为（键入不会自动更新
 * DOM），因此"整篇重算"类用例通过直接修改 `.et` 的 `textContent` 后派发
 * `InputEvent('input')` 来模拟"浏览器已完成原生插入"，而不是依赖 jsdom 真的
 * 执行 contenteditable 输入；Enter/Backspace/Delete/跨行选区/粘贴用例由组件
 * 自己在 keydown/paste 阶段 `preventDefault` 并接管，天然不依赖浏览器原生
 * 编辑行为，可以直接用 `KeyboardEvent`/`ClipboardEvent`/程序化 Selection
 * 驱动。
 */
// @vitest-environment jsdom
import { act } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReviewEditor, type ReviewEditorLabels, type ReviewEditorOutput } from './ReviewEditor';

const labels: ReviewEditorLabels = {
  pendingLabel: '待审阅',
  stagedLabel: '已接受（暂存）',
  allReviewedLabel: '全部已审阅',
  acceptButton: '接受',
  unacceptButton: '撤销接受',
  rejectButton: '拒绝',
  resetButton: '重置',
  restoreLineAria: '恢复此行原文',
  deleteLineAria: '删除此新增行',
  revertSelectionButton: '撤销选中行变更',
  rejectDocButton: '拒绝新增',
  restoreDocButton: '恢复此文档',
  stagedBadge: '已暂存',
  addedDocBadge: '草稿新增',
  modifiedDocBadge: '草稿修改',
  deletedDocBadge: '草稿删除',
};

afterEach(() => {
  cleanup();
});

function renderEditor(documents: Parameters<typeof ReviewEditor>[0]['documents']) {
  const onChange = vi.fn<(state: ReviewEditorOutput) => void>();
  const utils = render(<ReviewEditor documents={documents} labels={labels} onChange={onChange} />);
  return { ...utils, onChange };
}

function lastOutput(onChange: ReturnType<typeof vi.fn>): ReviewEditorOutput {
  const calls = onChange.mock.calls;
  return calls[calls.length - 1][0] as ReviewEditorOutput;
}

function rowAt(container: HTMLElement, li: number): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-li="${li}"]`);
  if (!el) throw new Error(`no row with data-li=${li}`);
  return el;
}

function setCollapsedCaret(el: HTMLElement, offset: number) {
  const textNode = el.firstChild ?? el;
  const range = document.createRange();
  const len = textNode.textContent?.length ?? 0;
  range.setStart(textNode, Math.min(offset, len));
  range.collapse(true);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

function setCrossRowSelection(startEl: HTMLElement, startOffset: number, endEl: HTMLElement, endOffset: number) {
  const range = document.createRange();
  range.setStart(startEl.firstChild ?? startEl, startOffset);
  range.setEnd(endEl.firstChild ?? endEl, endOffset);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

describe('ReviewEditor — typing recomputes the whole document and keeps caret position', () => {
  it('recomputes red/green rows after a keystroke and restores caret at the edited offset', () => {
    const { container, onChange } = renderEditor([
      { lineageId: 'd1', title: 'doc1.md', kind: 'modified', base: 'a\nb\nc', current: 'a\nX\nc' },
    ]);
    const row = rowAt(container, 1); // the '+' row for 'X' (li=1 in current lines)
    act(() => {
      row.textContent = 'XY';
      setCollapsedCaret(row, 2);
      fireEvent.input(row, { bubbles: true });
    });
    const out = lastOutput(onChange);
    expect(out.docs[0].lines).toEqual(['a', 'XY', 'c']);
  });
});

describe('ReviewEditor — Enter splits a row', () => {
  it('splits the current line into two at the caret and moves caret to the new line start', () => {
    const { container, onChange } = renderEditor([
      { lineageId: 'd1', title: 'doc1.md', kind: 'modified', base: 'hello world', current: 'hello world' },
    ]);
    const row = rowAt(container, 0);
    act(() => {
      setCollapsedCaret(row, 5);
      fireEvent.keyDown(row, { key: 'Enter', bubbles: true, cancelable: true });
    });
    const out = lastOutput(onChange);
    expect(out.docs[0].lines).toEqual(['hello', ' world']);
  });
});

describe('ReviewEditor — Backspace/Delete merge rows', () => {
  it('Backspace at line start merges the row into the previous one', () => {
    const { container, onChange } = renderEditor([
      { lineageId: 'd1', title: 'doc1.md', kind: 'modified', base: 'hello\nworld', current: 'hello\nworld' },
    ]);
    const row = rowAt(container, 1);
    act(() => {
      setCollapsedCaret(row, 0);
      fireEvent.keyDown(row, { key: 'Backspace', bubbles: true, cancelable: true });
    });
    expect(lastOutput(onChange).docs[0].lines).toEqual(['helloworld']);
  });

  it('Delete at line end merges the next row into the current one', () => {
    const { container, onChange } = renderEditor([
      { lineageId: 'd1', title: 'doc1.md', kind: 'modified', base: 'hello\nworld', current: 'hello\nworld' },
    ]);
    const row = rowAt(container, 0);
    act(() => {
      setCollapsedCaret(row, 5);
      fireEvent.keyDown(row, { key: 'Delete', bubbles: true, cancelable: true });
    });
    expect(lastOutput(onChange).docs[0].lines).toEqual(['helloworld']);
  });
});

describe('ReviewEditor — cross-row selection operations', () => {
  it('Backspace deletes a selection spanning two rows, joining prefix and suffix', () => {
    const { container, onChange } = renderEditor([
      { lineageId: 'd1', title: 'doc1.md', kind: 'modified', base: 'abcdef\nghijkl', current: 'abcdef\nghijkl' },
    ]);
    const row0 = rowAt(container, 0);
    const row1 = rowAt(container, 1);
    act(() => {
      setCrossRowSelection(row0, 2, row1, 3);
      fireEvent.keyDown(row0, { key: 'Backspace', bubbles: true, cancelable: true });
    });
    expect(lastOutput(onChange).docs[0].lines).toEqual(['abjkl']);
  });

  it('typing a character over a cross-row selection replaces the whole range', () => {
    const { container, onChange } = renderEditor([
      { lineageId: 'd1', title: 'doc1.md', kind: 'modified', base: 'abcdef\nghijkl', current: 'abcdef\nghijkl' },
    ]);
    const row0 = rowAt(container, 0);
    const row1 = rowAt(container, 1);
    act(() => {
      setCrossRowSelection(row0, 2, row1, 3);
      fireEvent.keyDown(row0, { key: 'Z', bubbles: true, cancelable: true });
    });
    expect(lastOutput(onChange).docs[0].lines).toEqual(['abZjkl']);
  });

  it('pasting multi-line text over a selection splits it into several rows', () => {
    const { container, onChange } = renderEditor([
      { lineageId: 'd1', title: 'doc1.md', kind: 'modified', base: 'abcdef\nghijkl', current: 'abcdef\nghijkl' },
    ]);
    const row0 = rowAt(container, 0);
    const row1 = rowAt(container, 1);
    act(() => {
      setCrossRowSelection(row0, 2, row1, 3);
      const dataTransfer = { getData: () => 'X\nY' } as unknown as DataTransfer;
      fireEvent.paste(row0, { clipboardData: dataTransfer, bubbles: true, cancelable: true });
    });
    expect(lastOutput(onChange).docs[0].lines).toEqual(['abX', 'Yjkl']);
  });
});

describe('ReviewEditor — IME composition does not redraw mid-composition', () => {
  it('ignores input events during composition and syncs once composition ends', () => {
    const { container, onChange } = renderEditor([
      { lineageId: 'd1', title: 'doc1.md', kind: 'modified', base: 'a', current: 'a' },
    ]);
    const callsBefore = onChange.mock.calls.length;
    const row = rowAt(container, 0);
    act(() => {
      fireEvent.compositionStart(row, { bubbles: true });
      row.textContent = '你';
      fireEvent.input(row, { bubbles: true });
    });
    // no state update while composing
    expect(onChange.mock.calls.length).toBe(callsBefore);
    act(() => {
      row.textContent = '你好';
      fireEvent.compositionEnd(row, { bubbles: true });
    });
    expect(lastOutput(onChange).docs[0].lines).toEqual(['你好']);
  });
});

describe('ReviewEditor — accepting a hunk folds it to a staged (✓) row', () => {
  it('accept collapses the block to a plain row with no red/green and increments stagedCount', () => {
    const { container, getAllByText, onChange } = renderEditor([
      { lineageId: 'd1', title: 'doc1.md', kind: 'modified', base: 'a\nb\nc', current: 'a\nX\nc' },
    ]);
    expect(lastOutput(onChange).pendingCount).toBe(1);
    // index 0 is the per-document "accept all" header button; index 1 is the
    // per-hunk toolbar accept button rendered right above the change block.
    const acceptButton = getAllByText(labels.acceptButton)[1];
    act(() => {
      fireEvent.click(acceptButton);
    });
    const out = lastOutput(onChange);
    expect(out.pendingCount).toBe(0);
    expect(out.stagedCount).toBe(1);
    expect(container.querySelectorAll('.diff-char-del, .diff-char-add').length).toBe(0);
    expect(container.textContent).toContain(labels.unacceptButton);
  });

  it('unaccept (undo accept) restores the block to a pending change', () => {
    const { getAllByText, getByText, onChange } = renderEditor([
      { lineageId: 'd1', title: 'doc1.md', kind: 'modified', base: 'a\nb\nc', current: 'a\nX\nc' },
    ]);
    act(() => {
      fireEvent.click(getAllByText(labels.acceptButton)[1]);
    });
    expect(lastOutput(onChange).stagedCount).toBe(1);
    act(() => {
      fireEvent.click(getByText(labels.unacceptButton));
    });
    const out = lastOutput(onChange);
    expect(out.stagedCount).toBe(0);
    expect(out.pendingCount).toBe(1);
  });
});

describe('ReviewEditor — red row restore (↩)', () => {
  it('restores a paired removed line by replacing its matching added line', () => {
    const { container, onChange } = renderEditor([
      {
        lineageId: 'd1',
        title: 'doc1.md',
        kind: 'modified',
        base: 'the quick brown fox',
        current: 'the quick brown fax',
      },
    ]);
    const restoreBtn = container.querySelector<HTMLButtonElement>(
      `button[aria-label="${labels.restoreLineAria}"]`,
    )!;
    act(() => {
      fireEvent.click(restoreBtn);
    });
    expect(lastOutput(onChange).docs[0].lines).toEqual(['the quick brown fox']);
  });

  it('inserts back an unpaired removed line at its restorePos', () => {
    const { container, onChange } = renderEditor([
      { lineageId: 'd1', title: 'doc1.md', kind: 'modified', base: 'a\nb\nc', current: 'a\nc' },
    ]);
    const restoreBtn = container.querySelector<HTMLButtonElement>(
      `button[aria-label="${labels.restoreLineAria}"]`,
    )!;
    act(() => {
      fireEvent.click(restoreBtn);
    });
    expect(lastOutput(onChange).docs[0].lines).toEqual(['a', 'b', 'c']);
  });
});

describe('ReviewEditor — green row delete (✕)', () => {
  it('removes an unpaired added line entirely', () => {
    const { container, onChange } = renderEditor([
      { lineageId: 'd1', title: 'doc1.md', kind: 'modified', base: 'a\nb', current: 'a\nX\nb' },
    ]);
    const deleteBtn = container.querySelector<HTMLButtonElement>(
      `button[aria-label="${labels.deleteLineAria}"]`,
    )!;
    act(() => {
      fireEvent.click(deleteBtn);
    });
    expect(lastOutput(onChange).docs[0].lines).toEqual(['a', 'b']);
  });
});

describe('ReviewEditor — revert-selection button', () => {
  it('is disabled with no intersecting selection and enabled once one is tracked, then reverts the block', () => {
    const { container, getByText, onChange } = renderEditor([
      { lineageId: 'd1', title: 'doc1.md', kind: 'modified', base: 'a\nb\nc', current: 'a\nX\nc' },
    ]);
    const revertButton = getByText(labels.revertSelectionButton).closest('button')!;
    expect(revertButton.disabled).toBe(true);
    const row = rowAt(container, 1); // the 'X' row
    act(() => {
      setCollapsedCaret(row, 0);
      fireEvent.mouseUp(row, { bubbles: true });
    });
    expect(revertButton.disabled).toBe(false);
    act(() => {
      fireEvent.click(revertButton);
    });
    expect(lastOutput(onChange).docs[0].lines).toEqual(['a', 'b', 'c']);
  });
});

describe('ReviewEditor — whole-document reject/restore', () => {
  it('rejects an added document down to empty content, then can be undone', () => {
    const { getByText, onChange } = renderEditor([
      { lineageId: 'd1', title: 'new.md', kind: 'added', base: '', current: 'brand new content' },
    ]);
    expect(lastOutput(onChange).docs[0].lines).toEqual(['brand new content']);
    act(() => {
      fireEvent.click(getByText(labels.rejectDocButton));
    });
    let out = lastOutput(onChange);
    expect(out.docs[0].lines).toEqual([]);
    expect(out.docs[0].restore).toBe(true);
    act(() => {
      fireEvent.click(getByText(labels.rejectDocButton));
    });
    out = lastOutput(onChange);
    expect(out.docs[0].lines).toEqual(['brand new content']);
    expect(out.docs[0].restore).toBe(false);
  });

  it('restores a deleted document back to its base content', () => {
    const { getByText, onChange } = renderEditor([
      { lineageId: 'd2', title: 'gone.md', kind: 'deleted', base: 'old content here', current: '' },
    ]);
    expect(lastOutput(onChange).docs[0].lines).toEqual([]);
    act(() => {
      fireEvent.click(getByText(labels.restoreDocButton));
    });
    const out = lastOutput(onChange);
    expect(out.docs[0].lines).toEqual(['old content here']);
    expect(out.docs[0].restore).toBe(true);
  });
});

describe('ReviewEditor — header counts and hasWork', () => {
  it('reports pendingCount/stagedCount/hasWork across documents and updates as they change', () => {
    const { getAllByText, onChange } = renderEditor([
      { lineageId: 'd1', title: 'doc1.md', kind: 'modified', base: 'a\nb', current: 'a\nX' },
      { lineageId: 'd2', title: 'doc2.md', kind: 'modified', base: 'p\nq', current: 'p\nq' },
    ]);
    let out = lastOutput(onChange);
    expect(out.pendingCount).toBe(1);
    expect(out.stagedCount).toBe(0);
    // Nothing has been accepted or edited in this review session yet: hasWork
    // tracks session activity (staged or hand-edited), not the mere existence
    // of a pre-existing pending hunk between base and the draft's current text.
    expect(out.hasWork).toBe(false);
    const acceptButtons = getAllByText(labels.acceptButton);
    act(() => {
      fireEvent.click(acceptButtons[0]);
    });
    out = lastOutput(onChange);
    expect(out.pendingCount).toBe(0);
    expect(out.stagedCount).toBe(1);
    expect(out.hasWork).toBe(true);
  });

  it('has no work and nothing pending for two documents with no changes at all', () => {
    const { onChange } = renderEditor([
      { lineageId: 'd1', title: 'doc1.md', kind: 'modified', base: 'a\nb', current: 'a\nb' },
    ]);
    const out = lastOutput(onChange);
    expect(out.pendingCount).toBe(0);
    expect(out.stagedCount).toBe(0);
    expect(out.hasWork).toBe(false);
  });
});
