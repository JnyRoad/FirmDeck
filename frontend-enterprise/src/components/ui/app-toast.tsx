import type { ReactNode } from 'react';
import { toast, type ExternalToast } from 'sonner';

import type { MessageDescriptor } from '@/i18n/descriptors';
import type { AppTranslator } from '@/i18n/imperative';
import { apiErrorMessage } from '@/lib/apiErrorMessages';
import { cn } from '@/lib/utils';

import IconError from '@/assets/icons/error-fill.svg?react';
import IconSuccess from '@/assets/icons/success-fill.svg?react';

type ToastVariant = 'success' | 'error';

// Colors, radius and spacing mirror SD1 "Basic components/Dialog/Message"
// (success node 281:3334, error node 281:3342).
const VARIANTS: Record<
  ToastVariant,
  { container: string; icon: string; Icon: typeof IconSuccess }
> = {
  success: {
    container: 'border-[#96d9b0] bg-[#e9f7ef] text-[#018434]',
    icon: 'text-[#2cb360]',
    Icon: IconSuccess,
  },
  error: {
    container: 'border-[#f38989] bg-[#fce7e7] text-[#d20b0b]',
    icon: 'text-[#d20b0b]',
    Icon: IconError,
  },
};

function ToastPill({ variant, message }: { variant: ToastVariant; message: ReactNode }) {
  const { container, icon, Icon } = VARIANTS[variant];
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'pointer-events-auto flex max-w-full items-center gap-[12px] rounded-[14px] border border-solid px-[24px] py-[10px] shadow-[0px_12px_32px_rgba(0,0,0,0.12)]',
        container,
      )}
    >
      <Icon className={cn('size-[16px] shrink-0', icon)} aria-hidden="true" />
      <span className="text-[14px] leading-[normal] wrap-anywhere">{message}</span>
    </div>
  );
}

/**
 * Options accepted by the branded toasts. Presentation (icon, styling and
 * centered placement) is owned by the component, so those keys are excluded.
 */
export type AppToastOptions = Omit<
  ExternalToast,
  'icon' | 'className' | 'style' | 'unstyled' | 'descriptionClassName'
>;

/** 以现有品牌样式显示一条任意 React 内容；只供 legacy notify 和已解析的 descriptor 使用。 */
function showVariant(variant: ToastVariant, message: ReactNode, options?: AppToastOptions) {
  return toast.custom(() => <ToastPill variant={variant} message={message} />, {
    duration: variant === 'success' ? 3200 : 4800,
    unstyled: true,
    className: 'flex w-full justify-center',
    ...options,
  });
}

/** 判断运行时输入是否为 descriptor，阻止 JavaScript 调用方把 raw 字符串送入产品 toast。 */
function isMessageDescriptor(value: unknown): value is MessageDescriptor {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { id?: unknown }).id === 'string';
}

/** 用显式受控 translator 解析 descriptor；无效 raw 输入返回 null 且不会触发 toast。 */
function localizeDescriptor(
  translator: Pick<AppTranslator, 't'>,
  value: unknown,
): string | null {
  if (!isMessageDescriptor(value)) return null;
  return translator.t(value.id, value.values);
}

/** 通过受控 translator 解析 descriptor 并路由到品牌 toast；无效 raw 输入保持静默拒绝。 */
function showLocalizedVariant(
  translator: Pick<AppTranslator, 't'>,
  variant: ToastVariant,
  descriptor: unknown,
  options?: AppToastOptions,
): ReturnType<typeof showVariant> | undefined {
  const message = localizeDescriptor(translator, descriptor);
  return message == null ? undefined : showVariant(variant, message, options);
}

/** 创建只接受 MessageDescriptor 的 toast facade；所有文案通过调用方传入的 translator 解析。 */
export function createToastNotifier(translator: Pick<AppTranslator, 't'>) {
  /** 显示本地化 success descriptor，并保留品牌成功样式。 */
  function success(descriptor: MessageDescriptor, options?: AppToastOptions) {
    return showLocalizedVariant(translator, 'success', descriptor, options);
  }

  /** 显示本地化 error descriptor，并保留品牌错误样式。 */
  function error(descriptor: MessageDescriptor, options?: AppToastOptions) {
    return showLocalizedVariant(translator, 'error', descriptor, options);
  }

  /** 显示本地化 warning descriptor，并交由 Sonner 管理普通警告样式。 */
  function warning(descriptor: MessageDescriptor, options?: AppToastOptions) {
    const message = localizeDescriptor(translator, descriptor);
    return message == null ? undefined : toast.warning(message, options);
  }

  /** 显示本地化 info descriptor，并交由 Sonner 管理普通信息样式。 */
  function info(descriptor: MessageDescriptor, options?: AppToastOptions) {
    const message = localizeDescriptor(translator, descriptor);
    return message == null ? undefined : toast.info(message, options);
  }

  /** 显示本地化 loading descriptor，并交由 Sonner 管理加载状态。 */
  function loading(descriptor: MessageDescriptor, options?: AppToastOptions) {
    const message = localizeDescriptor(translator, descriptor);
    return message == null ? undefined : toast.loading(message, options);
  }

  /** 关闭由受控 toast facade 返回的通知句柄。 */
  function dismiss(id?: string | number) {
    return toast.dismiss(id);
  }

  return { success, error, warning, info, loading, dismiss };
}

/** 将 legacy sink 输入收窄为已登记错误码或安全通用消息，拒绝任意 React/raw 内容透传。 */
function localizedLegacyMessage(message: ReactNode): string {
  return apiErrorMessage(typeof message === 'string' ? message : undefined, 'common.error.generic');
}

/**
 * Legacy toast compatibility boundary. New product-owned messages must use
 * createToastNotifier with a MessageDescriptor; existing raw callers remain
 * temporarily supported until their migration boundary is removed.
 */
export const notify = {
  success: (message: ReactNode, options?: AppToastOptions) =>
    showVariant('success', localizedLegacyMessage(message), options),
  /**
   * 已在产品调用点审核、且已完成本地化的成功文案。
   *
   * `success` 仍维持旧错误码兼容与原始数据脱敏；业务页面只有在文案完全由
   * catalog 或本地固定 copy 生成时，才能调用此入口。这样不会再把“保存成功”
   * 错当作错误码，同时也不放宽 error/warning/info/loading 对 provider 原文的拦截。
   */
  successText: (message: string, options?: AppToastOptions) =>
    showVariant('success', message, options),
  error: (message: ReactNode, options?: AppToastOptions) =>
    showVariant('error', localizedLegacyMessage(message), options),
  warning: (message: ReactNode, options?: AppToastOptions) => (
    toast.warning(localizedLegacyMessage(message), options)
  ),
  info: (message: ReactNode, options?: AppToastOptions) => (
    toast.info(localizedLegacyMessage(message), options)
  ),
  loading: (message: ReactNode, options?: AppToastOptions) => (
    toast.loading(localizedLegacyMessage(message), options)
  ),
  dismiss: (id?: string | number) => toast.dismiss(id),
};
