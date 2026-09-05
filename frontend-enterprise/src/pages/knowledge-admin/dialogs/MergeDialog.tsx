/**
 * 知识库管理 · 变基逐篇合并对话框（US3，T058）：纯组件，不调用任何 API。
 *
 * 输入单篇文档的变基冲突 `RebaseConflictDocument`：`merged_text` 是后端算好的
 * **完整三方合并文本**（无冲突的 hunk 已合并到位，每处冲突保留成行锚定的 Git 冲突区
 * `<<<<<<< ours` / `=======` / `>>>>>>> theirs`），`blocks[i]` 与其中第 i 个冲突区
 * 一一对应，含 `base_lines`/`ours_lines`/`theirs_lines`/`context_before`/`context_after`
 * （见 data-model.md §5）。
 *
 * 上半部分按 `blocks[i]` 渲染两栏对照（草稿 / 正式版）与四种选择（采用草稿 /
 * 采用正式版 / 两者都保留 / 编辑此段）；底部「合并结果」**始终以 `merged_text` 为底稿**，
 * 只把第 i 个冲突区整体替换成该块所选一侧的正文，未解决的冲突区原样留着等人工编辑。
 *
 * 这一点是数据完整性要求，不是实现细节：旧实现按块拼
 * `context_before + 正文 + context_after`，冲突区之外（首块之前、末块之后、相隔较远的
 * 两块之间）的正文会被整段丢掉，相邻两块共享的上下文还会被重复写入一次，而这段文本
 * 会原样经 `onComplete` → `resolveRebase(content_md)` 落库。
 *
 * 结果区始终可手动编辑（编辑的是整篇全文；编辑后即接管展示，不再跟随按钮重算），仍有
 * 残留标记时「完成」禁用。完成时输出 `{lineageId, contentMd}`（与
 * `api/knowledgeAdmin.ts` 的 `RebaseResolution` 同形，供 `RebaseDialog` 收集后一并
 * 提交 `resolveRebase`）。
 */

import { useEffect, useMemo, useState } from 'react';

import { Dialog, DialogContent, DialogDescription, DialogTitle, Textarea } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { useAppIntl } from '@/i18n';
import { RawContent } from '@/i18n/RawContent';
import { DIALOG_CANCEL_BUTTON_CLASS, DIALOG_FOOTER_CLASS, DIALOG_PRIMARY_BUTTON_CLASS } from '@/lib/enterprise-ui';
import type { RebaseResolution } from '@/api/knowledgeAdmin';
import type { RebaseConflictBlock, RebaseConflictDocument } from '@/types/knowledgeAdmin';

export type MergeDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 单篇文档的变基冲突：`RebasePreview.conflicts[i]`。 */
  conflict: RebaseConflictDocument;
  /** 完成时输出该篇文档的最终合并结果，供 `RebaseDialog` 收集进 `resolutions[]`。 */
  onComplete: (result: RebaseResolution) => void;
};

type BlockResolution = 'unresolved' | 'ours' | 'theirs' | 'both';

const MARKER_START = '<<<<<<<';
const MARKER_MID = '=======';
const MARKER_END = '>>>>>>>';

function isMarkerLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed === MARKER_MID
    || trimmed === MARKER_START
    || trimmed.startsWith(`${MARKER_START} `)
    || trimmed === MARKER_END
    || trimmed.startsWith(`${MARKER_END} `)
  );
}

/** 按行锚定检查残留冲突标记，规则与 `backend/app/knowledge/rebase.py::_has_conflict_markers` 一致。 */
export function hasConflictMarkers(text: string): boolean {
  return text.split('\n').some(isMarkerLine);
}

/**
 * 已解决块要写回冲突区的正文行。
 *
 * 只用**纯 Git 冲突标记**、不带任何本地化标签：这段文本会经
 * `onComplete` 原样进入 `resolveRebase` 的 `content_md`，是要落库的**文档正文**，
 * 不是界面文案——之前把「草稿」/「正式版」两个产品译文拼进标记行（`<<<<<<< 草稿`），
 * 等于把 UI 语言写进了知识库内容，而且后端
 * （`backend/app/knowledge/rebase.py::_has_conflict_markers`）识别的是行首锚定的
 * `<<<<<<<` / `=======` / `>>>>>>>` 本身。哪一侧是草稿、哪一侧是正式版由上方两栏
 * 对照（各自带本地化列头）说明，正文里不需要再重复一遍。
 */
function composeBlockLines(block: RebaseConflictBlock, resolution: BlockResolution): string[] {
  if (resolution === 'ours') return block.ours_lines;
  if (resolution === 'theirs') return block.theirs_lines;
  if (resolution === 'both') return [...block.ours_lines, ...block.theirs_lines];
  return [MARKER_START, ...block.ours_lines, MARKER_MID, ...block.theirs_lines, MARKER_END];
}

/** `merged_text` 切出来的一段：普通正文，或一个完整的 Git 冲突区（含三行标记）。 */
type MergedSegment = { kind: 'text' | 'conflict'; lines: string[] };

/**
 * 把完整合并文本按**行锚定**的冲突标记切成「正文段 / 冲突区」序列，判定规则与
 * `isMarkerLine`（以及后端 `_has_conflict_markers`）一致。冲突区的行原样保留，
 * 未解决时直接写回结果，保证「未解决」这一态的文本与后端产出逐字节一致。
 * 末尾若出现未闭合的冲突区，整段仍按冲突区返回——残留标记会让「完成」保持禁用。
 */
export function parseMergedSegments(mergedText: string): MergedSegment[] {
  const segments: MergedSegment[] = [];
  let text: string[] = [];
  let conflict: string[] | null = null;

  const flushText = () => {
    if (text.length > 0) {
      segments.push({ kind: 'text', lines: text });
      text = [];
    }
  };

  for (const line of mergedText.split('\n')) {
    const trimmed = line.trim();
    if (conflict === null) {
      if (trimmed === MARKER_START || trimmed.startsWith(`${MARKER_START} `)) {
        flushText();
        conflict = [line];
      } else {
        text.push(line);
      }
      continue;
    }
    conflict.push(line);
    if (trimmed === MARKER_END || trimmed.startsWith(`${MARKER_END} `)) {
      segments.push({ kind: 'conflict', lines: conflict });
      conflict = null;
    }
  }
  if (conflict !== null) segments.push({ kind: 'conflict', lines: conflict });
  flushText();
  return segments;
}

/**
 * 以完整合并文本为底稿组装结果：正文段原样保留，第 i 个冲突区按 `resolutions[i]`
 * 替换成所选一侧的正文；未解决（或没有对应 block）的冲突区原样留下。
 *
 * `merged_text` 是 `RebaseConflictDocument` 的必填字段，调用方在合成前必须自行判断
 * 是否为空——本函数不再提供按 `blocks[]` ±2 行上下文拼接的降级底稿：那条路径会丢弃
 * 冲突区之外的正文（首块之前、末块之后、相隔较远的两块之间），是确认过的数据丢失
 * 缺陷，已随本次修复整体移除。
 */
export function composeDocument(conflict: RebaseConflictDocument, resolutions: BlockResolution[]): string {
  const mergedText = conflict.merged_text;
  const lines: string[] = [];
  let conflictIndex = -1;
  for (const segment of parseMergedSegments(mergedText)) {
    if (segment.kind === 'text') {
      lines.push(...segment.lines);
      continue;
    }
    conflictIndex += 1;
    const block = conflict.blocks[conflictIndex];
    const resolution = resolutions[conflictIndex] ?? 'unresolved';
    if (!block || resolution === 'unresolved') {
      lines.push(...segment.lines);
      continue;
    }
    lines.push(...composeBlockLines(block, resolution));
  }
  return lines.join('\n');
}

/** 变基逐篇合并对话框：不调 API，输入冲突文档、输出该篇的最终合并结果。 */
export function MergeDialog({ open, onOpenChange, conflict, onComplete }: MergeDialogProps) {
  const { t } = useAppIntl();
  const oursLabel = t('knowledgeAdmin.merge.columns.draft');
  const theirsLabel = t('knowledgeAdmin.merge.columns.published');

  const [resolutions, setResolutions] = useState<BlockResolution[]>(() => conflict.blocks.map(() => 'unresolved'));
  // 一旦用户直接编辑结果区，展示内容由该手动文本接管，不再随按钮点击自动重算，
  // 直到下一次按块操作（重新纳入自动拼接）或对话框重新打开。
  const [manualText, setManualText] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setResolutions(conflict.blocks.map(() => 'unresolved'));
      setManualText(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, conflict.lineage_id]);

  // `merged_text` 是必填字段，后端应始终下发；空字符串是畸形响应，不再按 `blocks[]`
  // ±2 行上下文拼接降级底稿（那条路径会丢正文），改为拒绝合成、提示错误并锁死「完成」。
  const mergedTextMissing = conflict.merged_text === '';

  useEffect(() => {
    if (open && mergedTextMissing) {
      // eslint-disable-next-line no-console
      console.error('[MergeDialog] conflict.merged_text is empty; refusing to compose a lossy fallback', conflict.lineage_id);
    }
  }, [open, mergedTextMissing, conflict.lineage_id]);

  const composed = useMemo(
    () => (mergedTextMissing ? '' : composeDocument(conflict, resolutions)),
    [conflict, resolutions, mergedTextMissing],
  );
  const displayText = manualText ?? composed;
  const unresolved = mergedTextMissing || hasConflictMarkers(displayText);

  function resolveBlock(index: number, value: BlockResolution) {
    setResolutions((prev) => prev.map((item, i) => (i === index ? value : item)));
    setManualText(null);
  }

  function handleComplete() {
    if (unresolved) return;
    onComplete({ lineageId: conflict.lineage_id, contentMd: displayText });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(760px,calc(100vw-32px))] gap-0 overflow-hidden rounded-[16px] border-0 bg-white p-0 shadow-[0px_12px_32px_rgba(0,0,0,0.16)]">
        <DialogTitle className="px-[24px] pt-[20px] pb-[8px] text-[16px] font-semibold text-[#18181a]">
          {t('knowledgeAdmin.merge.title', { title: conflict.title })}
        </DialogTitle>
        <DialogDescription className="px-[24px] pb-[12px] text-[12px] text-[#858b9c]">
          {t('knowledgeAdmin.merge.description')}
        </DialogDescription>
        <div className="flex max-h-[65vh] flex-col gap-[16px] overflow-y-auto px-[24px] pb-[16px]">
          {conflict.blocks.map((block, index) => (
            <div key={index} className="flex flex-col gap-[8px] rounded-[12px] border-[0.5px] border-[#e3e7f1] bg-[#f7f8fa] px-[14px] py-[12px]">
              <span className="text-[12px] font-medium text-[#464c5e]">
                {t('knowledgeAdmin.merge.blockLabel', { index: index + 1 })}
              </span>
              <div className="grid grid-cols-2 gap-[12px]">
                <div className="flex flex-col gap-[4px] rounded-[10px] border-[0.5px] border-[#e3e7f1] bg-white px-[10px] py-[8px]">
                  <span className="text-[11px] font-medium text-[#858b9c]">{oursLabel}</span>
                  <RawContent value={block.ours_lines.join('\n')} className="whitespace-pre-wrap text-[12px] text-[#18181a]" />
                </div>
                <div className="flex flex-col gap-[4px] rounded-[10px] border-[0.5px] border-[#e3e7f1] bg-white px-[10px] py-[8px]">
                  <span className="text-[11px] font-medium text-[#858b9c]">{theirsLabel}</span>
                  <RawContent value={block.theirs_lines.join('\n')} className="whitespace-pre-wrap text-[12px] text-[#18181a]" />
                </div>
              </div>
              <div className="flex flex-wrap gap-[8px]">
                <Button variant="outline" onClick={() => resolveBlock(index, 'ours')} className="h-[28px] rounded-[8px] px-[10px] text-[12px] font-normal">
                  {t('knowledgeAdmin.merge.actions.adoptOurs')}
                </Button>
                <Button variant="outline" onClick={() => resolveBlock(index, 'theirs')} className="h-[28px] rounded-[8px] px-[10px] text-[12px] font-normal">
                  {t('knowledgeAdmin.merge.actions.adoptTheirs')}
                </Button>
                <Button variant="outline" onClick={() => resolveBlock(index, 'both')} className="h-[28px] rounded-[8px] px-[10px] text-[12px] font-normal">
                  {t('knowledgeAdmin.merge.actions.keepBoth')}
                </Button>
                <Button variant="outline" onClick={() => resolveBlock(index, 'unresolved')} className="h-[28px] rounded-[8px] px-[10px] text-[12px] font-normal">
                  {t('knowledgeAdmin.merge.actions.editBlock')}
                </Button>
              </div>
            </div>
          ))}

          <div className="flex flex-col gap-[6px]">
            <span className="text-[12px] font-medium text-[#464c5e]">{t('knowledgeAdmin.merge.result.title')}</span>
            <Textarea
              value={displayText}
              aria-label={t('knowledgeAdmin.merge.result.title')}
              className="min-h-[160px] font-mono text-[12px]"
              onChange={(event) => setManualText(event.target.value)}
            />
            {mergedTextMissing && (
              <span role="alert" className="text-[12px] text-[#d20b0b]">
                {t('knowledgeAdmin.merge.result.mergedTextMissing')}
              </span>
            )}
            {!mergedTextMissing && unresolved && (
              <span role="alert" className="text-[12px] text-[#d20b0b]">
                {t('knowledgeAdmin.merge.result.unresolvedHint')}
              </span>
            )}
          </div>
        </div>
        <div className={DIALOG_FOOTER_CLASS}>
          <Button variant="outline" onClick={() => onOpenChange(false)} className={DIALOG_CANCEL_BUTTON_CLASS}>
            {t('knowledgeAdmin.merge.actions.cancel')}
          </Button>
          <Button disabled={unresolved} onClick={handleComplete} className={DIALOG_PRIMARY_BUTTON_CLASS}>
            {t('knowledgeAdmin.merge.actions.complete')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
