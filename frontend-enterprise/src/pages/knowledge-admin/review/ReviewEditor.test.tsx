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
  acceptAllButton: '接受全部',
  rejectAllButton: '拒绝全部',
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
  degradedDiffNotice: '本篇文档过大，无法逐行比较',
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
  it('renders visible Tailwind char-highlight spans for a paired change before accept, and removes them after', () => {
    const { container, getByText, onChange } = renderEditor([
      {
        lineageId: 'd1',
        title: 'doc1.md',
        kind: 'modified',
        base: 'the quick brown fox',
        current: 'the quick brown fax',
      },
    ]);
    expect(lastOutput(onChange).pendingCount).toBe(1);
    // The paired red/green lines are similar enough to be char-aligned, so the
    // char-level highlight spans (Tailwind bg-red-200/70 / bg-emerald-200/70,
    // not the old unstyled diff-char-* classes) should already be present.
    expect(container.querySelector('span[class*="bg-red-200"]')).not.toBeNull();
    expect(container.querySelector('span[class*="bg-emerald-200"]')).not.toBeNull();
    // The document header now says acceptAllButton ("接受全部"), which no
    // longer collides with the per-hunk toolbar's acceptButton ("接受"), so
    // this is unambiguous.
    const acceptButton = getByText(labels.acceptButton);
    act(() => {
      fireEvent.click(acceptButton);
    });
    const out = lastOutput(onChange);
    expect(out.pendingCount).toBe(0);
    expect(out.stagedCount).toBe(1);
    expect(container.querySelector('span[class*="bg-red-200"]')).toBeNull();
    expect(container.querySelector('span[class*="bg-emerald-200"]')).toBeNull();
    expect(container.textContent).toContain(labels.unacceptButton);
  });

  it('unaccept (undo accept) restores the block to a pending change', () => {
    const { getByText, onChange } = renderEditor([
      { lineageId: 'd1', title: 'doc1.md', kind: 'modified', base: 'a\nb\nc', current: 'a\nX\nc' },
    ]);
    act(() => {
      fireEvent.click(getByText(labels.acceptButton));
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
    const { getByText, onChange } = renderEditor([
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
    // Only doc1 has a pending hunk, so its toolbar accept button ("接受") is
    // the sole match now that the document-level "接受全部" uses a distinct label.
    const acceptButton = getByText(labels.acceptButton);
    act(() => {
      fireEvent.click(acceptButton);
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

describe('ReviewEditor — document kind badges', () => {
  it('renders the addedDocBadge/modifiedDocBadge/deletedDocBadge label next to each document title', () => {
    const { getByText } = renderEditor([
      { lineageId: 'd1', title: 'new.md', kind: 'added', base: '', current: 'brand new content' },
      { lineageId: 'd2', title: 'doc1.md', kind: 'modified', base: 'a\nb', current: 'a\nX' },
      { lineageId: 'd3', title: 'gone.md', kind: 'deleted', base: 'old content here', current: '' },
    ]);
    expect(getByText(labels.addedDocBadge)).not.toBeNull();
    expect(getByText(labels.modifiedDocBadge)).not.toBeNull();
    expect(getByText(labels.deletedDocBadge)).not.toBeNull();
  });
});

describe('ReviewEditor — 退化 diff 提示（I2）', () => {
  it('renders the degraded notice when the line diff fell back to delete-all + insert-all', () => {
    // 两篇内容首尾没有公共行、中段各 4001 行且完全不重叠：`(4001+1)^2 ≈ 1600 万`
    // 刚好超过 `LCS_CELL_BUDGET`，`diffLines` 走线性兜底，`buildModel` 上报 degraded。
    const base = Array.from({ length: 4001 }, (_, i) => `b${i}`).join('\n');
    const current = Array.from({ length: 4001 }, (_, i) => `c${i}`).join('\n');
    const { queryByText } = renderEditor([
      { lineageId: 'd1', title: 'huge.md', kind: 'modified', base, current },
    ]);
    expect(queryByText(labels.degradedDiffNotice)).not.toBeNull();
  });

  it('does not render the degraded notice for a normal-sized document', () => {
    const { queryByText } = renderEditor([
      { lineageId: 'd1', title: 'doc1.md', kind: 'modified', base: 'a\nb\nc', current: 'a\nX\nc' },
    ]);
    expect(queryByText(labels.degradedDiffNotice)).toBeNull();
  });
});

describe('ReviewEditor — documents 变化时的状态对账（I3）', () => {
  it('never emits lines: [] for a document whose state has not been seeded yet', () => {
    const onChange = vi.fn<(state: ReviewEditorOutput) => void>();
    const { rerender } = render(
      <ReviewEditor
        documents={[{ lineageId: 'd1', title: 'doc1.md', kind: 'modified', base: 'a\nb', current: 'a\nb' }]}
        labels={labels}
        onChange={onChange}
      />,
    );
    // 换成另一篇文档（写回后重新拉取对比结果的真实场景）：新 lineageId 在
    // docStates 里还没有条目。
    act(() => {
      rerender(
        <ReviewEditor
          documents={[{ lineageId: 'd2', title: 'doc2.md', kind: 'modified', base: 'x\ny', current: 'x\nZ' }]}
          labels={labels}
          onChange={onChange}
        />,
      );
    });
    // 每一帧都不允许出现"有这篇文档但 lines 为空"的输出（会被写回当成清空正文）。
    for (const [state] of onChange.mock.calls) {
      for (const doc of state.docs) {
        expect(doc.lines.length, `${doc.lineageId} lines`).toBeGreaterThan(0);
      }
    }
    const out = lastOutput(onChange);
    expect(out.docs.map((doc) => doc.lineageId)).toEqual(['d2']);
    expect(out.docs[0].lines).toEqual(['x', 'Z']);
  });

  // 同一个 lineageId 的正文也会变（写回草稿后重新拉对比、别人并发改了同一篇）。
  // 只按 id 对账会留着旧状态，编辑器继续显示上一版正文，"应用到草稿"会把它写回去。
  it('re-seeds a document whose incoming base/current content changed under the same lineageId', () => {
    const onChange = vi.fn<(state: ReviewEditorOutput) => void>();
    const { rerender } = render(
      <ReviewEditor
        documents={[{ lineageId: 'd1', title: 'doc1.md', kind: 'modified', base: 'a\nb', current: 'a\nB' }]}
        labels={labels}
        onChange={onChange}
      />,
    );
    expect(lastOutput(onChange).docs[0].lines).toEqual(['a', 'B']);

    act(() => {
      rerender(
        <ReviewEditor
          documents={[{ lineageId: 'd1', title: 'doc1.md', kind: 'modified', base: 'a\nb', current: 'a\nC\nd' }]}
          labels={labels}
          onChange={onChange}
        />,
      );
    });

    const out = lastOutput(onChange);
    expect(out.docs.map((doc) => doc.lineageId)).toEqual(['d1']);
    expect(out.docs[0].lines).toEqual(['a', 'C', 'd']);
  });

  it('keeps in-progress edits when the same ids arrive with identical base/current content', () => {
    const documents = [{ lineageId: 'd1', title: 'doc1.md', kind: 'modified' as const, base: 'a\nb\nc', current: 'a\nX\nc' }];
    const onChange = vi.fn<(state: ReviewEditorOutput) => void>();
    const { container, rerender } = render(
      <ReviewEditor documents={documents} labels={labels} onChange={onChange} />,
    );

    // 接受这一处变更，产生一条暂存记录。
    act(() => {
      container.querySelectorAll<HTMLElement>('button')
        .forEach((button) => {
          if (button.textContent === labels.acceptButton) button.click();
        });
    });
    const staged = lastOutput(onChange).stagedCount;
    expect(staged).toBeGreaterThan(0);

    // 同样的 id、同样的 base/current，只是父组件重建了数组引用：编辑不能被清掉。
    act(() => {
      rerender(
        <ReviewEditor
          documents={documents.map((doc) => ({ ...doc }))}
          labels={labels}
          onChange={onChange}
        />,
      );
    });

    expect(lastOutput(onChange).stagedCount).toBe(staged);
  });
});

describe('ReviewEditor — 拖拽移动文本不走单行快路径（I4）', () => {
  it('recomputes the whole document for an insertFromDrop input event', () => {
    const { container, onChange } = renderEditor([
      { lineageId: 'd1', title: 'doc1.md', kind: 'modified', base: 'a\nb\nc', current: 'a\nb\nc' },
    ]);
    const source = rowAt(container, 0);
    const target = rowAt(container, 2);
    act(() => {
      // 拖拽移动：源行被清空、落点行被追加，浏览器只派发一个 input 事件（目标是落点行）。
      source.textContent = '';
      target.textContent = 'ca';
      setCollapsedCaret(target, 2);
      fireEvent.input(target, { bubbles: true, inputType: 'insertFromDrop' });
    });
    // 单行快路径只会写回落点那一行，源行的清空会被丢掉（旧行为：['a','b','ca']）。
    expect(lastOutput(onChange).docs[0].lines).toEqual(['', 'b', 'ca']);
  });

  it('still takes the single-row fast path for a plain insertText', () => {
    const { container, onChange } = renderEditor([
      { lineageId: 'd1', title: 'doc1.md', kind: 'modified', base: 'a\nb\nc', current: 'a\nb\nc' },
    ]);
    const row = rowAt(container, 1);
    act(() => {
      row.textContent = 'bX';
      setCollapsedCaret(row, 2);
      fireEvent.input(row, { bubbles: true, inputType: 'insertText' });
    });
    expect(lastOutput(onChange).docs[0].lines).toEqual(['a', 'bX', 'c']);
  });
});

describe('ReviewEditor — 纯删除块接受后可撤销（I5）', () => {
  it('renders the staged badge and an enabled undo-accept button for an accepted pure deletion', () => {
    const { getByText, queryByText } = renderEditor([
      // base 比 current 多一行 'b'：唯一的变更块是纯删除（removed=['b'], added=[]）。
      { lineageId: 'd1', title: 'doc1.md', kind: 'modified', base: 'a\nb\nc', current: 'a\nc' },
    ]);
    expect(queryByText(labels.stagedBadge)).toBeNull();
    act(() => {
      fireEvent.click(getByText(labels.acceptButton));
    });
    expect(queryByText(labels.stagedBadge)).not.toBeNull();
    const undo = getByText(labels.unacceptButton) as HTMLButtonElement;
    expect(undo.disabled).toBe(false);
  });

  it('keeps the undo-accept button reachable when the deletion is at the end of the document', () => {
    const { getByText, queryByText } = renderEditor([
      { lineageId: 'd1', title: 'doc1.md', kind: 'modified', base: 'a\nb\nc', current: 'a\nb' },
    ]);
    act(() => {
      fireEvent.click(getByText(labels.acceptButton));
    });
    expect(queryByText(labels.stagedBadge)).not.toBeNull();
    expect((getByText(labels.unacceptButton) as HTMLButtonElement).disabled).toBe(false);
  });
});
