/**
 * 知识库管理 · 删除二次确认对话框：列表行「删除」与详情页「危险区」共用。
 * 有进行中草稿时展示 `draftCount` 提示；确认/加载态由调用方控制。
 */

import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useAppIntl } from '@/i18n';

export type DeleteDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 目标知识库原始名称，仅用于标题展示，不参与翻译。 */
  name: string;
  /** 进行中草稿数；大于 0 时额外展示会一并删除的提示。 */
  draftCount?: number;
  loading?: boolean;
  onConfirm: () => void;
};

export function DeleteDialog({ open, onOpenChange, name, draftCount = 0, loading = false, onConfirm }: DeleteDialogProps) {
  const { t } = useAppIntl();
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('knowledgeAdmin.dialogs.delete.title', { name })}
      description={(
        <>
          {t('knowledgeAdmin.dialogs.delete.description')}
          {draftCount > 0 && (
            <>
              {' '}
              {t('knowledgeAdmin.dialogs.delete.draftWarning', { count: draftCount })}
            </>
          )}
        </>
      )}
      confirmText={t('knowledgeAdmin.dialogs.delete.confirm')}
      cancelText={t('knowledgeAdmin.dialogs.delete.cancel')}
      destructive
      loading={loading}
      onConfirm={onConfirm}
    />
  );
}
