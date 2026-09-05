/**
 * lineDiff.ts 单元测试：覆盖 LCS 行 diff 的核心场景与边界（空输入、相同输入、
 * 全变输入、splitLines 的空字符串特例）。纯函数测试，不涉及 DOM。
 */
import { describe, expect, it } from 'vitest';
import { diffLines, LCS_CELL_BUDGET, splitLines } from './lineDiff';

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

// T079 修复回合 1（Important finding #1）：diffLines 重写后引入了「先裁剪首尾公共
// 行，再只对中段建 DP 表」的前后缀裁剪优化（见 lineDiff.ts 顶部注释）。这组用例
// 专门覆盖裁剪逻辑本身与「裁剪 + 中段 LCS 回溯」的交界处，防止未来改动悄悄破坏
// 裁剪边界或裁剪后中段的相同得分优先删除、再插入的回溯语义。
describe('diffLines — prefix/suffix trim regression (T079 fix round 1)', () => {
  it('trims a single common prefix line, leaving one trailing delete (base longer)', () => {
    // base: a a / target: a  → prefix trims the first "a"; the remaining base "a"
    // has nothing to match in target, so it is a trailing delete.
    const ops = diffLines(['a', 'a'], ['a']);
    expect(ops).toEqual([
      { type: '=', text: 'a', baseIndex: 0, currentIndex: 0 },
      { type: '-', text: 'a', baseIndex: 1, currentIndex: null },
    ]);
  });

  it('mirrors the above: trims a single common prefix line, leaving one trailing insert (target longer)', () => {
    // base: a / target: a a  → prefix trims the shared "a"; the extra target "a"
    // has nothing to match in base, so it is a trailing insert.
    const ops = diffLines(['a'], ['a', 'a']);
    expect(ops).toEqual([
      { type: '=', text: 'a', baseIndex: 0, currentIndex: 0 },
      { type: '+', text: 'a', baseIndex: null, currentIndex: 1 },
    ]);
  });

  it('trims a common prefix AND a common suffix, then applies delete-before-insert tie-breaking on a fully-changed middle', () => {
    // base:    pre x y post
    // current: pre p q post
    // prefix trims "pre", suffix trims "post"; the middle ["x","y"] vs ["p","q"]
    // shares no lines at all, so the LCS tie-break must emit both deletes before
    // either insert (same rule as the fully-changed-block case above), even though
    // this time the middle sits between two trimmed anchors rather than at the
    // very start/end of the whole sequence.
    const ops = diffLines(['pre', 'x', 'y', 'post'], ['pre', 'p', 'q', 'post']);
    expect(ops).toEqual([
      { type: '=', text: 'pre', baseIndex: 0, currentIndex: 0 },
      { type: '-', text: 'x', baseIndex: 1, currentIndex: null },
      { type: '-', text: 'y', baseIndex: 2, currentIndex: null },
      { type: '+', text: 'p', baseIndex: null, currentIndex: 1 },
      { type: '+', text: 'q', baseIndex: null, currentIndex: 2 },
      { type: '=', text: 'post', baseIndex: 3, currentIndex: 3 },
    ]);
  });

  it('handles empty base against a non-empty target (no prefix/suffix to trim)', () => {
    expect(diffLines([], ['only'])).toEqual([{ type: '+', text: 'only', baseIndex: null, currentIndex: 0 }]);
  });

  it('handles a non-empty base against an empty target (no prefix/suffix to trim)', () => {
    expect(diffLines(['only'], [])).toEqual([{ type: '-', text: 'only', baseIndex: 0, currentIndex: null }]);
  });

  it('handles identical inputs as a pure common-prefix trim with no middle section', () => {
    const lines = ['a', 'b', 'c', 'd'];
    expect(diffLines(lines, [...lines])).toEqual([
      { type: '=', text: 'a', baseIndex: 0, currentIndex: 0 },
      { type: '=', text: 'b', baseIndex: 1, currentIndex: 1 },
      { type: '=', text: 'c', baseIndex: 2, currentIndex: 2 },
      { type: '=', text: 'd', baseIndex: 3, currentIndex: 3 },
    ]);
  });

  it('trims a common prefix only, with no shared suffix (trailing content fully replaced)', () => {
    // base:    shared old1 old2
    // current: shared new1
    const ops = diffLines(['shared', 'old1', 'old2'], ['shared', 'new1']);
    expect(ops).toEqual([
      { type: '=', text: 'shared', baseIndex: 0, currentIndex: 0 },
      { type: '-', text: 'old1', baseIndex: 1, currentIndex: null },
      { type: '-', text: 'old2', baseIndex: 2, currentIndex: null },
      { type: '+', text: 'new1', baseIndex: null, currentIndex: 1 },
    ]);
  });

  it('trims a common suffix only, with no shared prefix (leading content fully replaced)', () => {
    // base:    old1 old2 shared
    // current: new1 shared
    const ops = diffLines(['old1', 'old2', 'shared'], ['new1', 'shared']);
    expect(ops).toEqual([
      { type: '-', text: 'old1', baseIndex: 0, currentIndex: null },
      { type: '-', text: 'old2', baseIndex: 1, currentIndex: null },
      { type: '+', text: 'new1', baseIndex: null, currentIndex: 0 },
      { type: '=', text: 'shared', baseIndex: 2, currentIndex: 1 },
    ]);
  });
});

// T079 修复回合 1（Important finding #2）：buildLcsTable 按 `(n+1)x(m+1)` 分配
// Int32Array，diff 端点的 max_lines 上限是 50,000，未加防护时极端输入可能分配出
// 数十亿 cell 的表。这组用例通过给 diffLines 传入一个很小的 cellBudget 参数
// （而不是真的构造巨型输入）来触发退化路径，验证：(a) 退化路径确实会被激活且
// 产出合法的 diff op 序列；(b) 退化路径与默认（不设预算/预算充足）路径的输出
// 在有真实公共子序列的中段上是不同的——证明这不是死代码。
describe('diffLines — LCS cell budget guard (T079 fix round 1, Important finding #2)', () => {
  it('exposes a documented, positive default cell budget', () => {
    expect(LCS_CELL_BUDGET).toBeGreaterThan(0);
  });

  it('falls back to delete-all + insert-all on the middle section when the cell budget is forced low, without allocating a huge table', () => {
    // base:    p a b s
    // current: p b a s
    // Default (unbounded) behaviour keeps "b" as an "=" row (see the sibling
    // assertion below) because the middle ["a","b"] vs ["b","a"] does share a
    // line. Forcing a tiny cellBudget must skip that LCS search entirely and
    // instead mark the whole trimmed middle as delete-all-then-insert-all.
    const base = ['p', 'a', 'b', 's'];
    const current = ['p', 'b', 'a', 's'];

    const fallbackOps = diffLines(base, current, 1);
    expect(fallbackOps).toEqual([
      { type: '=', text: 'p', baseIndex: 0, currentIndex: 0 },
      { type: '-', text: 'a', baseIndex: 1, currentIndex: null },
      { type: '-', text: 'b', baseIndex: 2, currentIndex: null },
      { type: '+', text: 'b', baseIndex: null, currentIndex: 1 },
      { type: '+', text: 'a', baseIndex: null, currentIndex: 2 },
      { type: '=', text: 's', baseIndex: 3, currentIndex: 3 },
    ]);

    const defaultOps = diffLines(base, current);
    expect(defaultOps).toEqual([
      { type: '=', text: 'p', baseIndex: 0, currentIndex: 0 },
      { type: '-', text: 'a', baseIndex: 1, currentIndex: null },
      { type: '=', text: 'b', baseIndex: 2, currentIndex: 1 },
      { type: '+', text: 'a', baseIndex: null, currentIndex: 2 },
      { type: '=', text: 's', baseIndex: 3, currentIndex: 3 },
    ]);

    // The guard changes the output (fewer "=" ops, no LCS search) — proving the
    // fallback path is actually reachable and distinct from the optimal path.
    expect(fallbackOps).not.toEqual(defaultOps);
  });

  it('does not trigger the fallback when the cell budget comfortably covers the middle section', () => {
    const base = ['p', 'a', 'b', 's'];
    const current = ['p', 'b', 'a', 's'];
    // Middle section after trimming is 2x2 lines -> (2+1)*(2+1) = 9 cells.
    const ops = diffLines(base, current, 9);
    expect(ops).toEqual(diffLines(base, current));
  });
});
