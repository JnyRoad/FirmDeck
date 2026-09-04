/**
 * ReviewEditor.perf.test.tsx — T079 性能验证（SC-007）：审阅编辑器单次按键重绘。
 *
 * 渲染一篇 2000 行的 `modified` 文档（base/current 各 2000 行，约 200 行 / 10% 的
 * 行级差异，改动分散在全篇而非集中在首尾，避免共同前后缀裁剪掩盖真实成本），用与
 * `ReviewEditor.test.tsx` 相同的"改 `.et` 的 `textContent` 后派发 `input` 事件"手法
 * 模拟一次按键（jsdom 不实现真实 contenteditable 原生编辑，见该文件顶部注释），
 * 在 `act()` 完成后用 `performance.now()` 测量单次重绘耗时。
 *
 * T079 修复回合 1（Ruling）：jsdom 的 wall-clock 计时会被宿主机负载干扰（复核时
 * 在负载 17 的机器上观测到 72-137ms 的样本），固定 50ms 断言在繁忙机器/CI 上会
 * flaky。真正的「单次按键重绘 ≤50ms」（SC-007）验收标准由 T077 在真实浏览器中
 * 验证；jsdom 计时仅作 advisory 参考。因此默认只做 ≤500ms 的灾难性回归哨兵断言并
 * 无条件打印样本；只有显式设置环境变量 `PERF_STRICT=1` 时才按 SC-007 的 50ms 预算
 * 严格断言（见下方 `PERF_STRICT`/`logAndAssertBudget`）。
 *
 * 每次测量都是一次真实的"单次按键"（一次 `act()` 内派发一次 `input`），但取
 * 3 次预热 + 5 次计时后的中位数而非单个样本：jsdom 测试进程会受 GC 停顿/CI
 * 机器抖动影响，单样本在阈值附近有真实的偶发抖动（剖析阶段实测 5 次独立运行里
 * 出现过 1 次 56.5ms 的离群值，其余稳定在 33-37ms）；中位数与 backend perf 测试
 * 的 p95 聚合是同一用意——测的是稳态成本，不是最坏单帧尖峰。
 *
 * UNVERIFIED：jsdom 不做真实 layout/paint，这里测的是"DOM 已更新 + React 提交
 * 完成"（diff 重算 buildModel + reconcile + commit 到 jsdom 树），不包含浏览器真实
 * 样式计算/布局/合成绘制耗时；真实浏览器下的按键重绘由 T077 的手工/E2E 验证覆盖。
 *
 * 性能剖析记录（详见 task-T079-report.md）：
 * 1) `lineDiff.ts diffLines` 原实现用嵌套 `number[][]` LCS 表 + 逐格字符串 `===`
 *    比较，2000×2000 规模单次全量重算约 85-140ms，单独已超预算。改为 `Int32Array`
 *    扁平 DP 表 + 行内容整数化比较 + 公共前后缀裁剪（见 lineDiff.ts 顶部注释），
 *    同规模降到约 5-10ms；契约与回溯语义不变。
 * 2) `ReviewEditor.tsx` 的 `input` 处理器原先每次按键都用 `readAllLines()`（对
 *    整个容器 `querySelectorAll` 后逐行读 `textContent`）重读全部 2000+ 行，
 *    2000 行规模下单次约 40-65ms。浏览器原生 contenteditable 编辑永远只改动事件
 *    目标那一行，其余行此前必然已与 `state.lines` 一致，因此改为单行快路径
 *    （见 `handleSingleRowInput`），只替换事件目标那一行，跨行操作（Enter/
 *    Backspace/Delete/跨行选区/粘贴）仍走原有的 keydown/paste 接管路径，不受影响。
 * 3) 未改动的上下文行（`=`，2000 行/10% 差异 fixture 下约占 90%）原先和 `-`/`+`
 *    行一起内联在同一个 `.map()` 里，每次按键都为全部行重新创建 React element
 *    并走一遍 reconcile。抽成 `React.memo` 的 `EqualRow` 组件后，未暂存（typing
 *    场景的常态）时 `stagedBadge` prop 恒为 `null`，`memo` 默认浅比较能在内容不变
 *    的行上完全跳过组件调用与 element 创建。
 * 以上三项组合后，2000 行文档单次按键中位数从约 300-500ms 降到约 33-37ms；均为
 * 纯性能改动，不改变对外行为——`lineDiff.test.ts`/`hunkModel.test.ts`/
 * `editorDom.test.ts`/`staging.test.ts`/`ReviewEditor.test.tsx` 等既有测试全绿。
 */
// @vitest-environment jsdom
import { act } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ReviewEditor, type ReviewEditorLabels } from './ReviewEditor';

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

const TOTAL_LINES = 2000;
const CHANGED_EVERY = 10; // 每 10 行改动 1 行 → 约 10%（200/2000）行差异，且分散在全篇
const WARMUP_KEYSTROKES = 3;
const TIMED_KEYSTROKES = 5;

/** 构造 2000 行 base/current，约 10% 行差异分散在全篇（不集中在首尾，避免公共
 * 前后缀裁剪把测试规模隐性缩小）。 */
function buildLargeDocPair(): { base: string; current: string } {
  const baseLines: string[] = [];
  for (let i = 0; i < TOTAL_LINES; i++) {
    baseLines.push(`line number ${i} 性能测试正文内容占位填充文本，用于拉长单行长度模拟真实文档`);
  }
  const currentLines = baseLines.slice();
  for (let i = 0; i < TOTAL_LINES; i += CHANGED_EVERY) {
    currentLines[i] = `${currentLines[i]} CHANGED`;
  }
  return { base: baseLines.join('\n'), current: currentLines.join('\n') };
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

/** 在指定 `data-li` 行上追加一个字符并派发 `input`，模拟浏览器已完成的一次按键
 * 原生插入（与 ReviewEditor.test.tsx 的"整篇重算"用例手法一致）。返回这一次
 * `act()`（重算 + React 提交）的耗时（ms）。 */
function typeOneCharacter(container: HTMLElement, li: number): number {
  const row = rowAt(container, li);
  const nextText = `${row.textContent ?? ''}x`;
  const t0 = performance.now();
  act(() => {
    row.textContent = nextText;
    setCollapsedCaret(row, nextText.length);
    // 必须带 `inputType`：单行快路径只对白名单里的原生输入类型生效（I4），
    // 裸 `Event` 会被当作"未知输入"走整篇重算，测不到被优化的那条路径。
    fireEvent.input(row, { bubbles: true, inputType: 'insertText' });
  });
  return performance.now() - t0;
}

function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** 在同一行连续敲 `WARMUP_KEYSTROKES` 次预热（不计入）+ `TIMED_KEYSTROKES` 次
 * 计时，返回计时样本的中位数（ms）与全部原始样本，供断言与报告数值表使用。 */
function measureKeystrokeMedianMs(container: HTMLElement, li: number): { medianMs: number; samplesMs: number[] } {
  for (let i = 0; i < WARMUP_KEYSTROKES; i++) {
    typeOneCharacter(container, li);
  }
  const samplesMs: number[] = [];
  for (let i = 0; i < TIMED_KEYSTROKES; i++) {
    samplesMs.push(typeOneCharacter(container, li));
  }
  return { medianMs: median(samplesMs), samplesMs };
}

// SC-007 硬性阈值：单次按键重绘（diff 重算 + React 提交）≤ 50ms。
const KEYSTROKE_THRESHOLD_MS = 50;

// T079 修复回合 1（Ruling finding #3）：jsdom 下的 wall-clock 计时会被宿主机负载
// 干扰——复核时在负载 17 的机器上观测到 72-137ms 的样本，若把 50ms 当硬性阈值在
// CI/繁忙开发机上会持续 flaky。真正的「单次按键重绘 ≤50ms」验收标准由 T077 在
// 真实浏览器里验证；这里的 jsdom 计时只是 advisory（仅用于在本地/剖析阶段快速
// 发现回归量级，不代表真实浏览器 layout/paint 耗时）。
//
// 因此默认（未设置 PERF_STRICT=1）只做一个很宽松的「灾难性回归」哨兵断言
// （≤500ms，约为预算的 10 倍），并且无条件打印样本，方便任何人本地复现真实数值；
// 只有显式设置 `PERF_STRICT=1`（例如 `PERF_STRICT=1 vitest run
// ReviewEditor.perf.test.tsx`）时才按 SC-007 的 50ms 预算严格断言。
const PERF_STRICT = process.env.PERF_STRICT === '1';
const SANITY_CEILING_MS = 500;

function logAndAssertBudget(label: string, medianMs: number, samplesMs: number[]) {
  const samplesText = samplesMs.map((v) => v.toFixed(2)).join(', ');
  // eslint-disable-next-line no-console -- 有意的、无条件的性能样本输出（Minor 1）。
  console.log(
    `[T079 perf][${label}] jsdom median=${medianMs.toFixed(2)}ms samples(ms)=${samplesText} ` +
      `(strict=${PERF_STRICT}, strict threshold=${KEYSTROKE_THRESHOLD_MS}ms, sanity ceiling=${SANITY_CEILING_MS}ms)`,
  );
  if (PERF_STRICT) {
    expect(medianMs, `samples(ms)=${samplesText}`).toBeLessThanOrEqual(KEYSTROKE_THRESHOLD_MS);
  } else {
    expect(medianMs, `samples(ms)=${samplesText}`).toBeLessThanOrEqual(SANITY_CEILING_MS);
  }
}

describe('ReviewEditor perf — SC-007 2000-line single keystroke redraw', () => {
  it('recomputes and commits a single keystroke on an unchanged row within budget', () => {
    const { base, current } = buildLargeDocPair();
    const { container } = render(
      <ReviewEditor
        documents={[{ lineageId: 'perf-doc', title: 'perf-2000-lines.md', kind: 'modified', base, current }]}
        labels={labels}
        onChange={() => {}}
      />,
    );

    // li=1004（1004 % 10 !== 0）落在一段未变（'='）行上，代表在大段未改动上下文
    // 内继续输入的常见场景；换成落在一个 '+' 行上重复本测试，量级同样成立
    // （已在剖析阶段手工验证），这里固定选一行以保证测试确定性。
    const unchangedLi = 1004;
    expect(unchangedLi % CHANGED_EVERY).not.toBe(0);

    const { medianMs, samplesMs } = measureKeystrokeMedianMs(container, unchangedLi);

    logAndAssertBudget('li=1004', medianMs, samplesMs);
  });

  it('stays within budget for a second, independent row', () => {
    // 用不同的行复核第一条用例不是偶然的单次抽样：两条独立用例都必须达标。
    const { base, current } = buildLargeDocPair();
    const { container } = render(
      <ReviewEditor
        documents={[{ lineageId: 'perf-doc-2', title: 'perf-2000-lines-2.md', kind: 'modified', base, current }]}
        labels={labels}
        onChange={() => {}}
      />,
    );

    const unchangedLi = 1506;
    expect(unchangedLi % CHANGED_EVERY).not.toBe(0);

    const { medianMs, samplesMs } = measureKeystrokeMedianMs(container, unchangedLi);

    logAndAssertBudget('li=1506', medianMs, samplesMs);
  });
});
