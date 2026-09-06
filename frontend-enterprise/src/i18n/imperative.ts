/**
 * 创建不依赖 React 生命周期的受控翻译实例，供 toast、原生边界和纯函数显式注入使用。
 */

import {
  createIntl,
  createIntlCache,
  type IntlConfig,
  type IntlShape,
  type PrimitiveType,
} from 'react-intl';

import {
  CANONICAL_LOCALE,
  normalizeAppLocale,
  type AppLocale,
} from './locales';
import englishMessages from './messages/en-US.json';
import chineseMessages from './messages/zh-CN.json';
import type { MessageId } from './types';

export type MessageValue = PrimitiveType;
export type MessageValues = Record<string, MessageValue>;

export type AppTranslator = {
  locale: AppLocale;
  intl: IntlShape;
  t: (id: MessageId, values?: MessageValues) => string;
};

type MessageCatalog = Record<MessageId, string>;
type IntlErrorHandler = NonNullable<IntlConfig['onError']>;
type IntlFormattingError = Parameters<IntlErrorHandler>[0];

type ResolvedMessage = {
  id: MessageId;
  locale: AppLocale;
};

const GENERIC_MESSAGE_ID = 'common.error.generic' satisfies MessageId;
const LAST_RESORT_MESSAGES: Record<AppLocale, string> = {
  'zh-CN': '操作失败，请稍后重试。',
  'en-US': 'Something went wrong. Please try again later.',
};
const MESSAGE_CATALOGS: Record<AppLocale, MessageCatalog> = {
  'zh-CN': chineseMessages,
  'en-US': englishMessages,
};
const intlCache = createIntlCache();
const intlInstances = new Map<AppLocale, IntlShape>();
const reportedDiagnostics = new Set<string>();

/**
 * 判断缺失或非法消息是否应立即中断调用；开发、测试和 CI 均严格，只有生产使用安全回退。
 */
function shouldFailFast(): boolean {
  return import.meta.env.PROD !== true;
}

/**
 * 在生产环境按 locale、message ID 和错误类型去重记录诊断；不会记录插值值或其他原始内容。
 */
function reportProductionDiagnostic(locale: AppLocale, id: string, error: unknown): void {
  const errorName = error instanceof Error ? error.name : 'I18nError';
  const diagnosticKey = `${locale}:${id}:${errorName}`;
  if (reportedDiagnostics.has(diagnosticKey)) return;
  reportedDiagnostics.add(diagnosticKey);
  console.error(`[i18n] ${errorName}; locale=${locale}; messageId=${id}`);
}

/**
 * 处理 React Intl 的格式化错误；严格环境抛出原错误，生产环境只输出有界且不含业务参数的诊断。
 */
function handleIntlError(locale: AppLocale, error: IntlFormattingError): void {
  if (!shouldFailFast()) reportProductionDiagnostic(locale, 'format', error);
  throw error;
}

/**
 * 为一个语言区域创建 React Intl 错误处理器；返回函数仅捕获该实例的 locale，不捕获业务参数。
 */
function createIntlErrorHandler(locale: AppLocale): IntlErrorHandler {
  /** 将底层格式化错误交给统一的严格或生产处理策略。 */
  return function onIntlError(error: IntlFormattingError): void {
    handleIntlError(locale, error);
  };
}

/**
 * 为一个受支持语言区域创建 React Intl 实例；实例只绑定静态目录，不读取或修改用户偏好。
 */
function buildIntl(locale: AppLocale): IntlShape {
  return createIntl(
    {
      locale,
      defaultLocale: CANONICAL_LOCALE,
      messages: MESSAGE_CATALOGS[locale],
      onError: createIntlErrorHandler(locale),
    },
    intlCache,
  );
}

/**
 * 复用按语言区域创建的不可变 React Intl 实例；唯一副作用是填充进程内 formatter 缓存。
 */
function getIntl(locale: AppLocale): IntlShape {
  const existing = intlInstances.get(locale);
  if (existing) return existing;
  const created = buildIntl(locale);
  intlInstances.set(locale, created);
  return created;
}

/**
 * 按当前目录、英文规范目录、注册通用消息依次解析一个 ID；严格环境遇到目录缺失立即报错。
 */
function resolveMessage(locale: AppLocale, id: MessageId): ResolvedMessage {
  if (MESSAGE_CATALOGS[locale][id]) return { id, locale };

  const missingError = new Error(`Missing i18n message; locale=${locale}; messageId=${id}`);
  if (shouldFailFast()) throw missingError;
  reportProductionDiagnostic(locale, id, missingError);

  if (MESSAGE_CATALOGS[CANONICAL_LOCALE][id]) {
    return { id, locale: CANONICAL_LOCALE };
  }
  if (MESSAGE_CATALOGS[locale][GENERIC_MESSAGE_ID]) {
    return { id: GENERIC_MESSAGE_ID, locale };
  }
  return { id: GENERIC_MESSAGE_ID, locale: CANONICAL_LOCALE };
}

/**
 * 格式化已解析的消息；生产中的格式化异常回退到注册通用消息，目录损坏时使用固定末级安全文案。
 */
function formatResolvedMessage(
  requestedLocale: AppLocale,
  resolved: ResolvedMessage,
  values?: MessageValues,
): string {
  try {
    const formatted = getIntl(resolved.locale).formatMessage({ id: resolved.id }, values);
    if (!shouldFailFast() && formatted === resolved.id) {
      const unresolvedError = new Error('React Intl returned an unresolved semantic message ID');
      reportProductionDiagnostic(resolved.locale, resolved.id, unresolvedError);
      return LAST_RESORT_MESSAGES[requestedLocale];
    }
    return formatted;
  } catch (error) {
    if (shouldFailFast()) throw error;
    reportProductionDiagnostic(resolved.locale, resolved.id, error);

    // 先尝试英文规范目录，确保单一地区目录损坏时仍能显示注册产品文案。
    if (resolved.locale !== CANONICAL_LOCALE
      && resolved.id !== GENERIC_MESSAGE_ID
      && MESSAGE_CATALOGS[CANONICAL_LOCALE][resolved.id]) {
      try {
        return getIntl(CANONICAL_LOCALE).formatMessage({ id: resolved.id }, values);
      } catch (canonicalError) {
        reportProductionDiagnostic(CANONICAL_LOCALE, resolved.id, canonicalError);
      }
    }

    // 规范消息也不可用时才降级到当前语言的注册通用错误文案。
    const genericLocale = MESSAGE_CATALOGS[requestedLocale][GENERIC_MESSAGE_ID]
      ? requestedLocale
      : CANONICAL_LOCALE;
    if (!MESSAGE_CATALOGS[genericLocale][GENERIC_MESSAGE_ID]) {
      return LAST_RESORT_MESSAGES[requestedLocale];
    }

    try {
      const genericMessage = getIntl(genericLocale).formatMessage({ id: GENERIC_MESSAGE_ID });
      return genericMessage === GENERIC_MESSAGE_ID
        ? LAST_RESORT_MESSAGES[requestedLocale]
        : genericMessage;
    } catch (genericError) {
      reportProductionDiagnostic(genericLocale, GENERIC_MESSAGE_ID, genericError);
      return LAST_RESORT_MESSAGES[requestedLocale];
    }
  }
}

/**
 * 创建可显式传入非 React 代码的翻译器；输入会归一化，实例本身不读写 localStorage 或 DOM。
 */
export function createAppTranslator(localeInput: unknown): AppTranslator {
  const locale = normalizeAppLocale(localeInput);
  const intl = getIntl(locale);

  /** 使用类型化 ID 和命名参数格式化当前语言消息；缺失策略由运行环境统一控制。 */
  function t(id: MessageId, values?: MessageValues): string {
    const resolved = resolveMessage(locale, id);
    return formatResolvedMessage(locale, resolved, values);
  }

  return { locale, intl, t };
}

/**
 * 创建 FirmDeck 的受控组件外 i18n 实例；这是 createAppTranslator 的语义化公开入口。
 */
export function createAppIntl(localeInput: unknown): AppTranslator {
  return createAppTranslator(localeInput);
}
