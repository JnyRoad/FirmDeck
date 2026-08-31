/**
 * 将后端生成的事件契约投影为当前前端目录中的语义消息；未知或畸形输入始终 fail closed。
 */

import {
  getBackendEventContract,
  type BackendEventContractEntry,
  type BackendParamKind,
} from '@/i18n/generated/backendContract';
import type { MessageValues } from '@/i18n/imperative';
import englishMessages from '@/i18n/messages/en-US.json';
import chineseMessages from '@/i18n/messages/zh-CN.json';
import type { MessageId } from '@/i18n/types';

type EventTranslator = (id: MessageId, values?: MessageValues) => string;

export type BackendEventMessageDescriptor = {
  entry: BackendEventContractEntry;
  messageId: MessageId;
  values?: MessageValues;
};

/** 检查一个事件参数是否符合 registry 声明的 primitive 类型。 */
function matchesEventParamKind(value: unknown, kind: BackendParamKind): boolean {
  if (kind === 'string') return typeof value === 'string';
  if (kind === 'boolean') return typeof value === 'boolean';
  if (kind === 'integer') return typeof value === 'number' && Number.isInteger(value);
  return typeof value === 'number' && Number.isFinite(value);
}
/** 仅接受普通对象，避免数组或原型值绕过事件参数集合检查。 */
function isEventParamRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 仅当所有正式目录都声明同一语义 ID 时，才允许后端 message_key 进入翻译器。 */
function resolveEventMessageId(messageKey: string): MessageId | null {
  const catalogs = [englishMessages as Record<string, string>, chineseMessages as Record<string, string>];
  return catalogs.every((catalog) => Object.prototype.hasOwnProperty.call(catalog, messageKey))
    ? messageKey as MessageId
    : null;
}

/** 严格投影 registry 允许的具名参数；缺失、额外或类型错误都返回 null。 */
function normalizeEventValues(
  params: unknown,
  schema: BackendEventContractEntry['params'],
): MessageValues | null {
  if (!isEventParamRecord(params)) return null;
  const expectedNames = Object.keys(schema);
  const actualNames = Object.keys(params);
  if (
    expectedNames.length !== actualNames.length
    || actualNames.some((name) => !Object.prototype.hasOwnProperty.call(schema, name))
  ) return null;

  const values: MessageValues = {};
  for (const name of expectedNames) {
    const value = params[name];
    if (!matchesEventParamKind(value, schema[name])) return null;
    values[name] = value as MessageValues[string];
  }
  return values;
}

/** 将稳定 event_code/params 收窄为可安全格式化的消息描述；不读取 legacy text 字段。 */
export function backendEventMessageDescriptor(
  eventCode: unknown,
  params: unknown,
): BackendEventMessageDescriptor | null {
  const code = typeof eventCode === 'string' ? eventCode.trim() : '';
  if (!code) return null;
  const entry = getBackendEventContract(code);
  if (!entry || entry.visibility !== 'public' || !entry.message_key || entry.raw_source_allowed) return null;
  const messageId = resolveEventMessageId(entry.message_key);
  if (!messageId) return null;
  const values = normalizeEventValues(params, entry.params);
  if (!values) return null;
  return {
    entry,
    messageId,
    ...(Object.keys(values).length ? { values } : {}),
  };
}

/** 按当前 UI locale 格式化 canonical 事件；任何契约失败都使用调用方指定的安全语义 fallback。 */
export function backendEventMessage(
  eventCode: unknown,
  params: unknown,
  translate: EventTranslator,
  fallbackId: MessageId,
): string {
  const descriptor = backendEventMessageDescriptor(eventCode, params);
  if (!descriptor) return translate(fallbackId);
  try {
    return translate(descriptor.messageId, descriptor.values);
  } catch {
    return translate(fallbackId);
  }
}
