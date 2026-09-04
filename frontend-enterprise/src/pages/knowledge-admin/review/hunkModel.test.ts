/**
 * hunkModel.ts 单元测试：rows/hunks 构建（insertAt/bs）、相似度配对
 * alignHunk、字符级 charOps/innerHtml、未配对删除行插回位置 restorePos。
 * 纯函数测试，不涉及 DOM。
 */
import { describe, expect, it } from 'vitest';
import {
  alignHunk,
  buildModel,
  charOps,
  innerHtml,
  restorePos,
  similarityRatio,
  type Hunk,
} from './hunkModel';

describe('buildModel — rows', () => {
  it('returns no rows and no hunks for two empty documents', () => {
    const { rows, hunks } = buildModel([], []);
    expect(rows).toEqual([]);
    expect(hunks).toEqual([]);
  });

  it('marks every line as equal when base and current are identical', () => {
    const { rows, hunks } = buildModel(['a', 'b'], ['a', 'b']);
    expect(hunks).toEqual([]);
    expect(rows).toEqual([
      { t: '=', text: 'a', li: 0, bi: 0, h: null, ri: null, ai: null },
      { t: '=', text: 'b', li: 1, bi: 1, h: null, ri: null, ai: null },
    ]);
  });

  it('groups a single-line replace into one hunk with bs and insertAt', () => {
    const { rows, hunks } = buildModel(['a', 'b', 'c'], ['a', 'X', 'c']);
    expect(hunks).toEqual([
      { id: 0, bs: 1, insertAt: 1, removed: ['b'], added: ['X'] },
    ]);
    expect(rows).toEqual([
      { t: '=', text: 'a', li: 0, bi: 0, h: null, ri: null, ai: null },
      { t: '-', text: 'b', li: null, bi: 1, h: 0, ri: 0, ai: null },
      { t: '+', text: 'X', li: 1, bi: null, h: 0, ri: null, ai: 0 },
      { t: '=', text: 'c', li: 2, bi: 2, h: null, ri: null, ai: null },
    ]);
  });

  it('gives a pure insertion hunk bs equal to the following context base index', () => {
    const { hunks } = buildModel(['a', 'b'], ['a', 'X', 'b']);
    expect(hunks).toEqual([{ id: 0, bs: 1, insertAt: 1, removed: [], added: ['X'] }]);
  });

  it('gives a pure insertion at end-of-document bs equal to base length', () => {
    const { hunks } = buildModel(['a'], ['a', 'X']);
    expect(hunks).toEqual([{ id: 0, bs: 1, insertAt: 1, removed: [], added: ['X'] }]);
  });

  it('gives a pure deletion hunk insertAt equal to the following context current index', () => {
    const { hunks } = buildModel(['a', 'b', 'c'], ['a', 'c']);
    expect(hunks).toEqual([{ id: 0, bs: 1, insertAt: 1, removed: ['b'], added: [] }]);
  });

  it('gives a pure deletion at end-of-document insertAt equal to current length', () => {
    const { hunks } = buildModel(['a', 'b'], ['a']);
    expect(hunks).toEqual([{ id: 0, bs: 1, insertAt: 1, removed: ['b'], added: [] }]);
  });

  it('treats an entirely different document as one big hunk', () => {
    const { hunks, rows } = buildModel(['a', 'b'], ['p', 'q']);
    expect(hunks).toEqual([{ id: 0, bs: 0, insertAt: 0, removed: ['a', 'b'], added: ['p', 'q'] }]);
    expect(rows).toEqual([
      { t: '-', text: 'a', li: null, bi: 0, h: 0, ri: 0, ai: null },
      { t: '-', text: 'b', li: null, bi: 1, h: 0, ri: 1, ai: null },
      { t: '+', text: 'p', li: 0, bi: null, h: 0, ri: null, ai: 0 },
      { t: '+', text: 'q', li: 1, bi: null, h: 0, ri: null, ai: 1 },
    ]);
  });

  it('assigns increasing hunk ids for multiple separate change blocks', () => {
    const { hunks } = buildModel(['a', 'b', 'c', 'd', 'e'], ['X', 'b', 'c', 'Y', 'e']);
    expect(hunks.map((h) => h.id)).toEqual([0, 1]);
    expect(hunks[0]).toEqual({ id: 0, bs: 0, insertAt: 0, removed: ['a'], added: ['X'] });
    expect(hunks[1]).toEqual({ id: 1, bs: 3, insertAt: 3, removed: ['d'], added: ['Y'] });
  });
});

describe('similarityRatio', () => {
  it('returns 1 for two empty strings', () => {
    expect(similarityRatio('', '')).toBe(1);
  });

  it('returns 1 for identical strings', () => {
    expect(similarityRatio('hello world', 'hello world')).toBe(1);
  });

  it('returns 0 for completely disjoint strings', () => {
    expect(similarityRatio('abc', 'xyz')).toBe(0);
  });

  it('returns a mid-range ratio for partially similar strings', () => {
    // 'hello' vs 'hallo': LCS = h,l,l,o = 4 chars, ratio = 2*4/(5+5) = 0.8
    expect(similarityRatio('hello', 'hallo')).toBeCloseTo(0.8);
  });
});

describe('alignHunk', () => {
  it('returns no pairs when the hunk has only removed lines', () => {
    const hunk: Hunk = { id: 0, bs: 0, insertAt: 0, removed: ['alpha', 'beta'], added: [] };
    expect(alignHunk(hunk)).toEqual([]);
  });

  it('returns no pairs when the hunk has only added lines', () => {
    const hunk: Hunk = { id: 0, bs: 0, insertAt: 0, removed: [], added: ['alpha', 'beta'] };
    expect(alignHunk(hunk)).toEqual([]);
  });

  it('pairs a single similar removed/added line', () => {
    const hunk: Hunk = {
      id: 0,
      bs: 0,
      insertAt: 0,
      removed: ['the quick brown fox'],
      added: ['the quick brown fax'],
    };
    const pairs = alignHunk(hunk);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].ri).toBe(0);
    expect(pairs[0].ai).toBe(0);
    expect(pairs[0].ratio).toBeGreaterThanOrEqual(0.5);
  });

  it('does not pair lines below the 0.5 similarity threshold', () => {
    const hunk: Hunk = { id: 0, bs: 0, insertAt: 0, removed: ['completely different'], added: ['xyz'] };
    expect(alignHunk(hunk)).toEqual([]);
  });

  it('pairs multiple lines in order, skipping unrelated ones', () => {
    // removed[0] pairs with added[0] (near-identical); removed[1] is unrelated to
    // anything and stays unpaired; added[1] pairs with removed[2].
    const hunk: Hunk = {
      id: 0,
      bs: 0,
      insertAt: 0,
      removed: ['alpha line one', '9999999999', 'gamma line three'],
      added: ['alpha line ONE', 'gamma line threee'],
    };
    const pairs = alignHunk(hunk);
    expect(pairs).toEqual([
      { ri: 0, ai: 0, ratio: expect.any(Number) },
      { ri: 2, ai: 1, ratio: expect.any(Number) },
    ]);
    expect(pairs[0].ratio).toBeGreaterThanOrEqual(0.5);
    expect(pairs[1].ratio).toBeGreaterThanOrEqual(0.5);
  });
});

describe('charOps', () => {
  it('returns a single equal run for identical strings', () => {
    expect(charOps('abc', 'abc')).toEqual([{ type: '=', text: 'abc' }]);
  });

  it('returns a single delete run then a single insert run for disjoint strings', () => {
    expect(charOps('abc', 'xyz')).toEqual([
      { type: '-', text: 'abc' },
      { type: '+', text: 'xyz' },
    ]);
  });

  it('isolates a middle change and merges surrounding equal runs', () => {
    expect(charOps('the fox jumps', 'the cat jumps')).toEqual([
      { type: '=', text: 'the ' },
      { type: '-', text: 'fox' },
      { type: '+', text: 'cat' },
      { type: '=', text: ' jumps' },
    ]);
  });

  it('handles an empty base string as all-insert', () => {
    expect(charOps('', 'abc')).toEqual([{ type: '+', text: 'abc' }]);
  });

  it('handles an empty current string as all-delete', () => {
    expect(charOps('abc', '')).toEqual([{ type: '-', text: 'abc' }]);
  });

  it('handles two empty strings as no ops', () => {
    expect(charOps('', '')).toEqual([]);
  });
});

describe('innerHtml', () => {
  it('renders the delete side with del spans and drops insert-only runs', () => {
    const ops = charOps('the fox jumps', 'the cat jumps');
    const html = innerHtml(ops, '-');
    expect(html).toBe('the <span class="diff-char-del">fox</span> jumps');
  });

  it('renders the add side with add spans and drops delete-only runs', () => {
    const ops = charOps('the fox jumps', 'the cat jumps');
    const html = innerHtml(ops, '+');
    expect(html).toBe('the <span class="diff-char-add">cat</span> jumps');
  });

  it('escapes HTML-sensitive characters in the rendered text', () => {
    const ops = charOps('<a> & b', '<a> & c');
    expect(innerHtml(ops, '-')).toContain('&lt;a&gt; &amp; <span class="diff-char-del">b</span>');
    expect(innerHtml(ops, '+')).toContain('&lt;a&gt; &amp; <span class="diff-char-add">c</span>');
  });
});

describe('restorePos', () => {
  it('inserts at hunk.insertAt when the hunk has no alignment pairs at all', () => {
    const hunk: Hunk = { id: 0, bs: 0, insertAt: 5, removed: ['alpha'], added: ['xyz'] };
    expect(restorePos(hunk, 0, [])).toBe(5);
  });

  it('inserts right after the previous paired added line', () => {
    const hunk: Hunk = {
      id: 0,
      bs: 0,
      insertAt: 10,
      removed: ['r0', 'r1-unpaired'],
      added: ['a0'],
    };
    const pairs = [{ ri: 0, ai: 0, ratio: 0.9 }];
    // r1-unpaired sits after r0 (paired with a0 at absolute index insertAt+0);
    // restore position should be right after that: insertAt + 0 + 1.
    expect(restorePos(hunk, 1, pairs)).toBe(11);
  });

  it('inserts right before the next paired added line when there is no previous pair', () => {
    const hunk: Hunk = {
      id: 0,
      bs: 0,
      insertAt: 10,
      removed: ['r0-unpaired', 'r1'],
      added: ['a0'],
    };
    const pairs = [{ ri: 1, ai: 0, ratio: 0.9 }];
    expect(restorePos(hunk, 0, pairs)).toBe(10);
  });

  it('falls back to insertAt when the target removed index is itself paired (no-op case)', () => {
    const hunk: Hunk = { id: 0, bs: 0, insertAt: 3, removed: ['r0'], added: ['a0'] };
    const pairs = [{ ri: 0, ai: 0, ratio: 0.9 }];
    expect(restorePos(hunk, 0, pairs)).toBe(3);
  });
});
