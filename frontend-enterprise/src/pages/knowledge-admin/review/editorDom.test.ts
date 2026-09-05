/**
 * editorDom.ts 单元测试。
 *
 * 纯逻辑部分（splitLineAt/mergeWithPrevious/mergeWithNext/deleteRange/
 * insertTextAtRange）不依赖 DOM，直接对 `lines: string[]` 做断言。
 * DOM 相关部分（readAllLines/getCaretPosition/setCaretPosition/
 * getSelectionRange）用 jsdom 构造真实节点树与 Range/Selection 验证；
 * jsdom 对 Selection/Range 的支持有限，行为差异记录在实现文件顶部注释与
 * 任务报告中。
 */
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  deleteRange,
  getCaretPosition,
  getSelectionRange,
  insertTextAtRange,
  mergeWithNext,
  mergeWithPrevious,
  readAllLines,
  setCaretPosition,
  splitLineAt,
} from './editorDom';

describe('splitLineAt (Enter)', () => {
  it('splits a line into two at the given offset', () => {
    const result = splitLineAt(['hello world', 'b'], 0, 5);
    expect(result.lines).toEqual(['hello', ' world', 'b']);
    expect(result.caretLi).toBe(1);
    expect(result.caretOffset).toBe(0);
  });

  it('splits at offset 0 leaving an empty first line', () => {
    const result = splitLineAt(['abc'], 0, 0);
    expect(result.lines).toEqual(['', 'abc']);
    expect(result.caretLi).toBe(1);
    expect(result.caretOffset).toBe(0);
  });

  it('splits at end-of-line leaving an empty second line', () => {
    const result = splitLineAt(['abc'], 0, 3);
    expect(result.lines).toEqual(['abc', '']);
    expect(result.caretLi).toBe(1);
    expect(result.caretOffset).toBe(0);
  });
});

describe('mergeWithPrevious (Backspace at line start)', () => {
  it('merges the current line into the previous one', () => {
    const result = mergeWithPrevious(['hello', 'world'], 1);
    expect(result).not.toBeNull();
    expect(result!.lines).toEqual(['helloworld']);
    expect(result!.caretLi).toBe(0);
    expect(result!.caretOffset).toBe(5);
  });

  it('returns null when already on the first line', () => {
    expect(mergeWithPrevious(['a', 'b'], 0)).toBeNull();
  });
});

describe('mergeWithNext (Delete at line end)', () => {
  it('merges the next line into the current one', () => {
    const result = mergeWithNext(['hello', 'world'], 0);
    expect(result).not.toBeNull();
    expect(result!.lines).toEqual(['helloworld']);
    expect(result!.caretLi).toBe(0);
    expect(result!.caretOffset).toBe(5);
  });

  it('returns null when already on the last line', () => {
    expect(mergeWithNext(['a', 'b'], 1)).toBeNull();
  });
});

describe('deleteRange', () => {
  it('deletes within a single line', () => {
    const result = deleteRange(['hello world'], 0, 5, 0, 11);
    expect(result.lines).toEqual(['hello']);
    expect(result.caretLi).toBe(0);
    expect(result.caretOffset).toBe(5);
  });

  it('deletes across multiple lines, joining the remaining prefix and suffix', () => {
    const result = deleteRange(['abcdef', 'ghijkl', 'mnopqr'], 0, 2, 2, 4);
    expect(result.lines).toEqual(['abqr']);
    expect(result.caretLi).toBe(0);
    expect(result.caretOffset).toBe(2);
  });

  it('normalizes a reversed range (end before start)', () => {
    const result = deleteRange(['abcdef'], 0, 4, 0, 1);
    expect(result.lines).toEqual(['aef']);
    expect(result.caretLi).toBe(0);
    expect(result.caretOffset).toBe(1);
  });
});

describe('insertTextAtRange', () => {
  it('inserts plain text at a collapsed position', () => {
    const result = insertTextAtRange(['hello world'], 0, 5, 0, 5, 'XX');
    expect(result.lines).toEqual(['helloXX world']);
    expect(result.caretLi).toBe(0);
    expect(result.caretOffset).toBe(7);
  });

  it('replaces a selection with typed text', () => {
    const result = insertTextAtRange(['hello world'], 0, 0, 0, 5, 'goodbye');
    expect(result.lines).toEqual(['goodbye world']);
    expect(result.caretOffset).toBe(7);
  });

  it('pastes multi-line text, splitting into several lines', () => {
    const result = insertTextAtRange(['abc', 'def'], 0, 1, 0, 1, 'X\nY\nZ');
    expect(result.lines).toEqual(['aX', 'Y', 'Zbc', 'def']);
    expect(result.caretLi).toBe(2);
    expect(result.caretOffset).toBe(1);
  });

  it('replaces a cross-line selection with pasted multi-line text', () => {
    const result = insertTextAtRange(['abcdef', 'ghijkl', 'mnopqr'], 0, 2, 2, 4, 'X\nY');
    expect(result.lines).toEqual(['abX', 'Yqr']);
    expect(result.caretLi).toBe(1);
    expect(result.caretOffset).toBe(1);
  });
});

function buildDoc(lines: string[]) {
  document.body.innerHTML = '';
  const container = document.createElement('div');
  lines.forEach((text, li) => {
    const row = document.createElement('div');
    row.className = 'er';
    const et = document.createElement('div');
    et.className = 'et';
    et.dataset.li = String(li);
    et.textContent = text;
    row.appendChild(et);
    container.appendChild(row);
  });
  document.body.appendChild(container);
  return container;
}

describe('readAllLines', () => {
  it('reads text content from every [data-li] row in document order', () => {
    const container = buildDoc(['first', 'second', 'third']);
    expect(readAllLines(container)).toEqual(['first', 'second', 'third']);
  });

  it('returns an empty array when there are no editable rows', () => {
    const container = buildDoc([]);
    expect(readAllLines(container)).toEqual([]);
  });
});

describe('caret position round-trip (jsdom Selection/Range)', () => {
  it('setCaretPosition then getCaretPosition returns the same li/offset for plain text', () => {
    const container = buildDoc(['hello', 'world']);
    setCaretPosition(container, 1, 3);
    const pos = getCaretPosition(container);
    expect(pos).toEqual({ li: 1, offset: 3 });
  });

  it('clamps offset to line length when out of range', () => {
    const container = buildDoc(['hi']);
    setCaretPosition(container, 0, 999);
    const pos = getCaretPosition(container);
    expect(pos).toEqual({ li: 0, offset: 2 });
  });
});

describe('getSelectionRange (cross-row selection mapping)', () => {
  it('maps a collapsed selection to identical start/end', () => {
    const container = buildDoc(['hello', 'world']);
    setCaretPosition(container, 0, 2);
    const range = getSelectionRange(container);
    expect(range).toEqual({ startLi: 0, startOffset: 2, endLi: 0, endOffset: 2 });
  });

  it('maps a selection spanning two rows', () => {
    const container = buildDoc(['hello', 'world']);
    const rows = container.querySelectorAll<HTMLElement>('[data-li]');
    const domRange = document.createRange();
    domRange.setStart(rows[0].firstChild!, 2);
    domRange.setEnd(rows[1].firstChild!, 3);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(domRange);
    const range = getSelectionRange(container);
    expect(range).toEqual({ startLi: 0, startOffset: 2, endLi: 1, endOffset: 3 });
  });
});
