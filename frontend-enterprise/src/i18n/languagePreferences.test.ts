import { describe, expect, it } from 'vitest';

import type { AppLocale } from './locales';
import {
  agentReplyLocaleStorageKey,
  readAgentReplyLocalePreference,
  resolveLanguageContextSnapshot,
  writeAgentReplyLocalePreference,
} from './languagePreferences';

/** 创建隔离的 Storage 替身，避免语言偏好测试依赖 jsdom 的全局 localStorage。 */
function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

describe('language preferences', () => {
  it.each([
    ['zh-CN', 'zh-CN'],
    ['zh-CN', 'en-US'],
    ['en-US', 'zh-CN'],
    ['en-US', 'en-US'],
  ] as const)('keeps UI %s independent from agent replies %s', (uiLocale, agentReplyLocale) => {
    const snapshot = resolveLanguageContextSnapshot({
      uiLocale,
      agentReplyLocalePreference: agentReplyLocale,
    });

    expect(snapshot).toEqual({
      version: 1,
      uiLocale,
      agentReplyLocale,
      uiLocaleSource: 'user_preference',
      agentReplyLocaleSource: 'user_preference',
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it('stores the reply preference per user and defaults invalid or missing data safely', () => {
    const storage = createMemoryStorage();

    expect(readAgentReplyLocalePreference(storage, 'user-a')).toBe('zh-CN');
    expect(writeAgentReplyLocalePreference(storage, 'user-a', 'en-US')).toBe(true);
    expect(readAgentReplyLocalePreference(storage, 'user-a')).toBe('en-US');
    expect(readAgentReplyLocalePreference(storage, 'user-b')).toBe('zh-CN');

    storage.setItem(agentReplyLocaleStorageKey('user-a'), 'not-a-locale');
    expect(readAgentReplyLocalePreference(storage, 'user-a')).toBe('zh-CN');
  });

  it('uses an existing session choice without mutating it when the user default changes', () => {
    const existing = resolveLanguageContextSnapshot({
      uiLocale: 'zh-CN',
      agentReplyLocalePreference: 'zh-CN',
      sessionAgentReplyLocale: 'en-US',
    });
    const nextSession = resolveLanguageContextSnapshot({
      uiLocale: 'zh-CN',
      agentReplyLocalePreference: 'zh-CN',
    });

    expect(existing.agentReplyLocale).toBe('en-US');
    expect(existing.agentReplyLocaleSource).toBe('session_snapshot');
    expect(nextSession.agentReplyLocale).toBe('zh-CN');
    expect(nextSession.agentReplyLocaleSource).toBe('user_preference');
  });

  it.each(['zh-CN', 'en-US'] as const)('normalizes stored BCP47 variants for %s', (locale) => {
    const storage = createMemoryStorage();
    const variant = locale === 'zh-CN' ? 'zh_cn' : 'EN-us';
    storage.setItem(agentReplyLocaleStorageKey('user-a'), variant);

    expect(readAgentReplyLocalePreference(storage, 'user-a')).toBe<AppLocale>(locale);
  });
});
