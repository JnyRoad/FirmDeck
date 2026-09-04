/**
 * editorDom.ts — 审阅编辑器的行编辑与 DOM 定位辅助模块。
 *
 * 不依赖 React / API / i18n；可以使用浏览器 DOM/Selection API（这是它存在
 * 的目的：把 contenteditable 的光标定位、整篇行读取、跨行选区映射从
 * ReviewEditor.tsx 中隔离出来，便于纯逻辑单独测试）。
 *
 * 光标定位统一用"非删除行索引（li，即工作区 `lines` 数组下标）+ 行内字符
 * 偏移"表示，不用 DOM 行下标——因为一次按键可能让某一行在"相同/变更"之间
 * 切换从而改变可见行（row）总数，但 `lines` 数组本身的行数与顺序在这类编辑
 * 中保持不变，用 li 定位更稳定。
 *
 * jsdom 限制：jsdom 未实现真实 contenteditable 的浏览器原生编辑行为（键入
 * 不会自动更新 DOM），也未实现 `document.execCommand`；因此
 * ReviewEditor.test.tsx 里的"单行内输入"用例改为直接修改 `.et` 的
 * `textContent` 后派发 `InputEvent('input')`（模拟浏览器已完成原生插入），
 * 而不是真正依赖 jsdom 执行 contenteditable 输入。jsdom 对 `Range`/
 * `Selection`（`setStart`/`setEnd`/`getSelection().addRange`）与
 * `textContent`/`childNodes` 的支持足以覆盖本模块的定位与读取逻辑，已用
 * `editorDom.test.ts` 的 DOM 用例验证。
 */

/** 行编辑操作的通用结果：新的 `lines` 数组与建议落点的 li/offset。 */
export interface LineEditResult {
  lines: string[];
  caretLi: number;
  caretOffset: number;
}

/** 把偏移量夹在 `[0, text.length]` 范围内，避免越界。 */
function clampOffset(text: string, offset: number): number {
  return Math.max(0, Math.min(offset, text.length));
}

/**
 * 把 [startLi,startOffset]..[endLi,endOffset] 区间的内容替换为 insertedText
 * （可含 `\n`，会被拆成多行插入）；区间可以是同一行内、跨多行，或反向（起点
 * 在终点之后，会先归一化）。
 * 输入：当前 lines、区间四元组、待插入文本；输出：新 lines 与建议光标位置，
 * 无副作用（不修改入参数组）。
 */
export function insertTextAtRange(
  lines: string[],
  startLi: number,
  startOffset: number,
  endLi: number,
  endOffset: number,
  insertedText: string,
): LineEditResult {
  let sLi = startLi;
  let sOff = startOffset;
  let eLi = endLi;
  let eOff = endOffset;
  if (eLi < sLi || (eLi === sLi && eOff < sOff)) {
    [sLi, eLi] = [eLi, sLi];
    [sOff, eOff] = [eOff, sOff];
  }
  const startLine = lines[sLi] ?? '';
  const endLine = lines[eLi] ?? '';
  const before = startLine.slice(0, clampOffset(startLine, sOff));
  const after = endLine.slice(clampOffset(endLine, eOff));
  const insertedLines = insertedText.split('\n');
  const merged = [before + insertedLines[0]];
  for (let k = 1; k < insertedLines.length; k++) {
    merged.push(insertedLines[k]);
  }
  merged[merged.length - 1] += after;
  const newLines = [...lines.slice(0, sLi), ...merged, ...lines.slice(eLi + 1)];
  const caretLi = sLi + insertedLines.length - 1;
  const caretOffset = merged[merged.length - 1].length - after.length;
  return { lines: newLines, caretLi, caretOffset };
}

/**
 * 删除 [startLi,startOffset]..[endLi,endOffset] 区间的内容（insertTextAtRange
 * 的 insertedText='' 特例）。
 * 输入：当前 lines、区间四元组；输出：新 lines 与建议光标位置，无副作用。
 */
export function deleteRange(
  lines: string[],
  startLi: number,
  startOffset: number,
  endLi: number,
  endOffset: number,
): LineEditResult {
  return insertTextAtRange(lines, startLi, startOffset, endLi, endOffset, '');
}

/**
 * Enter：在 (li, offset) 处把该行拆成两行。
 * 输入：当前 lines、拆分位置；输出：新 lines 与建议光标位置（落在新行行首），
 * 无副作用。
 */
export function splitLineAt(lines: string[], li: number, offset: number): LineEditResult {
  return insertTextAtRange(lines, li, offset, li, offset, '\n');
}

/**
 * Backspace（行首）：把第 li 行并入上一行末尾。
 * 输入：当前 lines、当前行号；输出：新 lines 与建议光标位置；当 li 是第一行
 * （无上一行可并）时返回 null，无副作用。
 */
export function mergeWithPrevious(lines: string[], li: number): LineEditResult | null {
  if (li <= 0 || li >= lines.length) return null;
  const prevLen = lines[li - 1].length;
  return deleteRange(lines, li - 1, prevLen, li, 0);
}

/**
 * Delete（行尾）：把第 li+1 行并入第 li 行末尾。
 * 输入：当前 lines、当前行号；输出：新 lines 与建议光标位置；当 li 是最后一行
 * （无下一行可并）时返回 null，无副作用。
 */
export function mergeWithNext(lines: string[], li: number): LineEditResult | null {
  if (li < 0 || li >= lines.length - 1) return null;
  const curLen = lines[li].length;
  return deleteRange(lines, li, curLen, li + 1, 0);
}

/** 可编辑行（`.et`）上标记工作区行号的 data 属性选择器。 */
const EDITABLE_ROW_SELECTOR = '[data-li]';

/**
 * 按 DOM 顺序读取容器内所有可编辑行（`[data-li]`）的纯文本，重建 `lines`
 * 数组；只在非组合期的 `input` 事件里调用。
 * 输入：包含若干行元素的容器；输出：字符串数组（无匹配行时为空数组）。
 */
export function readAllLines(container: HTMLElement, rowSelector = EDITABLE_ROW_SELECTOR): string[] {
  const rows = Array.from(container.querySelectorAll<HTMLElement>(rowSelector));
  return rows.map((el) => el.textContent ?? '');
}

/** 递归计算一个 DOM 节点（含子树）展开后的纯文本长度。 */
function textLength(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return (node as Text).data.length;
  let len = 0;
  node.childNodes.forEach((child) => {
    len += textLength(child);
  });
  return len;
}

/** 在一个元素内按纯文本偏移量定位到具体的文本节点与节点内偏移。 */
function locateTextOffset(root: Node, offset: number): { node: Node; offset: number } {
  if (root.nodeType === Node.TEXT_NODE) {
    return { node: root, offset: clampOffset((root as Text).data, offset) };
  }
  let remaining = offset;
  const children = Array.from(root.childNodes);
  for (const child of children) {
    const len = textLength(child);
    if (remaining <= len) {
      return locateTextOffset(child, remaining);
    }
    remaining -= len;
  }
  if (children.length > 0) {
    const last = children[children.length - 1];
    return locateTextOffset(last, textLength(last));
  }
  return { node: root, offset: 0 };
}

/** 反向计算：给定行元素内某个后代节点+节点内偏移，换算成该行的纯文本偏移量。 */
function computeTextOffset(root: Node, targetNode: Node, targetNodeOffset: number): number {
  let total = 0;
  function walk(node: Node): boolean {
    if (node === targetNode) {
      if (node.nodeType === Node.TEXT_NODE) {
        total += clampOffset((node as Text).data, targetNodeOffset);
      } else {
        const children = Array.from(node.childNodes);
        for (let k = 0; k < targetNodeOffset && k < children.length; k++) {
          total += textLength(children[k]);
        }
      }
      return true;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      total += (node as Text).data.length;
      return false;
    }
    for (const child of Array.from(node.childNodes)) {
      if (walk(child)) return true;
    }
    return false;
  }
  walk(root);
  return total;
}

/** 从容器内某个节点向上找到最近的可编辑行元素（携带 `data-li`）。 */
function closestEditableRow(container: HTMLElement, node: Node | null): HTMLElement | null {
  let cur: Node | null = node;
  while (cur && cur !== container) {
    if (cur instanceof HTMLElement && cur.dataset.li !== undefined) return cur;
    cur = cur.parentNode;
  }
  return null;
}

/** 找到某个非可编辑行（`.er` 包裹）在给定方向上最近的可编辑行元素。 */
function nearestEditableRow(
  container: HTMLElement,
  fromNode: Node | null,
  direction: 'forward' | 'backward',
): HTMLElement | null {
  let cur: Node | null = fromNode;
  while (cur && cur !== container && !(cur instanceof HTMLElement && cur.classList.contains('er'))) {
    cur = cur.parentNode;
  }
  const rowWrapper = cur instanceof HTMLElement ? cur : null;
  if (!rowWrapper) return null;
  let sibling: Element | null =
    direction === 'forward' ? rowWrapper.nextElementSibling : rowWrapper.previousElementSibling;
  while (sibling) {
    const editable = sibling.matches(EDITABLE_ROW_SELECTOR)
      ? (sibling as HTMLElement)
      : sibling.querySelector<HTMLElement>(EDITABLE_ROW_SELECTOR);
    if (editable) return editable;
    sibling = direction === 'forward' ? sibling.nextElementSibling : sibling.previousElementSibling;
  }
  return null;
}

/**
 * 读取当前光标（折叠选区）所在的行号（li）与行内偏移；若光标落在不可编辑
 * （删除）行内，或没有选区，返回 null。
 * 输入：容器元素；输出：`{li, offset}` 或 null，读取 `window.getSelection()`，
 * 无写入副作用。
 */
export function getCaretPosition(container: HTMLElement): { li: number; offset: number } | null {
  const range = getSelectionRangeRaw();
  if (!range) return null;
  const rowEl = closestEditableRow(container, range.startContainer);
  if (!rowEl) return null;
  const li = Number(rowEl.dataset.li);
  if (Number.isNaN(li)) return null;
  const offset = computeTextOffset(rowEl, range.startContainer, range.startOffset);
  return { li, offset };
}

/** 读取当前 `window.getSelection()` 的第一个 Range，没有选区时返回 null。 */
function getSelectionRangeRaw(): Range | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  return selection.getRangeAt(0);
}

/**
 * 把当前选区（可能折叠、可能跨行）映射为 `{startLi,startOffset,endLi,endOffset}`；
 * 若某一端落在不可编辑（删除）行内，向最近的可编辑行收敛（起点向后找，终点向
 * 前找）；两端都找不到可编辑行时返回 null。
 * 输入：容器元素；输出：映射后的选区四元组或 null，只读 `window.getSelection()`。
 */
export function getSelectionRange(
  container: HTMLElement,
): { startLi: number; startOffset: number; endLi: number; endOffset: number } | null {
  const range = getSelectionRangeRaw();
  if (!range) return null;
  let startRow = closestEditableRow(container, range.startContainer);
  let startOffset = startRow ? computeTextOffset(startRow, range.startContainer, range.startOffset) : 0;
  if (!startRow) {
    startRow = nearestEditableRow(container, range.startContainer, 'forward');
    startOffset = 0;
  }
  let endRow = closestEditableRow(container, range.endContainer);
  let endOffset = endRow ? computeTextOffset(endRow, range.endContainer, range.endOffset) : 0;
  if (!endRow) {
    endRow = nearestEditableRow(container, range.endContainer, 'backward');
    endOffset = endRow ? (endRow.textContent ?? '').length : 0;
  }
  if (!startRow || !endRow) return null;
  return {
    startLi: Number(startRow.dataset.li),
    startOffset,
    endLi: Number(endRow.dataset.li),
    endOffset,
  };
}

/**
 * 把光标设置到第 li 行的第 offset 个字符处（跨越该行内任意层级的子节点，比如
 * 字符级高亮产生的 `<span>`）；找不到对应行时静默放弃。
 * 输入：容器元素、目标 li/offset；输出：无（写入 `window.getSelection()`）。
 */
export function setCaretPosition(container: HTMLElement, li: number, offset: number): void {
  const el = container.querySelector<HTMLElement>(`[data-li="${li}"]`);
  if (!el) return;
  const { node, offset: localOffset } = locateTextOffset(el, offset);
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.setStart(node, localOffset);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}
