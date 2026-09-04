/**
 * 知识库管理 · 删除二次确认对话框：列表行「删除」与详情页「危险区」共用。
 * 有进行中草稿时展示 `draftCount` 提示；确认/加载态由调用方控制。
 * `draftCountUnknown` 用于草稿数拉取失败（如 `listVersions` 单独请求出错）时，明确告知
 * "未知"而不是悄悄按 0 展示、让管理员误以为没有进行中草稿。
 */

import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useAppIntl } from '@/i18n';

export type DeleteDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 目标知识库原始名称，仅用于标题展示，不参与翻译。 */
  name: string;
  /** 进行中草稿数；大于 0 时额外展示会一并删除的提示。`draftCountUnknown` 为 true 时忽略此值。 */
  draftCount?: number;
  /** 草稿数未能成功获取（例如 `listVersions` 请求失败）；展示"无法确认"而非隐含为 0。 */
  draftCountUnknown?: boolean;
  loading?: boolean;
  onConfirm: () => void;
};

export function DeleteDialog({
  open,
  onOpenChange,
  name,
  draftCount = 0,
  draftCountUnknown = false,
  loading = false,
  onConfirm,
}: DeleteDialogProps) {
  const { t } = useAppIntl();
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('knowledgeAdmin.dialogs.delete.title', { name })}
      description={(
        <>
          {t('knowledgeAdmin.dialogs.delete.description')}
          {draftCountUnknown ? (
            <>
              {' '}
              {t('knowledgeAdmin.dialogs.delete.draftCountUnknown')}
            </>
          ) : draftCount > 0 && (
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
