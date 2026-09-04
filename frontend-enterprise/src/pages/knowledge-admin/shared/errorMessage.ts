/**
 * 知识库管理端错误文案兜底：优先复用稳定错误码映射，未命中时回退到本模块登记的语义键。
 * `apiErrorMessage` 的旧 `fallbackMessageId` 形参已声明为 `string`（历史兼容签名，函数体内
 * 显式丢弃不再渲染），因此这里比照 `AccountsPage.tsx` 的 `accountPageErrorMessage` 做法，
 * 用字面量联合类型显式声明兜底键集合并在函数体内真正调用 `t(fallbackId)`，
 * 使兜底文案对用户可见，也让 i18n 静态用量扫描能识别到这些键。
 */
import { apiErrorMessage } from '@/lib/apiErrorMessages';
import type { AppTranslator } from '@/i18n';

export type KnowledgeAdminFallbackMessageId =
  | 'knowledgeAdmin.toast.loadFailed'
  | 'knowledgeAdmin.toast.createError'
  | 'knowledgeAdmin.toast.updateError'
  | 'knowledgeAdmin.toast.deleteError'
  | 'knowledgeAdmin.toast.exportError'
  | 'knowledgeAdmin.toast.lintError'
  | 'knowledgeAdmin.detail.loadError';

/** 稳定错误码命中时使用后端映射文案；未命中（通用兜底）时改用本页面语义化的兜底键。 */
export function knowledgeAdminErrorMessage(
  error: unknown,
  fallbackId: KnowledgeAdminFallbackMessageId,
  translator: Pick<AppTranslator, 't'>,
): string {
  const message = apiErrorMessage(error, fallbackId, translator);
  return message === translator.t('common.error.generic') ? translator.t(fallbackId) : message;
}
