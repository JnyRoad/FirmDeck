import { ApiError } from '@/api/client';
import {
  getBackendErrorContract,
  type BackendErrorContractEntry,
  type BackendParamKind,
} from '@/i18n/generated/backendContract';
import { createAppTranslator, type AppTranslator, type MessageValues } from '@/i18n/imperative';
import { LOCALE_STORAGE_KEY, normalizeAppLocale } from '@/i18n/locales';
import englishMessages from '@/i18n/messages/en-US.json';
import chineseMessages from '@/i18n/messages/zh-CN.json';
import type { MessageId } from '@/i18n/types';

const STABLE_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_.-]{2,127}$/;
const GENERIC_MESSAGE_ID = 'common.error.generic' satisfies MessageId;

type Translator = Pick<AppTranslator, 't'>;

/** 判断未知输入是否为普通对象；数组、null 和原始 provider 数据不能成为错误契约。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 将外部值收窄为稳定错误码；自然语言、路径和 provider 文本均返回 undefined。 */
function stableErrorCode(value: unknown): string | undefined {
  return typeof value === 'string' && STABLE_ERROR_CODE_PATTERN.test(value.trim())
    ? value.trim()
    : undefined;
}

/** 读取当前兼容 locale 并创建组件外 translator；存储不可用时确定性回退到中文。 */
function currentTranslator(): Translator {
  let storedLocale: string | null = null;
  try {
    storedLocale = typeof window === 'undefined' ? null : window.localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    storedLocale = null;
  }
  return createAppTranslator(normalizeAppLocale(storedLocale));
}

/** 从 ApiError、canonical 对象或精确 legacy code 字符串读取稳定代码。 */
export function apiErrorCode(error: unknown): string | undefined {
  if (error instanceof ApiError) return stableErrorCode(error.code);
  if (typeof error === 'string') return stableErrorCode(error);
  if (isRecord(error)) return stableErrorCode(error.code);
  return error instanceof Error ? stableErrorCode(error.message) : undefined;
}

/** 只读取 canonical params，不解析 detail、message、stack 或 provider 原始正文。 */
function apiErrorParams(error: unknown): Record<string, unknown> {
  if (error instanceof ApiError) return error.params;
  if (isRecord(error) && isRecord(error.params)) return error.params;
  return {};
}

/** 检查一个参数是否符合后端 registry 声明的 JSON primitive 类型。 */
function matchesParamKind(value: unknown, kind: BackendParamKind): boolean {
  if (kind === 'string') return typeof value === 'string';
  if (kind === 'boolean') return typeof value === 'boolean';
  if (kind === 'integer') return typeof value === 'number' && Number.isInteger(value);
  return typeof value === 'number' && Number.isFinite(value);
}

/** 严格投影 registry 允许的具名参数，拒绝缺失、额外、对象和非有限数值。 */
function safeMessageValues(
  entry: BackendErrorContractEntry,
  params: Record<string, unknown>,
): MessageValues | undefined {
  const expectedNames = Object.keys(entry.params);
  const actualNames = Object.keys(params);
  if (expectedNames.length !== actualNames.length || actualNames.some((name) => !(name in entry.params))) {
    return undefined;
  }

  const values: MessageValues = {};
  for (const name of expectedNames) {
    const value = params[name];
    if (!matchesParamKind(value, entry.params[name])) return undefined;
    values[name] = value as MessageValues[string];
  }
  return values;
}

/** Resolve a canonical backend key only when every supported catalog declares it. */
function resolveCatalogMessageKey(messageKey: string): MessageId | null {
  const catalogs = [englishMessages as Record<string, string>, chineseMessages as Record<string, string>];
  if (catalogs.every((catalog) => Object.prototype.hasOwnProperty.call(catalog, messageKey))) {
    return messageKey as MessageId;
  }
  return null;
}

/** 将稳定错误契约投影为语义 message ID 与安全插值参数；未知数据返回 null。 */
export function backendErrorMessageDescriptor(
  error: unknown,
): { entry: BackendErrorContractEntry; messageId: MessageId; values?: MessageValues } | null {
  const code = apiErrorCode(error);
  if (!code) return null;
  const entry = getBackendErrorContract(code);
  if (!entry || entry.visibility !== 'public') return null;
  const messageId = resolveCatalogMessageKey(entry.message_key);
  if (!messageId) return null;
  const params = safeMessageValues(entry, apiErrorParams(error));
  if (params === undefined && Object.keys(entry.params).length > 0) return null;
  return { entry, messageId, ...(params && Object.keys(params).length ? { values: params } : {}) };
}

/**
 * 将机器错误描述投影为当前 locale 的语义消息；未知、畸形或 raw 输入始终使用安全通用文案。
 * 两参数签名保留旧调用兼容，但旧自然语言 fallback 不再成为最终 UI。
 */
export function apiErrorMessage(
  error: unknown,
  fallbackMessageId: string,
  translator: Translator = currentTranslator(),
): string {
  void fallbackMessageId;
  const descriptor = backendErrorMessageDescriptor(error);
  if (!descriptor) return translator.t(GENERIC_MESSAGE_ID);
  try {
    return translator.t(descriptor.messageId, descriptor.values);
  } catch {
    return translator.t(GENERIC_MESSAGE_ID);
  }
}
