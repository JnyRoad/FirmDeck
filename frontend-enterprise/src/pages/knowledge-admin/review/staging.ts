/**
 * staging.ts — Git 式暂存纯函数模块。
 *
 * 不依赖 React / DOM / API / i18n；也不依赖 lineDiff.ts / hunkModel.ts —
 * 所有操作只接受调用方已经算好的 hunk 形状数据（`bs`/`insertAt`/`removed`/
 * `added`），自身只做数组拼接与位置偏移算术，保持与差异算法解耦。
 *
 * 状态语义：`base` 是草稿基线（只读、不随审阅变化）；`stagedBase` 是"已接受
 * （暂存）"后的基线，每次 accept 把该块并入 stagedBase；`lines` 是当前工作区
 * 全文（编辑器里真正显示/编辑的内容）；`staged` 记录每次 accept 的历史，供
 * unstage 校验与位置回退、以及 UI 标记 ✓ 折叠区间。
 */

/** 调用方传入的块形状：与 hunkModel.Hunk 结构兼容，但 staging.ts 不导入该模块。 */
export interface HunkLike {
  id?: number;
  bs: number;
  insertAt: number;
  removed: string[];
  added: string[];
}

/** 一条已接受（暂存）记录：`pos` 是该记录在当前 `stagedBase` 中的起始下标。 */
export interface StagedRecord {
  id: number;
  pos: number;
  removed: string[];
  added: string[];
}

/** 暂存状态：`orig` 是挂载时的初始工作区内容，供 hasWork/reset 使用。 */
export interface StagingState {
  base: string[];
  orig: string[];
  stagedBase: string[];
  lines: string[];
  staged: StagedRecord[];
}

/**
 * 创建初始暂存状态：`stagedBase` 从 base 拷贝，`lines`/`orig` 从 current 拷贝。
 * 输入：base 行数组、current（草稿当前）行数组；输出：全新 StagingState，无副作用。
 */
export function createState(base: string[], current: string[]): StagingState {
  return {
    base: [...base],
    orig: [...current],
    stagedBase: [...base],
    lines: [...current],
    staged: [],
  };
}

/** 数组浅比较（长度与逐项 `===`）。 */
function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** 分配下一个暂存记录 id：当前最大 id + 1（空列表从 1 开始）。 */
function nextRecordId(staged: StagedRecord[]): number {
  return staged.reduce((max, r) => Math.max(max, r.id), 0) + 1;
}

/**
 * 接受（暂存）一个变更块：把 `hunk.added` 拼入 `stagedBase` 的 `bs` 位置替换
 * 掉 `hunk.removed.length` 项，并按行数变化量（delta）平移所有已存在的、位于
 * 该位置之后的暂存记录；`lines` 不变（它已经就是块所在的新内容）。
 * 输入：当前状态、待接受的块；输出：新状态，不修改入参，无其它副作用。
 */
export function stage(state: StagingState, hunk: HunkLike): StagingState {
  const { bs, removed, added } = hunk;
  const newStagedBase = [
    ...state.stagedBase.slice(0, bs),
    ...added,
    ...state.stagedBase.slice(bs + removed.length),
  ];
  const delta = added.length - removed.length;
  const shifted = state.staged.map((r) => (r.pos >= bs ? { ...r, pos: r.pos + delta } : r));
  const record: StagedRecord = {
    id: nextRecordId(state.staged),
    pos: bs,
    removed: [...removed],
    added: [...added],
  };
  const newStaged = [...shifted, record].sort((a, b) => a.pos - b.pos);
  return { ...state, stagedBase: newStagedBase, staged: newStaged };
}

/**
 * 校验某条暂存记录对应的 `stagedBase` 区间是否仍等于记录时的 `added`
 * （即该区域没有被后续操作进一步改动）。
 * 输入：当前状态、记录 id；输出：布尔值，无副作用。
 */
export function canUnstage(state: StagingState, recordId: number): boolean {
  const record = state.staged.find((r) => r.id === recordId);
  if (!record) return false;
  const region = state.stagedBase.slice(record.pos, record.pos + record.added.length);
  return arraysEqual(region, record.added);
}

/**
 * 撤销接受（unstage）：校验通过后把 `stagedBase` 对应区间换回记录的 `removed`，
 * 并按行数变化量平移其余记录；校验失败或记录不存在时原样返回入参（no-op，
 * 可用 `===` 判断是否被拒绝）。
 * 输入：当前状态、记录 id；输出：新状态或原状态引用，无其它副作用。
 */
export function unstage(state: StagingState, recordId: number): StagingState {
  const record = state.staged.find((r) => r.id === recordId);
  if (!record) return state;
  if (!canUnstage(state, recordId)) return state;
  const { pos, removed, added } = record;
  const newStagedBase = [
    ...state.stagedBase.slice(0, pos),
    ...removed,
    ...state.stagedBase.slice(pos + added.length),
  ];
  const delta = removed.length - added.length;
  const newStaged = state.staged
    .filter((r) => r.id !== recordId)
    .map((r) => (r.pos > pos ? { ...r, pos: r.pos + delta } : r));
  return { ...state, stagedBase: newStagedBase, staged: newStaged };
}

/**
 * 拒绝一个待审阅块：把工作区 `lines` 对应区间（`insertAt`..`insertAt+added.length`）
 * 换回块的 `removed` 内容，不触碰 `stagedBase`/`staged`。
 * 输入：当前状态、待拒绝的块；输出：新状态，无其它副作用。
 */
export function reject(state: StagingState, hunk: HunkLike): StagingState {
  const { insertAt, removed, added } = hunk;
  const newLines = [
    ...state.lines.slice(0, insertAt),
    ...removed,
    ...state.lines.slice(insertAt + added.length),
  ];
  return { ...state, lines: newLines };
}

/**
 * 接受全部：按块 `bs` 降序依次 stage，保证后处理的块不会使先处理的块的 `bs`
 * 失效（splice 只影响右侧下标）。
 * 输入：当前状态、待接受的块数组（任意顺序）；输出：新状态，无其它副作用。
 */
export function acceptAll(state: StagingState, hunks: HunkLike[]): StagingState {
  const sorted = [...hunks].sort((a, b) => b.bs - a.bs);
  return sorted.reduce((s, h) => stage(s, h), state);
}

/**
 * 拒绝全部：按块 `insertAt` 降序依次 reject，理由同 acceptAll。
 * 输入：当前状态、待拒绝的块数组（任意顺序）；输出：新状态，无其它副作用。
 */
export function rejectAll(state: StagingState, hunks: HunkLike[]): StagingState {
  const sorted = [...hunks].sort((a, b) => b.insertAt - a.insertAt);
  return sorted.reduce((s, h) => reject(s, h), state);
}

/**
 * 重置为草稿原文：`lines` 回到挂载时的 `orig`，`staged` 清空，`stagedBase`
 * 回到 `base`。
 * 输入：当前状态；输出：新状态，无其它副作用。
 */
export function reset(state: StagingState): StagingState {
  return { ...state, lines: [...state.orig], staged: [], stagedBase: [...state.base] };
}

/**
 * 待审阅数：就是当前传入的（已按最新 stagedBase/lines 重算出的）块数组长度。
 * 输入：块数组；输出：数量，无副作用。
 */
export function pendingCount(hunks: HunkLike[]): number {
  return hunks.length;
}

/**
 * 是否存在尚未应用的改动：工作区内容偏离初始草稿原文，或存在任意暂存记录。
 * 输入：当前状态；输出：布尔值，无副作用。
 */
export function hasWork(state: StagingState): boolean {
  return state.staged.length > 0 || !arraysEqual(state.lines, state.orig);
}
