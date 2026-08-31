/**
 * 提供由调用方显式注入 translator 的原生对话框和下载适配器。
 * 产品描述与用户/业务原始值在接口层分离，避免 legacy DOM observer 或全局 locale 参与非 DOM 输出。
 */

import type { MessageDescriptor } from './descriptors';
import type { AppTranslator } from './imperative';

type ControlledTranslator = Pick<AppTranslator, 't'>;

export type UiSinks = {
  alert: (descriptor: MessageDescriptor) => void;
  confirm: (descriptor: MessageDescriptor) => boolean;
  prompt: (descriptor: MessageDescriptor, rawDefaultValue?: string) => string | null;
  download: (
    blob: Blob,
    descriptor: MessageDescriptor,
    rawName: string,
    extension: string,
  ) => void;
};

/** 判断运行时输入是否为 descriptor，避免外部 JavaScript 调用把 raw 数据送入产品消息边界。 */
function isMessageDescriptor(value: unknown): value is MessageDescriptor {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { id?: unknown }).id === 'string';
}

/** 用受控 translator 解析产品 descriptor；非法输入返回 null 且不触发浏览器副作用。 */
function localizeDescriptor(
  translator: ControlledTranslator,
  value: unknown,
): string | null {
  if (!isMessageDescriptor(value)) return null;
  return translator.t(value.id, value.values);
}

/** 将扩展名规范化为单个前导点；扩展名是技术输入，不经过翻译或业务内容拼接。 */
function normalizeExtension(extension: string): string {
  const normalized = extension.trim().replace(/^\.+/u, '');
  return normalized ? `.${normalized}` : '';
}

/** 在产品前缀与原始文件名之间建立可审计的下载名，不翻译或重写 rawName。 */
function buildDownloadFilename(productPrefix: string, rawName: string, extension: string): string {
  return `${productPrefix}-${rawName}${normalizeExtension(extension)}`;
}

/** 创建绑定到一个受控 translator 的 UI sink；实例不读取全局 locale，也不启动 DOM observer。 */
export function createUiSinks(translator: ControlledTranslator): UiSinks {
  /** 显示本地化 alert descriptor；服务端渲染或非法输入时不执行浏览器副作用。 */
  function alert(descriptor: MessageDescriptor): void {
    const message = localizeDescriptor(translator, descriptor);
    if (message == null || typeof window === 'undefined') return;
    window.alert(message);
  }

  /** 显示本地化 confirm descriptor；非法输入或无浏览器环境确定性返回 false。 */
  function confirm(descriptor: MessageDescriptor): boolean {
    const message = localizeDescriptor(translator, descriptor);
    if (message == null || typeof window === 'undefined') return false;
    return window.confirm(message);
  }

  /** 显示本地化 prompt descriptor，同时逐字保留用户提供的默认值。 */
  function prompt(descriptor: MessageDescriptor, rawDefaultValue?: string): string | null {
    const message = localizeDescriptor(translator, descriptor);
    if (message == null || typeof window === 'undefined') return null;
    return window.prompt(message, rawDefaultValue);
  }

  /** 只本地化产品文件名前缀，使用原始名称生成并触发一次浏览器下载。 */
  function download(
    blob: Blob,
    descriptor: MessageDescriptor,
    rawName: string,
    extension: string,
  ): void {
    const productPrefix = localizeDescriptor(translator, descriptor);
    if (productPrefix == null || typeof document === 'undefined') return;

    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = buildDownloadFilename(productPrefix, rawName, extension);
    try {
      document.body.appendChild(anchor);
      anchor.click();
    } finally {
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
    }
  }

  return { alert, confirm, prompt, download };
}
