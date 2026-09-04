/**
 * lineDiff.ts 单元测试：覆盖 LCS 行 diff 的核心场景与边界（空输入、相同输入、
 * 全变输入、splitLines 的空字符串特例）。纯函数测试，不涉及 DOM。
 */
import { describe, expect, it } from 'vitest';
import { diffLines, splitLines } from './lineDiff';

describe('splitLines', () => {
  it('returns an empty array for an empty string', () => {
    expect(splitLines('')).toEqual([]);
  });

  it('splits a single-line string into one element', () => {
    expect(splitLines('hello')).toEqual(['hello']);
  });

  it('splits multi-line text on \\n', () => {
    expect(splitLines('a\nb\nc')).toEqual(['a', 'b', 'c']);
  });

  it('preserves a trailing empty line when the text ends with \\n', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b', '']);
  });
});

describe('diffLines', () => {
  it('returns an empty op list for two empty inputs', () => {
    expect(diffLines([], [])).toEqual([]);
  });

  it('produces all-insert ops when base is empty', () => {
    const ops = diffLines([], ['a', 'b']);
    expect(ops).toEqual([
      { type: '+', text: 'a', baseIndex: null, currentIndex: 0 },
      { type: '+', text: 'b', baseIndex: null, currentIndex: 1 },
    ]);
  });

  it('produces all-delete ops when current is empty', () => {
    const ops = diffLines(['a', 'b'], []);
    expect(ops).toEqual([
      { type: '-', text: 'a', baseIndex: 0, currentIndex: null },
      { type: '-', text: 'b', baseIndex: 1, currentIndex: null },
    ]);
  });

  it('produces all-equal ops for identical inputs', () => {
    const lines = ['a', 'b', 'c'];
    const ops = diffLines(lines, [...lines]);
    expect(ops).toEqual([
      { type: '=', text: 'a', baseIndex: 0, currentIndex: 0 },
      { type: '=', text: 'b', baseIndex: 1, currentIndex: 1 },
      { type: '=', text: 'c', baseIndex: 2, currentIndex: 2 },
    ]);
  });

  it('emits deletions before insertions for a fully-changed block (no common subsequence)', () => {
    const ops = diffLines(['x', 'y'], ['p', 'q']);
    expect(ops).toEqual([
      { type: '-', text: 'x', baseIndex: 0, currentIndex: null },
      { type: '-', text: 'y', baseIndex: 1, currentIndex: null },
      { type: '+', text: 'p', baseIndex: null, currentIndex: 0 },
      { type: '+', text: 'q', baseIndex: null, currentIndex: 1 },
    ]);
  });

  it('finds the longest common subsequence around a modified middle section', () => {
    // base:    a b c d e
    // current: a b X d e
    const ops = diffLines(['a', 'b', 'c', 'd', 'e'], ['a', 'b', 'X', 'd', 'e']);
    expect(ops).toEqual([
      { type: '=', text: 'a', baseIndex: 0, currentIndex: 0 },
      { type: '=', text: 'b', baseIndex: 1, currentIndex: 1 },
      { type: '-', text: 'c', baseIndex: 2, currentIndex: null },
      { type: '+', text: 'X', baseIndex: null, currentIndex: 2 },
      { type: '=', text: 'd', baseIndex: 3, currentIndex: 3 },
      { type: '=', text: 'e', baseIndex: 4, currentIndex: 4 },
    ]);
  });

  it('handles interleaved insert and delete around a shared anchor', () => {
    // base:    a b c
    // current: a X c Y
    const ops = diffLines(['a', 'b', 'c'], ['a', 'X', 'c', 'Y']);
    expect(ops).toEqual([
      { type: '=', text: 'a', baseIndex: 0, currentIndex: 0 },
      { type: '-', text: 'b', baseIndex: 1, currentIndex: null },
      { type: '+', text: 'X', baseIndex: null, currentIndex: 1 },
      { type: '=', text: 'c', baseIndex: 2, currentIndex: 2 },
      { type: '+', text: 'Y', baseIndex: null, currentIndex: 3 },
    ]);
  });

  it('round-trips: replaying ops reconstructs both base and current sequences', () => {
    const base = ['line1', 'line2', 'line3', 'line4'];
    const current = ['line1', 'lineX', 'line3', 'line5', 'line4'];
    const ops = diffLines(base, current);
    const rebuiltBase = ops.filter((o) => o.type !== '+').map((o) => o.text);
    const rebuiltCurrent = ops.filter((o) => o.type !== '-').map((o) => o.text);
    expect(rebuiltBase).toEqual(base);
    expect(rebuiltCurrent).toEqual(current);
  });
});
