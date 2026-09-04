/**
 * 知识库管理 · 变基逐篇合并对话框（US3，T058）：纯组件，不调用任何 API。
 *
 * 输入单篇文档的变基冲突 `RebaseConflictDocument`（`blocks[]`，每块含
 * `base_lines`/`ours_lines`/`theirs_lines`/`context_before`/`context_after`，见
 * data-model.md §5），按块渲染两栏对照（草稿 / 正式版）与四种选择（采用草稿 /
 * 采用正式版 / 两者都保留 / 编辑此段）；底部「合并结果」把每块的 `context_before`
 * + 该块当前解决方式对应的正文 + `context_after` 依次拼接——未解决的块保留纯 Git
 * 冲突标记（`<<<<<<<` / `=======` / `>>>>>>>`，不带本地化标签，见
 * `composeBlockSegment` 注释），已解决的块直接
 * 给出正文；结果区始终可手动编辑（编辑后即接管展示，不再跟随按钮重算），仍有
 * 残留标记时「完成」禁用。完成时输出 `{lineageId, contentMd}`（与
 * `api/knowledgeAdmin.ts` 的 `RebaseResolution` 同形，供 `RebaseDialog` 收集后一并
 * 提交 `resolveRebase`）。
 */

import { useEffect, useMemo, useState } from 'react';

import { Dialog, DialogContent, DialogTitle, Textarea } from '@/components/ui';
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
 * 未解决块的占位写法：只用**纯 Git 冲突标记**，不带任何本地化标签。
 *
 * 这段文本会经 `onComplete` 原样进入 `resolveRebase` 的 `content_md`，是要落库的
 * **文档正文**，不是界面文案——之前把「草稿」/「正式版」两个产品译文拼进标记行
 * （`<<<<<<< 草稿`），等于把 UI 语言写进了知识库内容，而且后端
 * （`backend/app/knowledge/rebase.py::_has_conflict_markers`）识别的是行首锚定的
 * `<<<<<<<` / `=======` / `>>>>>>>` 本身。哪一侧是草稿、哪一侧是正式版由上方两栏
 * 对照（各自带本地化列头）说明，正文里不需要再重复一遍。
 */
function composeBlockSegment(block: RebaseConflictBlock, resolution: BlockResolution): string {
  const oursText = block.ours_lines.join('\n');
  const theirsText = block.theirs_lines.join('\n');
  if (resolution === 'ours') return oursText;
  if (resolution === 'theirs') return theirsText;
  if (resolution === 'both') return [oursText, theirsText].filter((part) => part.length > 0).join('\n');
  return [MARKER_START, oursText, MARKER_MID, theirsText, MARKER_END].join('\n');
}

function composeDocument(conflict: RebaseConflictDocument, resolutions: BlockResolution[]): string {
  return conflict.blocks
    .map((block, index) => {
      const segments = [
        ...block.context_before,
        composeBlockSegment(block, resolutions[index] ?? 'unresolved'),
        ...block.context_after,
      ];
      return segments.join('\n');
    })
    .join('\n');
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

  const composed = useMemo(() => composeDocument(conflict, resolutions), [conflict, resolutions]);
  const displayText = manualText ?? composed;
  const unresolved = hasConflictMarkers(displayText);

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
        <DialogTitle className="px-[24px] pt-[20px] pb-[12px] text-[16px] font-semibold text-[#18181a]">
          {t('knowledgeAdmin.merge.title', { title: conflict.title })}
        </DialogTitle>
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
            {unresolved && (
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
