/**
 * 知识库管理 · 新建知识库对话框：选择共享/私有，私有必须指定归属员工（FR-014）。
 * 只做前端最小校验（名称必填、私有必须选员工），创建请求由父组件（列表页）发起。
 */

import { useEffect, useState } from 'react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@/components/ui';
import { Button } from '@/components/ui/button';
import { useAppIntl } from '@/i18n';
import { RawContent } from '@/i18n/RawContent';
import { DIALOG_CANCEL_BUTTON_CLASS, DIALOG_FOOTER_CLASS, DIALOG_PRIMARY_BUTTON_CLASS } from '@/lib/enterprise-ui';
import type { AgentProfileRead } from '@/types';
import { KnowledgeBaseMode } from '@/enums/knowledge';

export type CreateKnowledgeBaseDraft = {
  name: string;
  description: string;
  mode: KnowledgeBaseMode;
  ownerAgentId: string;
};

export type CreateKnowledgeBaseDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 私有知识库归属员工候选（`listAgents` 结果）。 */
  agents: AgentProfileRead[];
  submitting?: boolean;
  onSubmit: (draft: CreateKnowledgeBaseDraft) => void;
};

const EMPTY_DRAFT: CreateKnowledgeBaseDraft = {
  name: '',
  description: '',
  mode: KnowledgeBaseMode.Shared,
  ownerAgentId: '',
};

/** 新建知识库表单；打开时重置草稿，关闭态不保留上一次未提交输入。 */
export function CreateKnowledgeBaseDialog({ open, onOpenChange, agents, submitting = false, onSubmit }: CreateKnowledgeBaseDialogProps) {
  const { t } = useAppIntl();
  const [draft, setDraft] = useState<CreateKnowledgeBaseDraft>(EMPTY_DRAFT);
  const [nameError, setNameError] = useState(false);
  const [ownerError, setOwnerError] = useState(false);

  useEffect(() => {
    if (open) {
      setDraft(EMPTY_DRAFT);
      setNameError(false);
      setOwnerError(false);
    }
  }, [open]);

  function handleModeChange(mode: KnowledgeBaseMode) {
    setDraft((prev) => ({ ...prev, mode, ownerAgentId: mode === KnowledgeBaseMode.Shared ? '' : prev.ownerAgentId }));
    setOwnerError(false);
  }

  function handleSubmit() {
    const name = draft.name.trim();
    const missingName = !name;
    const missingOwner = draft.mode === KnowledgeBaseMode.Dedicated && !draft.ownerAgentId;
    setNameError(missingName);
    setOwnerError(missingOwner);
    if (missingName || missingOwner) return;
    onSubmit({ ...draft, name, description: draft.description.trim() });
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
      <DialogContent className="w-[min(480px,calc(100vw-32px))] gap-0 overflow-hidden rounded-[16px] border-0 bg-white p-0 shadow-[0px_12px_32px_rgba(0,0,0,0.16)]">
        <DialogTitle className="px-[24px] pt-[20px] pb-[8px] text-[16px] font-semibold text-[#18181a]">
          {t('knowledgeAdmin.dialogs.createKb.title')}
        </DialogTitle>
        <DialogDescription className="px-[24px] pb-[12px] text-[12px] text-[#858b9c]">
          {t('knowledgeAdmin.dialogs.createKb.description')}
        </DialogDescription>
        <div className="flex flex-col gap-[16px] px-[24px] pb-[16px]">
          <div className="flex flex-col gap-[6px]">
            <span className="text-[12px] font-medium text-[#464c5e]">{t('knowledgeAdmin.dialogs.createKb.modeLabel')}</span>
            <Select value={draft.mode} onValueChange={(value) => handleModeChange(value as KnowledgeBaseMode)} disabled={submitting}>
              <SelectTrigger className="w-full" aria-label={t('knowledgeAdmin.dialogs.createKb.modeLabel')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={KnowledgeBaseMode.Shared}>{t('knowledgeAdmin.dialogs.createKb.modeShared')}</SelectItem>
                <SelectItem value={KnowledgeBaseMode.Dedicated}>{t('knowledgeAdmin.dialogs.createKb.modeDedicated')}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {draft.mode === KnowledgeBaseMode.Dedicated && (
            <div className="flex flex-col gap-[6px]">
              <span className="text-[12px] font-medium text-[#464c5e]">{t('knowledgeAdmin.dialogs.createKb.ownerLabel')}</span>
              <Select
                value={draft.ownerAgentId || undefined}
                onValueChange={(value) => {
                  setDraft((prev) => ({ ...prev, ownerAgentId: value }));
                  setOwnerError(false);
                }}
                disabled={submitting || agents.length === 0}
              >
                <SelectTrigger className="w-full" aria-invalid={ownerError} aria-label={t('knowledgeAdmin.dialogs.createKb.ownerLabel')}>
                  <SelectValue placeholder={agents.length === 0 ? t('knowledgeAdmin.dialogs.createKb.noAgents') : t('knowledgeAdmin.dialogs.createKb.ownerPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {agents.map((agent) => (
                    <SelectItem key={agent.id} value={agent.id}>
                      <RawContent value={agent.name} />
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {ownerError && (
                <span role="alert" className="text-[12px] text-[#d20b0b]">
                  {t('knowledgeAdmin.dialogs.createKb.ownerRequired')}
                </span>
              )}
            </div>
          )}

          <div className="flex flex-col gap-[6px]">
            <span className="text-[12px] font-medium text-[#464c5e]">{t('knowledgeAdmin.dialogs.createKb.nameLabel')}</span>
            <Input
              value={draft.name}
              disabled={submitting}
              aria-invalid={nameError}
              aria-label={t('knowledgeAdmin.dialogs.createKb.nameLabel')}
              placeholder={t('knowledgeAdmin.dialogs.createKb.namePlaceholder')}
              onChange={(event) => {
                setDraft((prev) => ({ ...prev, name: event.target.value }));
                setNameError(false);
              }}
            />
            {nameError && (
              <span role="alert" className="text-[12px] text-[#d20b0b]">
                {t('knowledgeAdmin.dialogs.createKb.nameRequired')}
              </span>
            )}
          </div>

          <div className="flex flex-col gap-[6px]">
            <span className="text-[12px] font-medium text-[#464c5e]">{t('knowledgeAdmin.dialogs.createKb.descriptionLabel')}</span>
            <Textarea
              value={draft.description}
              disabled={submitting}
              aria-label={t('knowledgeAdmin.dialogs.createKb.descriptionLabel')}
              placeholder={t('knowledgeAdmin.dialogs.createKb.descriptionPlaceholder')}
              onChange={(event) => setDraft((prev) => ({ ...prev, description: event.target.value }))}
            />
          </div>
        </div>
        <div className={DIALOG_FOOTER_CLASS}>
          <Button variant="outline" disabled={submitting} onClick={() => onOpenChange(false)} className={DIALOG_CANCEL_BUTTON_CLASS}>
            {t('knowledgeAdmin.dialogs.createKb.cancel')}
          </Button>
          <Button disabled={submitting} onClick={handleSubmit} className={DIALOG_PRIMARY_BUTTON_CLASS}>
            {t('knowledgeAdmin.dialogs.createKb.submit')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
