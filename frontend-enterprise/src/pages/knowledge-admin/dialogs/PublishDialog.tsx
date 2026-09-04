/**
 * 知识库管理 · 发布草稿对话框：内容 Tab 与版本 Tab 共用。
 *
 * 标题「发布草稿 X → vNext」；version 递进下拉（patch 默认/minor/major）用
 * `next_version_preview` 显示结果号；展示 `metadata.review` 审阅状态。非 stale
 * 只有一个确认按钮；stale（`is_stale`）时改用 `against=published` 的版本对比
 * 摘要作为「冲突数」提示，并给出变基（推荐，`onRebase` 回调，变基本身属于
 * US3 范围）/ 仍然覆盖发布 / 取消三个按钮。
 *
 * T085（FR-050 二次确认）：点击「仍然覆盖发布」不直接提交，先切换到内联的
 * `overwriteStep` 二次确认视图，说明将丢弃自草稿基线以来其他人已发布的变更；
 * 只有勾选「已了解」（`overwriteAck`）后点击「确认覆盖」才真正发送
 * `force_overwrite=true`；「返回」放弃二次确认、回到 stale 选择视图。
 */

import { useEffect, useState } from 'react';

import { Checkbox, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea } from '@/components/ui';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { useAppIntl } from '@/i18n';
import { DIALOG_CANCEL_BUTTON_CLASS, DIALOG_FOOTER_CLASS, DIALOG_PRIMARY_BUTTON_CLASS } from '@/lib/enterprise-ui';
import { VersionLevel } from '@/enums/knowledge';
import type { KnowledgeAdminApi } from '@/api/knowledgeAdmin';
import type { KnowledgeAdminVersionRead, VersionDiff } from '@/types/knowledgeAdmin';

import { formatVersion, nextVersionLabel } from '../knowledgeAdminModel';

export type PublishDialogSubmitInput = {
  level: VersionLevel;
  changeReason: string;
  forceOverwrite: boolean;
};

export type PublishDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  api: KnowledgeAdminApi;
  kbId: string;
  draft: KnowledgeAdminVersionRead | null;
  /** 当前正式版本号（`kb.published_version`）；stale 二次确认文案用于说明将丢弃哪个已发布版本的变更。 */
  publishedVersion?: string | null;
  submitting?: boolean;
  onSubmit: (input: PublishDialogSubmitInput) => void;
  /** stale 分支「变基」按钮回调；变基对话框本身属于 US3，这里只负责转发。 */
  onRebase?: (versionId: string) => void;
  /** 「去审阅」链接回调；由调用方决定关闭本对话框并打开审阅编辑器。 */
  onReview?: () => void;
};

function reviewCounts(draft: KnowledgeAdminVersionRead | null): { staged: number; pending: number } {
  const review = (draft?.metadata as { review?: { staged?: number; pending?: number } } | undefined)?.review;
  return { staged: review?.staged ?? 0, pending: review?.pending ?? 0 };
}

/** 发布确认框：非 stale 单按钮确认；stale 时展示冲突数与变基/仍然覆盖发布/取消三个按钮，「仍然覆盖发布」需内联二次确认后才真正提交。 */
export function PublishDialog({
  open,
  onOpenChange,
  api,
  kbId,
  draft,
  publishedVersion,
  submitting = false,
  onSubmit,
  onRebase,
  onReview,
}: PublishDialogProps) {
  const { t } = useAppIntl();
  const [level, setLevel] = useState<VersionLevel>(VersionLevel.Patch);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState(false);
  const [staleDiff, setStaleDiff] = useState<VersionDiff | null>(null);
  /** T085：是否已进入「仍然覆盖发布」的内联二次确认视图。 */
  const [overwriteStep, setOverwriteStep] = useState(false);
  /** T085：二次确认勾选框「已了解将丢弃这些变更」的选中状态。 */
  const [overwriteAck, setOverwriteAck] = useState(false);

  useEffect(() => {
    if (open) {
      setLevel(VersionLevel.Patch);
      setReason('');
      setReasonError(false);
      setStaleDiff(null);
      setOverwriteStep(false);
      setOverwriteAck(false);
    }
  }, [open, draft?.id]);

  useEffect(() => {
    if (!open || !draft?.is_stale) return;
    let cancelled = false;
    void api.getVersionDiff(kbId, draft.id, { against: 'published' }).then(
      (result) => {
        if (!cancelled) setStaleDiff(result);
      },
      () => {
        // 冲突数拉取失败不阻塞发布框本身（stale 警示与"变基/仍然覆盖发布"选项照常
        // 展示），但必须显式吞掉——之前没有 rejection handler，一次失败就是一条
        // unhandled rejection。`staleDiff` 保持 null，`conflictCount` 因此为 0，
        // 属于已知的低估（见 final-fix 报告的遗留项）。
        if (!cancelled) setStaleDiff(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, draft?.id, draft?.is_stale, api, kbId]);

  if (!draft) return null;

  const preview = draft.next_version_preview;
  const nextVersion = preview ? preview[level] : nextVersionLabel(draft.base_version, level);
  const { staged, pending } = reviewCounts(draft);
  const conflictCount = staleDiff ? staleDiff.summary.added + staleDiff.summary.modified + staleDiff.summary.deleted : 0;

  function handleConfirm(forceOverwrite: boolean) {
    const trimmed = reason.trim();
    if (!trimmed) {
      setReasonError(true);
      return;
    }
    onSubmit({ level, changeReason: trimmed, forceOverwrite });
  }

  /** T085：放弃二次确认，回到 stale 选择视图（变基 / 仍然覆盖发布 / 取消）。 */
  function handleOverwriteBack() {
    setOverwriteStep(false);
    setOverwriteAck(false);
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
      <DialogContent className="w-[min(520px,calc(100vw-32px))] gap-0 overflow-hidden rounded-[16px] border-0 bg-white p-0 shadow-[0px_12px_32px_rgba(0,0,0,0.16)]">
        <DialogTitle className="px-[24px] pt-[20px] pb-[12px] text-[16px] font-semibold text-[#18181a]">
          {t('knowledgeAdmin.dialogs.publish.title', { draft: draft.draft_name || draft.version, next: formatVersion(nextVersion) })}
        </DialogTitle>
        <div className="flex flex-col gap-[16px] px-[24px] pb-[16px]">
          <div className="flex flex-col gap-[6px]">
            <span className="text-[12px] font-medium text-[#464c5e]">{t('knowledgeAdmin.dialogs.publish.levelLabel')}</span>
            <Select value={level} onValueChange={(value) => setLevel(value as VersionLevel)} disabled={submitting}>
              <SelectTrigger className="w-full" aria-label={t('knowledgeAdmin.dialogs.publish.levelLabel')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={VersionLevel.Patch}>{t('knowledgeAdmin.dialogs.publish.levelPatch')} ({formatVersion(preview?.patch ?? nextVersionLabel(draft.base_version, VersionLevel.Patch))})</SelectItem>
                <SelectItem value={VersionLevel.Minor}>{t('knowledgeAdmin.dialogs.publish.levelMinor')} ({formatVersion(preview?.minor ?? nextVersionLabel(draft.base_version, VersionLevel.Minor))})</SelectItem>
                <SelectItem value={VersionLevel.Major}>{t('knowledgeAdmin.dialogs.publish.levelMajor')} ({formatVersion(preview?.major ?? nextVersionLabel(draft.base_version, VersionLevel.Major))})</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <p className="text-[12px] text-[#464c5e]">
            {t('knowledgeAdmin.dialogs.publish.reviewStatus', { staged, pending })}
            {onReview && (
              <button
                type="button"
                className="ml-[8px] text-[#1a71ff] underline"
                onClick={onReview}
              >
                {t('knowledgeAdmin.dialogs.publish.reviewLink')}
              </button>
            )}
          </p>

          <div className="flex flex-col gap-[6px]">
            <span className="text-[12px] font-medium text-[#464c5e]">{t('knowledgeAdmin.dialogs.publish.reasonLabel')}</span>
            <Textarea
              value={reason}
              disabled={submitting}
              aria-invalid={reasonError}
              aria-label={t('knowledgeAdmin.dialogs.publish.reasonLabel')}
              placeholder={t('knowledgeAdmin.dialogs.publish.reasonPlaceholder')}
              onChange={(event) => {
                setReason(event.target.value);
                setReasonError(false);
              }}
            />
            {reasonError && (
              <span role="alert" className="text-[12px] text-[#d20b0b]">
                {t('knowledgeAdmin.dialogs.publish.reasonRequired')}
              </span>
            )}
          </div>

          {draft.is_stale && (
            <p role="alert" className="rounded-[10px] bg-[#fce7e7] px-[12px] py-[8px] text-[12px] text-[#d20b0b]">
              {t('knowledgeAdmin.dialogs.publish.staleNotice', { count: conflictCount })}
            </p>
          )}

          {draft.is_stale && overwriteStep && (
            <div className="flex flex-col gap-[10px] rounded-[10px] border border-[#f3b4b4] bg-[#fef4f4] px-[12px] py-[10px]">
              <p className="text-[12px] text-[#d20b0b]">
                {t('knowledgeAdmin.dialogs.publish.overwriteConfirmDescription', {
                  published: formatVersion(publishedVersion),
                  base: formatVersion(draft.base_version),
                  count: conflictCount,
                })}
              </p>
              <label className="flex items-center gap-[8px] text-[12px] text-[#18181a]">
                <Checkbox
                  aria-label={t('knowledgeAdmin.dialogs.publish.overwriteConfirmCheckbox')}
                  checked={overwriteAck}
                  disabled={submitting}
                  onCheckedChange={(checked) => setOverwriteAck(checked === true)}
                />
                {t('knowledgeAdmin.dialogs.publish.overwriteConfirmCheckbox')}
              </label>
            </div>
          )}
        </div>
        <div className={DIALOG_FOOTER_CLASS}>
          {draft.is_stale && overwriteStep ? (
            <>
              <Button variant="outline" disabled={submitting} onClick={handleOverwriteBack} className={DIALOG_CANCEL_BUTTON_CLASS}>
                {t('knowledgeAdmin.dialogs.publish.back')}
              </Button>
              <Button
                disabled={submitting || !overwriteAck}
                onClick={() => handleConfirm(true)}
                className="h-[32px] min-w-[80px] rounded-[10px] bg-[#d20b0b] px-[12px] text-[14px] font-normal text-white hover:bg-[#b80909]"
              >
                {t('knowledgeAdmin.dialogs.publish.overwriteConfirmButton')}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" disabled={submitting} onClick={() => onOpenChange(false)} className={DIALOG_CANCEL_BUTTON_CLASS}>
                {t('knowledgeAdmin.dialogs.publish.cancel')}
              </Button>
              {draft.is_stale ? (
                <>
                  <Button
                    variant="outline"
                    disabled={submitting}
                    onClick={() => onRebase?.(draft.id)}
                    className={DIALOG_CANCEL_BUTTON_CLASS}
                  >
                    {t('knowledgeAdmin.dialogs.publish.rebase')}
                  </Button>
                  <Button
                    disabled={submitting}
                    onClick={() => setOverwriteStep(true)}
                    className="h-[32px] min-w-[80px] rounded-[10px] bg-[#d20b0b] px-[12px] text-[14px] font-normal text-white hover:bg-[#b80909]"
                  >
                    {t('knowledgeAdmin.dialogs.publish.forceOverwrite')}
                  </Button>
                </>
              ) : (
                <Button disabled={submitting} onClick={() => handleConfirm(false)} className={DIALOG_PRIMARY_BUTTON_CLASS}>
                  {t('knowledgeAdmin.dialogs.publish.confirm')}
                </Button>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
