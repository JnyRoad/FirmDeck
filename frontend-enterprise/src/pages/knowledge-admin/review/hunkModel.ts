/**
 * hunkModel.ts — 行 diff 之上的块（hunk）与渲染行（row）纯函数模块。
 *
 * 不依赖 React / DOM / API / i18n。由 lineDiff.ts 的 diff 操作序列组装出
 * 渲染用的 rows 与变更块 hunks；对每个块内的删除/新增行做相似度配对
 * （alignHunk，供字符级高亮与"恢复此行"定位使用）；charOps/innerHtml 做
 * 字符级 LCS 高亮与转义后的 HTML 片段拼装（纯字符串操作，不接触真实
 * DOM）；restorePos 计算未配对删除行插回工作区 `lines` 的位置。
 */
import { diffLines, lcsLength, type LineDiffOp } from './lineDiff';

/** 渲染行：`=` 上下文/未改动、`-` 删除（来自 base）、`+` 新增（来自 current）。 */
export type Row =
  | { t: '='; text: string; li: number; bi: number; h: null; ri: null; ai: null }
  | { t: '-'; text: string; li: null; bi: number; h: number; ri: number; ai: null }
  | { t: '+'; text: string; li: number; bi: null; h: number; ri: null; ai: number };

/** 变更块：`bs` 是在 base 行数组中的起始下标，`insertAt` 是在 current 行数组中的起始下标。 */
export interface Hunk {
  id: number;
  bs: number;
  insertAt: number;
  removed: string[];
  added: string[];
}

/** alignHunk 产出的一对相似行配对：块内下标 `ri`（removed）与 `ai`（added）及其相似度。 */
export interface AlignPair {
  ri: number;
  ai: number;
  ratio: number;
}

/** 字符级 diff 的一段游程（同类型连续字符合并为一段）。 */
export type CharOp = { type: '='; text: string } | { type: '-'; text: string } | { type: '+'; text: string };

/**
 * 由 base/current 两侧行数组构建渲染用 rows 与变更块 hunks。
 * 输入：base 行数组、current 行数组；输出：`{rows, hunks}`，无副作用。
 */
export function buildModel(base: string[], current: string[]): { rows: Row[]; hunks: Hunk[] } {
  const ops = diffLines(base, current);
  const rows: Row[] = [];
  const hunks: Hunk[] = [];
  let i = 0;
  while (i < ops.length) {
    const op = ops[i];
    if (op.type === '=') {
      rows.push({ t: '=', text: op.text, li: op.currentIndex, bi: op.baseIndex, h: null, ri: null, ai: null });
      i++;
      continue;
    }
    const blockOps: LineDiffOp[] = [];
    while (i < ops.length && ops[i].type !== '=') {
      blockOps.push(ops[i]);
      i++;
    }
    const rawNextOp = ops[i]; // 该块结束后紧跟的 op，若存在，因 while 条件必为 '='
    const nextEqualOp = rawNextOp && rawNextOp.type === '=' ? rawNextOp : null;
    const removedOps = blockOps.filter((o): o is LineDiffOp & { type: '-' } => o.type === '-');
    const addedOps = blockOps.filter((o): o is LineDiffOp & { type: '+' } => o.type === '+');
    const hunkId = hunks.length;
    const bs =
      removedOps.length > 0 ? removedOps[0].baseIndex : nextEqualOp ? nextEqualOp.baseIndex : base.length;
    const insertAt =
      addedOps.length > 0
        ? addedOps[0].currentIndex
        : nextEqualOp
          ? nextEqualOp.currentIndex
          : current.length;
    let rCount = 0;
    let aCount = 0;
    for (const o of blockOps) {
      if (o.type === '-') {
        rows.push({ t: '-', text: o.text, li: null, bi: o.baseIndex, h: hunkId, ri: rCount, ai: null });
        rCount++;
      } else {
        rows.push({ t: '+', text: o.text, li: o.currentIndex, bi: null, h: hunkId, ri: null, ai: aCount });
        aCount++;
      }
    }
    hunks.push({
      id: hunkId,
      bs,
      insertAt,
      removed: removedOps.map((o) => o.text),
      added: addedOps.map((o) => o.text),
    });
  }
  return { rows, hunks };
}

/**
 * 两个字符串按字符级 LCS 计算相似度（difflib.SequenceMatcher.ratio 同款公式）。
 * 输入：两个字符串；输出：`2*LCS/(lenA+lenB)`，双空串视为完全相同返回 1。
 */
export function similarityRatio(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1;
  const aChars = Array.from(a);
  const bChars = Array.from(b);
  const lcs = lcsLength(aChars, bChars);
  return (2 * lcs) / (aChars.length + bChars.length);
}

/**
 * 对一个变更块内的删除行与新增行做顺序保持的相似度配对（DP 最大化配对相似度之和，
 * 只在 ratio ≥ 0.5 时允许配对，否则跳过其中一侧）。
 * 输入：变更块（含 removed/added）；输出：按 ri 升序排列的配对数组，无副作用。
 */
export function alignHunk(hunk: Hunk): AlignPair[] {
  const R = hunk.removed;
  const A = hunk.added;
  const n = R.length;
  const m = A.length;
  if (n === 0 || m === 0) return [];
  const ratios: number[][] = Array.from({ length: n }, () => new Array<number>(m).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      ratios[i][j] = similarityRatio(R[i], A[j]);
    }
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  // choice: 0 = pair (i-1,j-1), 1 = skip removed[i-1], 2 = skip added[j-1]
  const choice: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const ratio = ratios[i - 1][j - 1];
      const skipR = dp[i - 1][j];
      const skipA = dp[i][j - 1];
      let best = skipR;
      let ch = 1;
      if (skipA > best) {
        best = skipA;
        ch = 2;
      }
      if (ratio >= 0.5) {
        const pairScore = dp[i - 1][j - 1] + ratio;
        if (pairScore > best) {
          best = pairScore;
          ch = 0;
        }
      }
      dp[i][j] = best;
      choice[i][j] = ch;
    }
  }
  const pairs: AlignPair[] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const ch = choice[i][j];
    if (ch === 0) {
      pairs.unshift({ ri: i - 1, ai: j - 1, ratio: ratios[i - 1][j - 1] });
      i--;
      j--;
    } else if (ch === 1) {
      i--;
    } else {
      j--;
    }
  }
  return pairs;
}

/** 把纯文本按 Unicode 码位切分为字符数组（避免代理对被拆开）。 */
function toCodePoints(text: string): string[] {
  return Array.from(text);
}

/**
 * 对两个字符串做字符级 LCS diff，产出 `=`/`-`/`+` 游程（同类型连续字符合并）。
 * 输入：base 字符串、current 字符串；输出：CharOp 数组，无副作用。
 */
export function charOps(a: string, b: string): CharOp[] {
  const aChars = toCodePoints(a);
  const bChars = toCodePoints(b);
  const n = aChars.length;
  const m = bChars.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = aChars[i] === bChars[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const runs: CharOp[] = [];
  const push = (type: CharOp['type'], ch: string) => {
    const last = runs[runs.length - 1];
    if (last && last.type === type) {
      last.text += ch;
    } else {
      runs.push({ type, text: ch });
    }
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (aChars[i] === bChars[j]) {
      push('=', aChars[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push('-', aChars[i]);
      i++;
    } else {
      push('+', bChars[j]);
      j++;
    }
  }
  while (i < n) {
    push('-', aChars[i]);
    i++;
  }
  while (j < m) {
    push('+', bChars[j]);
    j++;
  }
  return runs;
}

/** 转义 HTML 中有语义的字符，避免原文中的 `<`/`>`/`&` 破坏拼装出的标记。 */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 己方类型游程的高亮样式：直接用 Tailwind 工具类内联，不依赖全仓库任何自定义
 * CSS 类名（`diff-char-del`/`diff-char-add` 不是 Tailwind 工具类，本身没有样式，
 * 之前会导致字符级高亮在页面上不可见）。红/绿字符块比行级红/绿底色更深一档，
 * 形成"整行浅色 + 变化字符再加深"的层次。
 */
const CHAR_HIGHLIGHT_CLASS: Record<'-' | '+', string> = {
  '-': 'bg-red-200/70 rounded-sm',
  '+': 'bg-emerald-200/70 rounded-sm',
};

/**
 * 把字符级 diff 游程渲染为一侧（删除侧 `-` 或新增侧 `+`）的 HTML 片段：
 * 相同游程原样转义输出，己方类型游程包一层 Tailwind 高亮 span，对方类型游程
 * 整体跳过。
 * 输入：CharOp 数组、渲染侧；输出：HTML 字符串，无副作用、不接触真实 DOM。
 */
export function innerHtml(ops: CharOp[], side: '-' | '+'): string {
  let html = '';
  for (const op of ops) {
    if (op.type === '=') {
      html += escapeHtml(op.text);
    } else if (op.type === side) {
      html += `<span class="${CHAR_HIGHLIGHT_CLASS[side]}">${escapeHtml(op.text)}</span>`;
    }
  }
  return html;
}

/**
 * 计算一个未配对删除行恢复（插回）到工作区 `lines` 数组的位置：优先紧跟在前一个
 * 已配对删除行对应的新增行之后；否则紧跟在下一个已配对删除行对应的新增行之前；
 * 都没有则回退到该块的 insertAt（块起始位置）。
 * 输入：所属块、该删除行在 hunk.removed 中的下标、alignHunk 产出的配对数组；
 * 输出：在 current 工作区 `lines` 数组中应插入的下标（无副作用）。
 */
export function restorePos(hunk: Hunk, removedIndex: number, pairs: AlignPair[]): number {
  let prevPair: AlignPair | null = null;
  let nextPair: AlignPair | null = null;
  for (const p of pairs) {
    if (p.ri < removedIndex) {
      if (!prevPair || p.ri > prevPair.ri) prevPair = p;
    } else if (p.ri > removedIndex) {
      if (!nextPair || p.ri < nextPair.ri) nextPair = p;
    }
  }
  if (prevPair) return hunk.insertAt + prevPair.ai + 1;
  if (nextPair) return hunk.insertAt + nextPair.ai;
  return hunk.insertAt;
}
