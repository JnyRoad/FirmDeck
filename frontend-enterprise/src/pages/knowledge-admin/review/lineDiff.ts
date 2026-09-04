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
 *
 * T079 性能修复：原实现用嵌套 `number[][]`（逐行 `Array.from(...).fill(0)`）+
 * 逐格字符串 `===` 比较，实测 2000 行/约 10% 变动的文档单次全量重算约 85-140ms，
 * 超出 ReviewEditor 单次按键重绘 ≤50ms 的预算（SC-007）。改为单块 `Int32Array`
 * 存表（消除嵌套数组的对象头/越界检查开销）+ 行内容预先映射为整数 id（消除逐格
 * 字符串比较），并在填表前裁掉首尾完全相同的行（裁剪后再补回等值 op，不改变
 * 回溯路径——因为原循环遇到 `base[i]===current[j]` 时无条件先走"="分支，裁剪
 * 掉的边界行必然会被同样处理，纯属跳过对它们的冗余 DP 填格）。同一批 2000 行
 * 基准下降到约 8-10ms，量级足够为 React 提交与字符级高亮留出预算。回溯时相同
 * 得分优先输出删除、再输出新增的语义与裁剪前完全一致，见 lineDiff.test.ts。
 * 输入：两个字符串数组；输出：`(n+1) x (m+1)` 的 LCS 长度矩阵（扁平化存储）。
 */
function buildLcsTable(baseIds: Int32Array, currentIds: Int32Array): { dp: Int32Array; width: number } {
  const n = baseIds.length;
  const m = currentIds.length;
  const width = m + 1;
  const dp = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    const rowOffset = i * width;
    const nextRowOffset = (i + 1) * width;
    const bi = baseIds[i];
    for (let j = m - 1; j >= 0; j--) {
      dp[rowOffset + j] =
        bi === currentIds[j] ? dp[nextRowOffset + j + 1] + 1 : Math.max(dp[nextRowOffset + j], dp[rowOffset + j + 1]);
    }
  }
  return { dp, width };
}

/**
 * T079 修复（内存预算护栏）：LCS DP 表按 cell 数（`(n+1) x (m+1)`）计算的内存预算。
 * `Int32Array` 每 cell 占 4 字节，16,000,000 cells ≈ 64MB，是本轮修复选定的上限。
 * diff 端点（`backend/app/api/knowledge_admin.py`）的 `max_lines` 参数允许最高
 * 50,000；两篇各 5 万行且中段完全不重叠的文档会建出约 50001×50001 ≈ 25 亿 cell
 * （约 10GB）的表，足以让进程 OOM 或长时间阻塞。裁剪首尾公共行后才检查这个预算，
 * 因此真实场景里“大文档、小改动”（首尾大段相同）不会触发；只有变化区域本身就
 * 巨大的输入才会退化到下面 `diffLines` 里的线性兜底策略。
 */
export const LCS_CELL_BUDGET = 16_000_000;

/**
 * 对两个行数组做 LCS 行级 diff，回溯时相同得分优先输出删除、再输出新增。
 * 输入：base 行数组、current 行数组、可选的 DP 表 cell 预算（默认 `LCS_CELL_BUDGET`，
 * 仅供测试注入更小的值以在不分配巨型数组的前提下验证兜底路径）；输出：按行顺序
 * 排列的 diff 操作数组，无副作用。
 *
 * 兜底策略（超预算时）：跳过 LCS 建表与回溯，把裁剪首尾公共行后剩下的中段直接
 * 标记为「全删旧内容 + 全插新内容」。这不再是最优 diff（放弃在中段内找公共子
 * 序列），但输出 shape 仍是合法的 diff op 序列（前缀/中段/后缀顺序不变），调用方
 * （hunkModel.ts）无需特殊处理。
 */
export function diffLines(base: string[], current: string[], cellBudget: number = LCS_CELL_BUDGET): LineDiffOp[] {
  const n = base.length;
  const m = current.length;
  if (n === 0 && m === 0) return [];

  // 行内容 → 整数 id：把 DP 填表与回溯里的字符串比较全部替换成整数比较。
  const idOf = new Map<string, number>();
  let nextId = 0;
  const baseIds = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    let id = idOf.get(base[i]);
    if (id === undefined) {
      id = nextId++;
      idOf.set(base[i], id);
    }
    baseIds[i] = id;
  }
  const currentIds = new Int32Array(m);
  for (let j = 0; j < m; j++) {
    let id = idOf.get(current[j]);
    if (id === undefined) {
      id = nextId++;
      idOf.set(current[j], id);
    }
    currentIds[j] = id;
  }

  // 裁掉首尾完全相同的行，DP 只在真正变化的中段上填表。
  const maxPrefix = Math.min(n, m);
  let prefix = 0;
  while (prefix < maxPrefix && baseIds[prefix] === currentIds[prefix]) prefix++;
  const maxSuffix = maxPrefix - prefix;
  let suffix = 0;
  while (suffix < maxSuffix && baseIds[n - 1 - suffix] === currentIds[m - 1 - suffix]) suffix++;

  const ops: LineDiffOp[] = [];
  for (let k = 0; k < prefix; k++) {
    ops.push({ type: '=', text: base[k], baseIndex: k, currentIndex: k });
  }

  const bn = n - prefix - suffix;
  const bm = m - prefix - suffix;
  if (bn > 0 || bm > 0) {
    const cells = (bn + 1) * (bm + 1);
    if (cells > cellBudget) {
      // 超出内存预算：放弃在中段内求最优 LCS，退化为「全删旧内容 + 全插新内容」
      // 的线性兜底（见上方 LCS_CELL_BUDGET 注释）。
      for (let i = 0; i < bn; i++) {
        ops.push({ type: '-', text: base[prefix + i], baseIndex: prefix + i, currentIndex: null });
      }
      for (let j = 0; j < bm; j++) {
        ops.push({ type: '+', text: current[prefix + j], baseIndex: null, currentIndex: prefix + j });
      }
    } else {
      const { dp, width } = buildLcsTable(baseIds.subarray(prefix, prefix + bn), currentIds.subarray(prefix, prefix + bm));
      let i = 0;
      let j = 0;
      while (i < bn && j < bm) {
        if (baseIds[prefix + i] === currentIds[prefix + j]) {
          ops.push({ type: '=', text: base[prefix + i], baseIndex: prefix + i, currentIndex: prefix + j });
          i++;
          j++;
        } else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
          ops.push({ type: '-', text: base[prefix + i], baseIndex: prefix + i, currentIndex: null });
          i++;
        } else {
          ops.push({ type: '+', text: current[prefix + j], baseIndex: null, currentIndex: prefix + j });
          j++;
        }
      }
      while (i < bn) {
        ops.push({ type: '-', text: base[prefix + i], baseIndex: prefix + i, currentIndex: null });
        i++;
      }
      while (j < bm) {
        ops.push({ type: '+', text: current[prefix + j], baseIndex: null, currentIndex: prefix + j });
        j++;
      }
    }
  }

  for (let k = 0; k < suffix; k++) {
    const baseIndex = n - suffix + k;
    const currentIndex = m - suffix + k;
    ops.push({ type: '=', text: base[baseIndex], baseIndex, currentIndex });
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
