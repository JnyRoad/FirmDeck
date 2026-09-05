/**
 * staging.ts 单元测试：暂存基线更新与后续记录偏移、unstage 精确校验与偏移
 * 回退、接受全部按降序处理、拒绝、重置、pending/hasWork。纯函数测试。
 */
import { describe, expect, it } from 'vitest';
import {
  acceptAll,
  canUnstage,
  createState,
  hasWork,
  pendingCount,
  reject,
  rejectAll,
  reset,
  stage,
  unstage,
  type HunkLike,
} from './staging';

describe('createState / hasWork', () => {
  it('creates a pristine state with stagedBase equal to base and no staged records', () => {
    const state = createState(['a', 'b'], ['a', 'b']);
    expect(state.base).toEqual(['a', 'b']);
    expect(state.stagedBase).toEqual(['a', 'b']);
    expect(state.lines).toEqual(['a', 'b']);
    expect(state.orig).toEqual(['a', 'b']);
    expect(state.staged).toEqual([]);
  });

  it('reports no work for a pristine state', () => {
    expect(hasWork(createState(['a'], ['a']))).toBe(false);
  });

  it('reports work when lines diverge from orig', () => {
    const state = { ...createState(['a'], ['a']), lines: ['a', 'b'] };
    expect(hasWork(state)).toBe(true);
  });

  it('reports work when there is at least one staged record even if lines equal orig', () => {
    const state = {
      ...createState(['a'], ['a']),
      staged: [{ id: 1, pos: 0, removed: ['a'], added: ['a'] }],
    };
    expect(hasWork(state)).toBe(true);
  });
});

describe('stage', () => {
  it('merges a hunk into stagedBase at bs, replacing removed with added', () => {
    const state = createState(['a', 'b', 'c'], ['a', 'X', 'c']);
    const hunk: HunkLike = { id: 0, bs: 1, insertAt: 1, removed: ['b'], added: ['X'] };
    const next = stage(state, hunk);
    expect(next.stagedBase).toEqual(['a', 'X', 'c']);
    expect(next.lines).toEqual(['a', 'X', 'c']); // lines untouched by stage
    expect(next.staged).toHaveLength(1);
    expect(next.staged[0]).toMatchObject({ pos: 1, removed: ['b'], added: ['X'] });
  });

  it('shifts existing staged records that sit after the newly staged hunk', () => {
    let state = createState(['a', 'b', 'c', 'd'], ['a', 'X', 'c', 'YY']);
    // First accept the later hunk (d -> YY at bs=3), then the earlier one (b -> X at bs=1).
    state = stage(state, { id: 1, bs: 3, insertAt: 3, removed: ['d'], added: ['YY'] });
    expect(state.staged[0].pos).toBe(3);
    state = stage(state, { id: 0, bs: 1, insertAt: 1, removed: ['b'], added: ['X'] });
    // stagedBase is now ['a','X','c','YY']; the earlier record's pos shifts by
    // delta = added.length - removed.length = 1 - 1 = 0 in this case, so recompute
    // with a size-changing hunk to actually exercise the shift.
    expect(state.stagedBase).toEqual(['a', 'X', 'c', 'YY']);
  });

  it('shifts a later staged record position when an earlier hunk changes line count', () => {
    let state = createState(['a', 'b', 'c', 'd'], ['a', 'X1', 'X2', 'c', 'd']);
    // Accept the later, untouched-count hunk first is not meaningful here since there is
    // only one hunk; instead simulate two independent hunks with a size-changing first one.
    const hunkLater: HunkLike = { id: 1, bs: 3, insertAt: 4, removed: ['d'], added: ['DD'] };
    const hunkEarlier: HunkLike = { id: 0, bs: 1, insertAt: 1, removed: ['b'], added: ['X1', 'X2'] };
    state = stage(state, hunkLater); // stagedBase: a,b,c,DD ; record pos=3
    expect(state.staged[0].pos).toBe(3);
    state = stage(state, hunkEarlier); // inserts one extra line before pos 3 -> shift to 4
    expect(state.stagedBase).toEqual(['a', 'X1', 'X2', 'c', 'DD']);
    const laterRecord = state.staged.find((r) => r.added[0] === 'DD');
    expect(laterRecord?.pos).toBe(4);
  });
});

describe('unstage', () => {
  it('reverts stagedBase back to removed and drops the record when the region is unchanged', () => {
    const state = createState(['a', 'b', 'c'], ['a', 'X', 'c']);
    const hunk: HunkLike = { id: 0, bs: 1, insertAt: 1, removed: ['b'], added: ['X'] };
    const staged = stage(state, hunk);
    const recordId = staged.staged[0].id;
    const reverted = unstage(staged, recordId);
    expect(reverted.stagedBase).toEqual(['a', 'b', 'c']);
    expect(reverted.staged).toEqual([]);
  });

  it('shifts remaining records back when unstaging changes the line count', () => {
    let state = createState(['a', 'b', 'c', 'd'], ['a', 'X1', 'X2', 'c', 'DD']);
    const hunkEarlier: HunkLike = { id: 0, bs: 1, insertAt: 1, removed: ['b'], added: ['X1', 'X2'] };
    const hunkLater: HunkLike = { id: 1, bs: 3, insertAt: 4, removed: ['d'], added: ['DD'] };
    // Stage in descending-bs order (later hunk first) so bs stays valid against
    // the still-unshifted stagedBase, mirroring how acceptAll processes hunks.
    state = stage(state, hunkLater);
    state = stage(state, hunkEarlier);
    expect(state.stagedBase).toEqual(['a', 'X1', 'X2', 'c', 'DD']);
    const earlierId = state.staged.find((r) => r.added[0] === 'X1')!.id;
    const reverted = unstage(state, earlierId);
    expect(reverted.stagedBase).toEqual(['a', 'b', 'c', 'DD']);
    const laterRecord = reverted.staged.find((r) => r.added[0] === 'DD');
    expect(laterRecord?.pos).toBe(3);
  });

  it('refuses to unstage when the staged region has since been edited further', () => {
    const state = createState(['a', 'b', 'c'], ['a', 'X', 'c']);
    const hunk: HunkLike = { id: 0, bs: 1, insertAt: 1, removed: ['b'], added: ['X'] };
    const staged = stage(state, hunk);
    const recordId = staged.staged[0].id;
    const tampered = { ...staged, stagedBase: ['a', 'CHANGED', 'c'] };
    const result = unstage(tampered, recordId);
    expect(result).toBe(tampered); // unchanged: refused
    expect(canUnstage(tampered, recordId)).toBe(false);
  });

  it('canUnstage returns true only for a record whose region still matches', () => {
    const state = createState(['a', 'b', 'c'], ['a', 'X', 'c']);
    const hunk: HunkLike = { id: 0, bs: 1, insertAt: 1, removed: ['b'], added: ['X'] };
    const staged = stage(state, hunk);
    const recordId = staged.staged[0].id;
    expect(canUnstage(staged, recordId)).toBe(true);
  });

  it('is a no-op when the record id does not exist', () => {
    const state = createState(['a'], ['a']);
    expect(unstage(state, 999)).toBe(state);
  });
});

describe('reject', () => {
  it('reverts lines back to removed for the given pending hunk without touching stagedBase', () => {
    const state = createState(['a', 'b', 'c'], ['a', 'X', 'c']);
    const hunk: HunkLike = { id: 0, bs: 1, insertAt: 1, removed: ['b'], added: ['X'] };
    const next = reject(state, hunk);
    expect(next.lines).toEqual(['a', 'b', 'c']);
    expect(next.stagedBase).toEqual(['a', 'b', 'c']);
  });
});

describe('acceptAll', () => {
  it('processes hunks in descending bs order so earlier positions stay valid', () => {
    const state = createState(['a', 'b', 'c', 'd'], ['a', 'X1', 'X2', 'c', 'DD']);
    const hunks: HunkLike[] = [
      { id: 0, bs: 1, insertAt: 1, removed: ['b'], added: ['X1', 'X2'] },
      { id: 1, bs: 3, insertAt: 4, removed: ['d'], added: ['DD'] },
    ];
    const next = acceptAll(state, hunks);
    expect(next.stagedBase).toEqual(['a', 'X1', 'X2', 'c', 'DD']);
    expect(next.staged).toHaveLength(2);
  });
});

describe('rejectAll', () => {
  it('processes hunks in descending insertAt order and restores lines fully to base-equivalent content', () => {
    const state = createState(['a', 'b', 'c', 'd'], ['a', 'X1', 'X2', 'c', 'DD']);
    const hunks: HunkLike[] = [
      { id: 0, bs: 1, insertAt: 1, removed: ['b'], added: ['X1', 'X2'] },
      { id: 1, bs: 3, insertAt: 4, removed: ['d'], added: ['DD'] },
    ];
    const next = rejectAll(state, hunks);
    expect(next.lines).toEqual(['a', 'b', 'c', 'd']);
    expect(next.stagedBase).toEqual(['a', 'b', 'c', 'd']); // unchanged, nothing was staged
  });
});

describe('reset', () => {
  it('restores lines to orig, clears staged, and resets stagedBase to base', () => {
    let state = createState(['a', 'b'], ['a', 'X']);
    state = stage(state, { id: 0, bs: 1, insertAt: 1, removed: ['b'], added: ['X'] });
    state = { ...state, lines: ['a', 'Y'] };
    const next = reset(state);
    expect(next.lines).toEqual(['a', 'X']); // orig was ['a','X'] at createState time
    expect(next.staged).toEqual([]);
    expect(next.stagedBase).toEqual(['a', 'b']);
  });
});

describe('pendingCount', () => {
  it('is simply the number of hunks currently passed in', () => {
    expect(pendingCount([])).toBe(0);
    expect(pendingCount([{ id: 0, bs: 0, insertAt: 0, removed: ['a'], added: ['b'] }])).toBe(1);
  });
});
