/**
 * 管理 UI 与 Agent 回复语言的独立偏好，并生成可随 turn 持久化的不可变语言快照。
 */

import {
  DEFAULT_LOCALE,
  canonicalizeAppLocale,
  normalizeAppLocale,
  type AppLocale,
} from './locales';

const AGENT_REPLY_LOCALE_STORAGE_PREFIX = 'staffdeck_agent_reply_locale';

export const LANGUAGE_CONTEXT_SOURCES = [
  'explicit_request',
  'session_snapshot',
  'user_preference',
  'channel_default',
  'transport_hint',
  'task_snapshot',
  'legacy_default',
] as const;

export type LanguageContextSource = (typeof LANGUAGE_CONTEXT_SOURCES)[number];

export type LanguageContextSnapshot = Readonly<{
  version: 1;
  uiLocale: AppLocale;
  agentReplyLocale: AppLocale;
  uiLocaleSource: LanguageContextSource;
  agentReplyLocaleSource: LanguageContextSource;
}>;

type LanguagePreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;

type ResolveLanguageContextInput = {
  uiLocale: unknown;
  agentReplyLocalePreference: unknown;
  sessionAgentReplyLocale?: unknown;
};

/** 为一个用户生成独立的回复语言偏好键；空用户使用固定匿名命名空间且不修改存储。 */
export function agentReplyLocaleStorageKey(userId: string): string {
  return `${AGENT_REPLY_LOCALE_STORAGE_PREFIX}:${encodeURIComponent(userId || 'anonymous')}`;
}

/** 读取并归一化指定用户的回复语言偏好；缺失、非法或存储异常时安全回退兼容默认语言。 */
export function readAgentReplyLocalePreference(
  storage: LanguagePreferenceStorage,
  userId: string,
): AppLocale {
  try {
    return normalizeAppLocale(storage.getItem(agentReplyLocaleStorageKey(userId)));
  } catch {
    return DEFAULT_LOCALE;
  }
}

/** 持久化指定用户的受支持回复语言；存储被禁用或超出配额时返回 false，不抛出浏览器异常。 */
export function writeAgentReplyLocalePreference(
  storage: LanguagePreferenceStorage,
  userId: string,
  locale: AppLocale,
): boolean {
  try {
    storage.setItem(agentReplyLocaleStorageKey(userId), locale);
    return true;
  } catch {
    return false;
  }
}

/** 判断未知值是否是后端登记的语言来源；该检查无副作用。 */
function isLanguageContextSource(value: unknown): value is LanguageContextSource {
  return typeof value === 'string'
    && LANGUAGE_CONTEXT_SOURCES.includes(value as LanguageContextSource);
}

/**
 * 从当前偏好生成 turn 级不可变快照；既有 session 的回复语言优先，UI 语言仍独立取当前用户偏好。
 */
export function resolveLanguageContextSnapshot(
  input: ResolveLanguageContextInput,
): LanguageContextSnapshot {
  const uiLocale = normalizeAppLocale(input.uiLocale);
  const sessionAgentReplyLocale = canonicalizeAppLocale(input.sessionAgentReplyLocale);
  const preferredAgentReplyLocale = normalizeAppLocale(input.agentReplyLocalePreference);

  return Object.freeze({
    version: 1,
    uiLocale,
    agentReplyLocale: sessionAgentReplyLocale ?? preferredAgentReplyLocale,
    uiLocaleSource: 'user_preference',
    agentReplyLocaleSource: sessionAgentReplyLocale ? 'session_snapshot' : 'user_preference',
  });
}

/** 为缺少历史快照的旧队列项生成唯一兼容默认值；返回对象冻结以防恢复后被偏好切换改写。 */
export function createLegacyLanguageContextSnapshot(): LanguageContextSnapshot {
  return Object.freeze({
    version: 1,
    uiLocale: DEFAULT_LOCALE,
    agentReplyLocale: DEFAULT_LOCALE,
    uiLocaleSource: 'legacy_default',
    agentReplyLocaleSource: 'legacy_default',
  });
}

/**
 * 严格解析持久化语言快照；任何未登记 locale、来源或版本都返回 null，避免恢复时猜测。
 */
export function parseLanguageContextSnapshot(value: unknown): LanguageContextSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const uiLocale = canonicalizeAppLocale(candidate.uiLocale);
  const agentReplyLocale = canonicalizeAppLocale(candidate.agentReplyLocale);
  if (
    candidate.version !== 1
    || !uiLocale
    || !agentReplyLocale
    || !isLanguageContextSource(candidate.uiLocaleSource)
    || !isLanguageContextSource(candidate.agentReplyLocaleSource)
  ) {
    return null;
  }

  return Object.freeze({
    version: 1,
    uiLocale,
    agentReplyLocale,
    uiLocaleSource: candidate.uiLocaleSource,
    agentReplyLocaleSource: candidate.agentReplyLocaleSource,
  });
}
