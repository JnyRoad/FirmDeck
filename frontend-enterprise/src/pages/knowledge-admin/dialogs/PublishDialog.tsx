/**
 * 知识库管理 · 发布草稿对话框：内容 Tab 与版本 Tab 共用。
 *
 * 标题「发布草稿 X → vNext」；version 递进下拉（patch 默认/minor/major）用
 * `next_version_preview` 显示结果号；展示 `metadata.review` 审阅状态。非 stale
 * 只有一个确认按钮；stale（`is_stale`）时改用 `against=published` 的版本对比
 * 摘要作为「冲突数」提示，并给出变基（推荐，`onRebase` 回调，变基本身属于
 * US3 范围）/ 仍然覆盖发布（`force_overwrite=true`）/ 取消三个按钮。
 */

import { useEffect, useState } from 'react';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea } from '@/components/ui';
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

/** 发布确认框：非 stale 单按钮确认；stale 时展示冲突数与变基/强制覆盖/取消三个按钮。 */
export function PublishDialog({
  open,
  onOpenChange,
  api,
  kbId,
  draft,
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

  useEffect(() => {
    if (open) {
      setLevel(VersionLevel.Patch);
      setReason('');
      setReasonError(false);
      setStaleDiff(null);
    }
  }, [open, draft?.id]);

  useEffect(() => {
    if (!open || !draft?.is_stale) return;
    let cancelled = false;
    void api.getVersionDiff(kbId, draft.id, { against: 'published' }).then((result) => {
      if (!cancelled) setStaleDiff(result);
    });
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
        </div>
        <div className={DIALOG_FOOTER_CLASS}>
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
                onClick={() => handleConfirm(true)}
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
        </div>
      </DialogContent>
    </Dialog>
  );
}
