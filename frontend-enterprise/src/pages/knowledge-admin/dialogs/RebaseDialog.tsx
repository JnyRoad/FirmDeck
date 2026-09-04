/**
 * 知识库管理 · 变基对话框（US3，T059）：从 `PublishDialog` 的「变基（推荐）」按钮
 * 或版本 Tab 打开，编排 A3/A4 两步接口与 `MergeDialog`。
 *
 * 流程：填写变基原因 → 调 `rebaseDraft`（A3）；服务端无冲突时已直接落库并返回
 * `RebaseResult`，本组件直接回调 `onRebased` 并关闭；有冲突时返回
 * `RebasePreview`（`conflicts` 非空、不落库），列出「可自动合并」与「冲突」文档，
 * 逐篇点开 `MergeDialog` 收集 `{lineageId, contentMd}`；全部解决后调
 * `resolveRebase`（A4）。若提交时正式版又变化（`KNOWLEDGE_PUBLISH_CONFLICT`），
 * 提示需要重新预览并提供「重新预览」按钮重新调用 `rebaseDraft`（沿用同一变基
 * 原因），不吞掉已收集的其它冲突解决——重新预览会拿到最新的 `RebasePreview`，
 * 之前的 `resolutions` 按 lineage_id 沿用（若该篇在新预览中不再冲突则自然被
 * 忽略，若仍冲突则跳过重新打开合并框，直接复用已解决内容）。
 */

import { useEffect, useState } from 'react';

import { Dialog, DialogContent, DialogTitle, Textarea } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { notify } from '@/components/ui/app-toast';
import { useAppIntl } from '@/i18n';
import { RawContent } from '@/i18n/RawContent';
import { apiErrorCode } from '@/lib/apiErrorMessages';
import { DIALOG_CANCEL_BUTTON_CLASS, DIALOG_FOOTER_CLASS, DIALOG_PRIMARY_BUTTON_CLASS, OUTLINE_ACTION_BUTTON_SM_CLASS } from '@/lib/enterprise-ui';
import type { KnowledgeAdminApi, RebaseResolution } from '@/api/knowledgeAdmin';
import type { KnowledgeAdminVersionRead, RebaseConflictDocument, RebasePreview, RebaseResult } from '@/types/knowledgeAdmin';

import { knowledgeAdminErrorMessage } from '../shared/errorMessage';
import { MergeDialog } from './MergeDialog';

export type RebaseDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  api: KnowledgeAdminApi;
  kbId: string;
  draft: KnowledgeAdminVersionRead | null;
  /** 变基落库成功（无冲突直接落库，或解决冲突后落库）时回调，携带新草稿快照。 */
  onRebased: (result: RebaseResult) => void;
};

function isRebaseResult(value: RebasePreview | RebaseResult): value is RebaseResult {
  return 'new_version' in value;
}

/** 变基对话框：编排预览（A3）→ 逐篇合并（MergeDialog）→ 提交解决（A4）。 */
export function RebaseDialog({ open, onOpenChange, api, kbId, draft, onRebased }: RebaseDialogProps) {
  const { t } = useAppIntl();

  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [preview, setPreview] = useState<RebasePreview | null>(null);
  const [resolutions, setResolutions] = useState<Record<string, string>>({});
  const [activeConflict, setActiveConflict] = useState<RebaseConflictDocument | null>(null);
  const [staleAgain, setStaleAgain] = useState(false);

  useEffect(() => {
    if (open) {
      setReason('');
      setReasonError(false);
      setSubmitting(false);
      setPreview(null);
      setResolutions({});
      setActiveConflict(null);
      setStaleAgain(false);
    }
  }, [open, draft?.id]);

  if (!draft) return null;

  async function runPreview(changeReason: string) {
    setSubmitting(true);
    try {
      const result = await api.rebaseDraft(kbId, draft!.id, { changeReason });
      if (isRebaseResult(result)) {
        notify.successText(t('knowledgeAdmin.toast.rebaseSuccess'));
        onRebased(result);
        onOpenChange(false);
        return;
      }
      setPreview(result);
      setResolutions({});
      setActiveConflict(null);
      setStaleAgain(false);
    } catch (error) {
      notify.error(knowledgeAdminErrorMessage(error, 'knowledgeAdmin.toast.updateError', { t }));
    } finally {
      setSubmitting(false);
    }
  }

  function handleStart() {
    const trimmed = reason.trim();
    if (!trimmed) {
      setReasonError(true);
      return;
    }
    void runPreview(trimmed);
  }

  async function handleCompleteRebase() {
    if (!preview) return;
    const trimmed = reason.trim();
    const resolutionList: RebaseResolution[] = preview.conflicts.map((conflict) => ({
      lineageId: conflict.lineage_id,
      contentMd: resolutions[conflict.lineage_id],
    }));
    setSubmitting(true);
    try {
      const result = await api.resolveRebase(kbId, draft!.id, {
        changeReason: trimmed,
        toBaseVersionId: preview.to_base_version_id,
        resolutions: resolutionList,
      });
      notify.successText(t('knowledgeAdmin.toast.rebaseSuccess'));
      onRebased(result);
      onOpenChange(false);
    } catch (error) {
      if (apiErrorCode(error) === 'KNOWLEDGE_PUBLISH_CONFLICT') {
        setStaleAgain(true);
      } else {
        notify.error(knowledgeAdminErrorMessage(error, 'knowledgeAdmin.toast.updateError', { t }));
      }
    } finally {
      setSubmitting(false);
    }
  }

  function handleRetryPreview() {
    setStaleAgain(false);
    void runPreview(reason.trim());
  }

  const allResolved = Boolean(preview) && preview!.conflicts.every((conflict) => conflict.lineage_id in resolutions);

  return (
    <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
      <DialogContent className="w-[min(560px,calc(100vw-32px))] gap-0 overflow-hidden rounded-[16px] border-0 bg-white p-0 shadow-[0px_12px_32px_rgba(0,0,0,0.16)]">
        <DialogTitle className="px-[24px] pt-[20px] pb-[12px] text-[16px] font-semibold text-[#18181a]">
          {t('knowledgeAdmin.rebase.title', { draft: draft.draft_name || draft.version })}
        </DialogTitle>

        {!preview ? (
          <div className="flex flex-col gap-[12px] px-[24px] pb-[16px]">
            <p className="text-[12px] text-[#858b9c]">{t('knowledgeAdmin.rebase.intro')}</p>
            <div className="flex flex-col gap-[6px]">
              <span className="text-[12px] font-medium text-[#464c5e]">{t('knowledgeAdmin.rebase.reasonLabel')}</span>
              <Textarea
                value={reason}
                disabled={submitting}
                aria-invalid={reasonError}
                aria-label={t('knowledgeAdmin.rebase.reasonLabel')}
                placeholder={t('knowledgeAdmin.rebase.reasonPlaceholder')}
                onChange={(event) => {
                  setReason(event.target.value);
                  setReasonError(false);
                }}
              />
              {reasonError && (
                <span role="alert" className="text-[12px] text-[#d20b0b]">
                  {t('knowledgeAdmin.rebase.reasonRequired')}
                </span>
              )}
            </div>
          </div>
        ) : (
          <div className="flex max-h-[60vh] flex-col gap-[12px] overflow-y-auto px-[24px] pb-[16px]">
            {preview.auto_merged.length > 0 && (
              <div className="flex flex-col gap-[6px]">
                <span className="text-[12px] font-medium text-[#464c5e]">{t('knowledgeAdmin.rebase.autoMerged')}</span>
                <ul className="flex flex-col gap-[4px]">
                  {preview.auto_merged.map((document) => (
                    <li key={document.lineage_id} className="rounded-[10px] bg-[#f7f8fa] px-[10px] py-[6px] text-[12px] text-[#464c5e]">
                      <RawContent value={document.title} />
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {preview.conflicts.length > 0 && (
              <div className="flex flex-col gap-[6px]">
                <span className="text-[12px] font-medium text-[#464c5e]">{t('knowledgeAdmin.rebase.conflict')}</span>
                <ul className="flex flex-col gap-[4px]">
                  {preview.conflicts.map((conflict) => {
                    const resolved = conflict.lineage_id in resolutions;
                    return (
                      <li
                        key={conflict.lineage_id}
                        className="flex items-center justify-between gap-[8px] rounded-[10px] bg-[#fce7e7] px-[10px] py-[6px] text-[12px] text-[#464c5e]"
                      >
                        <RawContent value={conflict.title} />
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => setActiveConflict(conflict)}
                          className={OUTLINE_ACTION_BUTTON_SM_CLASS}
                        >
                          {t(resolved ? 'knowledgeAdmin.rebase.actions.reopenMerge' : 'knowledgeAdmin.rebase.actions.openMerge')}
                        </Button>
                      </li>
                    );
                  })}
                </ul>
                <p className="text-[12px] text-[#858b9c]">
                  {t('knowledgeAdmin.rebase.conflictProgress', {
                    resolved: Object.keys(resolutions).length,
                    total: preview.conflicts.length,
                  })}
                </p>
              </div>
            )}

            {preview.conflicts.length === 0 && (
              <p className="text-[12px] text-[#858b9c]">{t('knowledgeAdmin.rebase.noConflicts')}</p>
            )}

            {staleAgain && (
              <p role="alert" className="flex flex-wrap items-center gap-[8px] rounded-[10px] bg-[#fce7e7] px-[12px] py-[8px] text-[12px] text-[#d20b0b]">
                {t('knowledgeAdmin.rebase.staleAgain')}
                <Button
                  type="button"
                  variant="outline"
                  disabled={submitting}
                  onClick={handleRetryPreview}
                  className={OUTLINE_ACTION_BUTTON_SM_CLASS}
                >
                  {t('knowledgeAdmin.rebase.actions.retryPreview')}
                </Button>
              </p>
            )}
          </div>
        )}

        <div className={DIALOG_FOOTER_CLASS}>
          <Button variant="outline" disabled={submitting} onClick={() => onOpenChange(false)} className={DIALOG_CANCEL_BUTTON_CLASS}>
            {t('knowledgeAdmin.rebase.actions.cancel')}
          </Button>
          {!preview ? (
            <Button disabled={submitting} onClick={handleStart} className={DIALOG_PRIMARY_BUTTON_CLASS}>
              {t('knowledgeAdmin.rebase.actions.start')}
            </Button>
          ) : (
            <Button
              disabled={submitting || !allResolved}
              onClick={() => void handleCompleteRebase()}
              className={DIALOG_PRIMARY_BUTTON_CLASS}
            >
              {t('knowledgeAdmin.rebase.actions.complete')}
            </Button>
          )}
        </div>
      </DialogContent>

      {activeConflict && (
        <MergeDialog
          open={Boolean(activeConflict)}
          onOpenChange={(next) => !next && setActiveConflict(null)}
          conflict={activeConflict}
          onComplete={(result) => {
            setResolutions((prev) => ({ ...prev, [result.lineageId]: result.contentMd }));
            setActiveConflict(null);
          }}
        />
      )}
    </Dialog>
  );
}
