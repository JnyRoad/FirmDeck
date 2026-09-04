/**
 * 知识库管理端统一 toast 出口（T083；T084 完成全量调用点迁移）。
 *
 * 背景：`notify.error(message)`（legacy facade，见 `components/ui/app-toast.tsx`）内部经
 * `localizedLegacyMessage → apiErrorMessage(typeof message==='string' ? message : undefined)`，
 * 只接受**稳定错误码字符串**，不接受任意已翻译好的自然语言文本——传入已翻译文本时，
 * `apiErrorCode` 无法从中解析出稳定码，于是静默退化成通用兜底文案
 * （`common.error.generic`），把原本算出来的、更具体的错误说明（例如
 * `errors.knowledge.baselineStale` 的冲突详情）整个丢弃。
 *
 * 修复方式：不先把错误"翻译成字符串"再喂给 legacy `notify`，而是像 `GrantsTab.tsx` 那样
 * 直接用 `createToastNotifier({t})` + `MessageDescriptor`（id + 具名参数）驱动 toast，
 * 翻译推迟到 toast 组件内部按当前 locale 解析，不经过中间字符串。
 *
 * `useKnowledgeAdminToast()` 是本页面统一出口：
 * - `success(descriptor)`：成功文案直接传 descriptor，透传给 `createToastNotifier`。
 * - `error(error, fallbackId)`：把任意错误值投影为 descriptor——已注册稳定错误码命中时
 *   复用 `apiErrorMessages.ts` 的 `backendErrorMessageDescriptor`（同一套 `knowledgeAdmin.errors.*`
 *   / `errors.knowledge.*` 契约映射），未命中时退回调用方指定的语义兜底键。
 * - `errorDescriptor(descriptor)`：调用方已经知道要显示哪个具体 descriptor（例如某个错误码
 *   在特定业务场景下需要比契约默认文案更精确的措辞，如 `ContentTab.tsx` 的
 *   `KNOWLEDGE_PUBLISH_CONFLICT` 在"应用审阅"场景下要显示专属提示），跳过错误码映射直接显示。
 *
 * `private/*`、`KnowledgeAdminListPage.tsx`、`KnowledgeAdminDetailPage.tsx` 在 T084 已迁移
 * 到 `useKnowledgeAdminToast()`；旧的 `knowledgeAdminErrorMessage` 兼容导出无调用方后已移除。
 */
import { useMemo } from 'react';

import { createToastNotifier, type AppToastOptions } from '@/components/ui/app-toast';
import { useAppIntl } from '@/i18n';
import { createMessageDescriptor, type MessageDescriptor } from '@/i18n/descriptors';
import { backendErrorMessageDescriptor } from '@/lib/apiErrorMessages';

export type KnowledgeAdminFallbackMessageId =
  | 'knowledgeAdmin.toast.loadFailed'
  | 'knowledgeAdmin.toast.createError'
  | 'knowledgeAdmin.toast.updateError'
  | 'knowledgeAdmin.toast.deleteError'
  | 'knowledgeAdmin.toast.exportError'
  | 'knowledgeAdmin.toast.lintError'
  | 'knowledgeAdmin.detail.loadError'
  // 「群组与权限」Tab 的四个场景化兜底键（T086/I12）：GrantsTab 迁移到本出口后，
  // 已注册的后端错误码会先命中契约文案，未命中时才退到这些更具体的说明。
  | 'knowledgeAdmin.grants.toast.loadFailed'
  | 'knowledgeAdmin.grants.toast.bindFailed'
  | 'knowledgeAdmin.grants.toast.saveFailed'
  | 'knowledgeAdmin.grants.toast.setDefaultFailed'
  | 'knowledgeAdmin.grants.toast.unbindFailed';

/**
 * 把任意错误值投影为 `MessageDescriptor`：已注册稳定错误码命中时用契约里的语义 message id
 * 与安全插值参数（`backendErrorMessageDescriptor` 已做过白名单校验，不会把 provider 原始
 * 正文/堆栈当作参数透传）；未命中时退回调用方指定的语义兜底键（无插值参数）。
 */
export function knowledgeAdminErrorDescriptor(
  error: unknown,
  fallbackId: KnowledgeAdminFallbackMessageId,
): MessageDescriptor {
  const descriptor = backendErrorMessageDescriptor(error);
  if (!descriptor) return createMessageDescriptor(fallbackId);
  return createMessageDescriptor(descriptor.messageId, descriptor.values);
}

/** 知识库管理页统一 toast 出口：仅接受 descriptor，不接受任意已翻译字符串或 raw React 内容。 */
export function useKnowledgeAdminToast() {
  const { t } = useAppIntl();
  const toast = useMemo(() => createToastNotifier({ t }), [t]);
  return useMemo(() => ({
    /** 显示本地化 success descriptor。 */
    success: (descriptor: MessageDescriptor, options?: AppToastOptions) => toast.success(descriptor, options),
    /** 把 error 值映射为 descriptor（已注册错误码 → 契约文案；未命中 → fallbackId）后显示。 */
    error: (error: unknown, fallbackId: KnowledgeAdminFallbackMessageId, options?: AppToastOptions) =>
      toast.error(knowledgeAdminErrorDescriptor(error, fallbackId), options),
    /** 调用方已确定要显示的具体 descriptor（跳过错误码→契约文案的默认映射）。 */
    errorDescriptor: (descriptor: MessageDescriptor, options?: AppToastOptions) => toast.error(descriptor, options),
  }), [toast]);
}
