import { describe, expect, it } from 'vitest';

import {
  chatQueueStorageKey,
  readQueuedChatTurns,
  writeQueuedChatTurns,
  type PreparedChatTurn,
} from './chatQueueStorage';

type TestLocale = 'zh-CN' | 'en-US';

type TestLanguageContext = {
  version: 1;
  uiLocale: TestLocale;
  agentReplyLocale: TestLocale;
  uiLocaleSource: 'user_preference' | 'legacy_default';
  agentReplyLocaleSource: 'user_preference' | 'session_snapshot' | 'legacy_default';
};

/** 创建可观测的最小 Storage，实现队列读写与清理断言。 */
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

/** 构造带不可变语言快照的排队 turn，raw 用户输入不得经过翻译或重写。 */
function queuedTurn(languageContext: TestLanguageContext): PreparedChatTurn {
  return {
    queueId: 'queue-1',
    conversationId: 'draft:agent-1',
    agentId: 'agent-1',
    turnId: 'turn-1',
    text: 'RAW /workspace?q=中文 & keep=true',
    attachments: [],
    interactionMode: 'normal',
    modelConfigId: 'model-1',
    createdAt: '2026-08-30T08:00:00.000Z',
    languageContext,
  };
}

describe('chat queue language snapshots', () => {
  it.each([
    ['zh-CN', 'zh-CN'],
    ['zh-CN', 'en-US'],
    ['en-US', 'zh-CN'],
    ['en-US', 'en-US'],
  ] as const)('round-trips UI %s and reply %s independently', (uiLocale, agentReplyLocale) => {
    const storage = createMemoryStorage();
    const key = chatQueueStorageKey('tenant-1', 'user-1');
    const languageContext: TestLanguageContext = {
      version: 1,
      uiLocale,
      agentReplyLocale,
      uiLocaleSource: 'user_preference',
      agentReplyLocaleSource: 'user_preference',
    };

    expect(writeQueuedChatTurns(storage, key, [queuedTurn(languageContext)])).toBe(true);
    const restored = readQueuedChatTurns(storage, key);

    expect(restored).toHaveLength(1);
    expect(restored[0].languageContext).toEqual(languageContext);
    expect(restored[0].text).toBe('RAW /workspace?q=中文 & keep=true');

    expect(writeQueuedChatTurns(storage, key, restored)).toBe(true);
    expect(readQueuedChatTurns(storage, key)[0].languageContext).toEqual(languageContext);
  });

  it('backfills a deterministic legacy snapshot before a stored turn is resumed', () => {
    const storage = createMemoryStorage();
    const key = chatQueueStorageKey('tenant-1', 'user-1');
    const legacy = {
      ...queuedTurn({
        version: 1,
        uiLocale: 'en-US',
        agentReplyLocale: 'en-US',
        uiLocaleSource: 'user_preference',
        agentReplyLocaleSource: 'user_preference',
      }),
      languageContext: undefined,
    };
    storage.setItem(key, JSON.stringify([legacy]));

    expect(readQueuedChatTurns(storage, key)[0].languageContext).toEqual({
      version: 1,
      uiLocale: 'zh-CN',
      agentReplyLocale: 'zh-CN',
      uiLocaleSource: 'legacy_default',
      agentReplyLocaleSource: 'legacy_default',
    });
  });

  it('rejects a malformed durable language snapshot instead of changing it at resume time', () => {
    const storage = createMemoryStorage();
    const key = chatQueueStorageKey('tenant-1', 'user-1');
    const malformed = {
      ...queuedTurn({
        version: 1,
        uiLocale: 'zh-CN',
        agentReplyLocale: 'en-US',
        uiLocaleSource: 'user_preference',
        agentReplyLocaleSource: 'user_preference',
      }),
      languageContext: {
        version: 1,
        uiLocale: 'fr-FR',
        agentReplyLocale: 'en-US',
        uiLocaleSource: 'user_preference',
        agentReplyLocaleSource: 'user_preference',
      },
    };
    storage.setItem(key, JSON.stringify([malformed]));

    expect(readQueuedChatTurns(storage, key)).toEqual([]);
  });
});

describe('tenant/user chat queue namespace', () => {
  const languageContext: TestLanguageContext = {
    version: 1,
    uiLocale: 'zh-CN',
    agentReplyLocale: 'en-US',
    uiLocaleSource: 'user_preference',
    agentReplyLocaleSource: 'user_preference',
  };

  it('keeps queued turns isolated across tenants and tenant-local users', () => {
    const storage = createMemoryStorage();
    const tenantAUserA = chatQueueStorageKey('tenant-a', 'user-a');
    const tenantBUserA = chatQueueStorageKey('tenant-b', 'user-a');
    const tenantAUserB = chatQueueStorageKey('tenant-a', 'user-b');
    const turn = queuedTurn(languageContext);

    expect(tenantAUserA).not.toBe(tenantBUserA);
    expect(tenantAUserA).not.toBe(tenantAUserB);
    expect(writeQueuedChatTurns(storage, tenantAUserA, [turn])).toBe(true);
    expect(readQueuedChatTurns(storage, tenantAUserA)).toEqual([turn]);
    expect(readQueuedChatTurns(storage, tenantBUserA)).toEqual([]);
    expect(readQueuedChatTurns(storage, tenantAUserB)).toEqual([]);
  });

  it('does not adopt a queue saved under the old unscoped key', () => {
    const storage = createMemoryStorage();
    const legacyKey = 'skill_agent_chat_queue';
    const scopedKey = chatQueueStorageKey('tenant-a', 'user-a');
    const turn = queuedTurn(languageContext);
    storage.setItem(legacyKey, JSON.stringify([turn]));

    expect(readQueuedChatTurns(storage, scopedKey)).toEqual([]);
    expect(storage.getItem(legacyKey)).toBe(JSON.stringify([turn]));
  });

  it('fails closed instead of falling back to a default tenant for malformed identity', () => {
    expect(() => chatQueueStorageKey('', 'user-a')).toThrow(TypeError);
    expect(() => chatQueueStorageKey('tenant-a', '')).toThrow(TypeError);
  });

  it('round-trips raw turn text without locale rewriting in a tenant namespace', () => {
    const storage = createMemoryStorage();
    const key = chatQueueStorageKey('Tenant-A-中文', 'User-İ');
    const rawText = 'RAW /workspace?q=中文&keep=İ';
    const turn = { ...queuedTurn(languageContext), text: rawText };

    expect(writeQueuedChatTurns(storage, key, [turn])).toBe(true);
    expect(readQueuedChatTurns(storage, key)[0]?.text).toBe(rawText);
  });
});
