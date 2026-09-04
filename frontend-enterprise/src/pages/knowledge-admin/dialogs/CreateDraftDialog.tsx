/**
 * 知识库管理 · 创建草稿对话框：共享库内容页与版本 Tab 共用。
 *
 * 来源上下文（FR-023）本应可选「管理员直连」或某个已绑定群组；但 API 层目前没有
 * 任何端点能按知识库 id 查出「已绑定到本库的群组列表」（`listBindableTeams` 只返回
 * 未绑定候选，`listTeamBindings` 反过来只能按团队查库），因此本任务把来源固定为
 * 「管理员直连」（`team_id: null`），下拉里只有这一个选项——判断记录见任务报告。
 * 原因必填（FR-023），提交前只做前端最小校验。
 */

import { useEffect, useState } from 'react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@/components/ui';
import { Button } from '@/components/ui/button';
import { useAppIntl } from '@/i18n';
import { DIALOG_CANCEL_BUTTON_CLASS, DIALOG_FOOTER_CLASS, DIALOG_PRIMARY_BUTTON_CLASS } from '@/lib/enterprise-ui';

export type CreateDraftDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  submitting?: boolean;
  /** 提交时 `team_id` 恒为 `null`（管理员直连），仅回传变更原因。 */
  onSubmit: (input: { changeReason: string }) => void;
};

const SOURCE_ADMIN_VALUE = 'admin';

/** 创建共享草稿表单：来源固定为「管理员直连」，原因必填。 */
export function CreateDraftDialog({ open, onOpenChange, submitting = false, onSubmit }: CreateDraftDialogProps) {
  const { t } = useAppIntl();
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState(false);

  useEffect(() => {
    if (open) {
      setReason('');
      setReasonError(false);
    }
  }, [open]);

  function handleSubmit() {
    const trimmed = reason.trim();
    if (!trimmed) {
      setReasonError(true);
      return;
    }
    onSubmit({ changeReason: trimmed });
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
      <DialogContent className="w-[min(480px,calc(100vw-32px))] gap-0 overflow-hidden rounded-[16px] border-0 bg-white p-0 shadow-[0px_12px_32px_rgba(0,0,0,0.16)]">
        <DialogTitle className="px-[24px] pt-[20px] pb-[8px] text-[16px] font-semibold text-[#18181a]">
          {t('knowledgeAdmin.dialogs.createDraft.title')}
        </DialogTitle>
        <DialogDescription className="px-[24px] pb-[12px] text-[12px] text-[#858b9c]">
          {t('knowledgeAdmin.dialogs.createDraft.description')}
        </DialogDescription>
        <div className="flex flex-col gap-[16px] px-[24px] pb-[16px]">
          <div className="flex flex-col gap-[6px]">
            <span className="text-[12px] font-medium text-[#464c5e]">{t('knowledgeAdmin.dialogs.createDraft.sourceLabel')}</span>
            <Select value={SOURCE_ADMIN_VALUE} disabled>
              <SelectTrigger className="w-full" aria-label={t('knowledgeAdmin.dialogs.createDraft.sourceLabel')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={SOURCE_ADMIN_VALUE}>{t('knowledgeAdmin.dialogs.createDraft.sourceAdmin')}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-[6px]">
            <span className="text-[12px] font-medium text-[#464c5e]">{t('knowledgeAdmin.dialogs.createDraft.reasonLabel')}</span>
            <Textarea
              value={reason}
              disabled={submitting}
              aria-invalid={reasonError}
              aria-label={t('knowledgeAdmin.dialogs.createDraft.reasonLabel')}
              placeholder={t('knowledgeAdmin.dialogs.createDraft.reasonPlaceholder')}
              onChange={(event) => {
                setReason(event.target.value);
                setReasonError(false);
              }}
            />
            {reasonError && (
              <span role="alert" className="text-[12px] text-[#d20b0b]">
                {t('knowledgeAdmin.dialogs.createDraft.reasonRequired')}
              </span>
            )}
          </div>
        </div>
        <div className={DIALOG_FOOTER_CLASS}>
          <Button variant="outline" disabled={submitting} onClick={() => onOpenChange(false)} className={DIALOG_CANCEL_BUTTON_CLASS}>
            {t('knowledgeAdmin.dialogs.createDraft.cancel')}
          </Button>
          <Button disabled={submitting} onClick={handleSubmit} className={DIALOG_PRIMARY_BUTTON_CLASS}>
            {t('knowledgeAdmin.dialogs.createDraft.submit')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
