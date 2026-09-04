/**
 * lineDiff.ts — 行级 LCS diff 纯函数模块。
 *
 * 不依赖 React / DOM / API / i18n；仅做字符串数组之间的最长公共子序列
 * （LCS）比较，产出 `=`（相同）/`-`（删除）/`+`（新增）操作序列，供
 * hunkModel.ts 组装 rows/hunks。审阅编辑器在每次按键后用同一算法对整篇
 * 重新计算差异（R7 决策：编辑期本地重算，仅打开/应用时调用服务端）。
 */

/** 单个 diff 操作：`=` 携带 base/current 两侧下标，`-` 仅 base 下标，`+` 仅 current 下标。 */
export type LineDiffOp =
  | { type: '='; text: string; baseIndex: number; currentIndex: number }
  | { type: '-'; text: string; baseIndex: number; currentIndex: null }
  | { type: '+'; text: string; baseIndex: null; currentIndex: number };

/**
 * 把整篇文本按 `\n` 切分为行数组。
 * 输入：原始文本；输出：行字符串数组。空字符串输入返回空数组（无副作用）。
 */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  return text.split('\n');
}

/**
 * 把行数组用 `\n` 拼回整篇文本，是 splitLines 的逆操作。
 * 输入：行数组；输出：拼接后的文本（无副作用）。
 */
export function joinLines(lines: string[]): string {
  return lines.join('\n');
}

/**
 * 构建从 (i,j) 到序列末尾的最长公共子序列长度表（自底向上填表，无副作用）。
 * 输入：两个字符串数组；输出：`(n+1) x (m+1)` 的 LCS 长度矩阵。
 */
function buildLcsTable(base: string[], current: string[]): number[][] {
  const n = base.length;
  const m = current.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        base[i] === current[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp;
}

/**
 * 对两个行数组做 LCS 行级 diff，回溯时相同得分优先输出删除、再输出新增。
 * 输入：base 行数组、current 行数组；输出：按行顺序排列的 diff 操作数组，无副作用。
 */
export function diffLines(base: string[], current: string[]): LineDiffOp[] {
  const n = base.length;
  const m = current.length;
  if (n === 0 && m === 0) return [];
  const dp = buildLcsTable(base, current);
  const ops: LineDiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (base[i] === current[j]) {
      ops.push({ type: '=', text: base[i], baseIndex: i, currentIndex: j });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: '-', text: base[i], baseIndex: i, currentIndex: null });
      i++;
    } else {
      ops.push({ type: '+', text: current[j], baseIndex: null, currentIndex: j });
      j++;
    }
  }
  while (i < n) {
    ops.push({ type: '-', text: base[i], baseIndex: i, currentIndex: null });
    i++;
  }
  while (j < m) {
    ops.push({ type: '+', text: current[j], baseIndex: null, currentIndex: j });
    j++;
  }
  return ops;
}

/**
 * 计算两个任意元素数组（用 `===` 比较）的最长公共子序列长度，供相似度计算复用。
 * 输入：两个数组；输出：LCS 长度（数字），无副作用。
 */
export function lcsLength<T>(a: T[], b: T[]): number {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return 0;
  let prev = new Array<number>(m + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    const cur = new Array<number>(m + 1).fill(0);
    for (let j = m - 1; j >= 0; j--) {
      cur[j] = a[i] === b[j] ? prev[j + 1] + 1 : Math.max(prev[j], cur[j + 1]);
    }
    prev = cur;
  }
  return prev[0];
}
