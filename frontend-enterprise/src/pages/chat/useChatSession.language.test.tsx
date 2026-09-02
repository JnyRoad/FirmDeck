// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StreamEvent } from '@/api/client';
import type { EnterpriseAuthSession } from '@/auth';
import { TenantSessionProvider } from '@/contexts/TenantSessionContext';
import { AppIntlProvider } from '@/i18n/provider';
import type { AppLocale } from '@/i18n/locales';
import type { ChatMessage, ChatSession, ModelConfigRead } from '@/types';

import { chatQueueStorageKey, type PreparedChatTurn } from './chatQueueStorage';
import ChatHeader from './components/ChatHeader';
import { useChatSession } from './useChatSession';

const streamChatTurnMock = vi.hoisted(() => vi.fn());

vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return { ...actual, streamChatTurn: streamChatTurnMock };
});

const AUTH_STORAGE_KEY = 'ultrarag_auth';
const SESSION_ID = 'session-language-1';
const RAW_USER_CONTENT = 'RAW /private/path?q=中文 & do-not-translate=true';

const tenantSession: EnterpriseAuthSession = {
  token: 'token-1',
  scope: 'tenant',
  tenant: {
    id: 'tenant_demo',
    slug: 'demo-lab',
    display_name: 'Demo Lab',
  },
  user: {
    id: 'user-1',
    tenant_id: 'tenant_demo',
    username: 'demo',
    display_name: 'Demo Operator',
    role: 'admin',
    must_change_password: false,
    avatar_url: null,
  },
};

const modelConfig: ModelConfigRead = {
  id: 'model-1',
  tenant_id: 'tenant_demo',
  name: 'Test model',
  provider: 'openai',
  auth_mode: 'api_key',
  api_protocol: 'openai_chat_completions',
  base_url: 'https://example.invalid',
  api_key_masked: '***',
  model: 'test-model',
  temperature: 0,
  max_output_tokens: 1024,
  extra_body: {},
  protocol_options: {},
  legacy_unmapped_options: {},
  trust_status: 'verified',
  verification_attempt_status: 'succeeded',
  config_revision: 1,
  security_revision: 1,
  is_default: true,
  enabled: true,
  updated_at: '2026-08-30T08:00:00.000Z',
};

const historyMessages: ChatMessage[] = [{
  id: 'message-raw-user',
  role: 'user',
  content: RAW_USER_CONTENT,
  created_at: '2026-08-30T07:00:00.000Z',
}];

/** 返回满足 api client 文本解析约定的 JSON Response。 */
function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body ?? {},
    text: async () => JSON.stringify(body ?? {}),
  } as Response;
}

/** 构造携带服务端权威回复语言的既有会话。 */
function sessionFor(agentReplyLocale: AppLocale): ChatSession & {
  agent_reply_locale: AppLocale;
  agent_reply_locale_source: 'session_snapshot';
} {
  return {
    id: SESSION_ID,
    tenant_id: 'tenant_demo',
    user_id: 'user-1',
    agent_id: 'agent-1',
    status: 'active',
    title: 'Raw session title / 不翻译',
    updated_at: '2026-08-30T08:00:00.000Z',
    agent_reply_locale: agentReplyLocale,
    agent_reply_locale_source: 'session_snapshot',
  };
}

/** Stub 当前 Hook 需要的只读端点，并保持历史消息原文不变。 */
function stubChatFetch(session: ChatSession): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/auth/me')) return jsonResponse(tenantSession.user);
    if (url.includes(`/api/chat/sessions/${SESSION_ID}/messages?`)) return jsonResponse(historyMessages);
    if (url.includes(`/api/chat/sessions/${SESSION_ID}/trace?`)) return jsonResponse([]);
    if (url.includes(`/api/chat/sessions/${SESSION_ID}/events?`)) return jsonResponse([]);
    if (url.includes(`/api/chat/sessions/${SESSION_ID}?`)) return jsonResponse(session);
    if (url.includes('/api/chat/sessions?')) return jsonResponse([session]);
    if (url.includes('/api/enterprise/model-configs?')) return jsonResponse([modelConfig]);
    if (url.includes('/api/chat/agents?')) return jsonResponse([]);
    if (url.includes('/api/chat/handoffs?')) return jsonResponse([]);
    if (url.includes('/api/chat/ui-config?')) return jsonResponse({});
    if (url.includes('/api/chat/')) return jsonResponse([]);
    if (url.includes('/api/enterprise/')) return jsonResponse([]);
    return jsonResponse({});
  }));
}

/** 仅用 semantic AppIntlProvider 装配 Hook，杜绝 legacy observer 提供语言行为。 */
function renderLanguageHook(uiLocale: AppLocale) {
  let controlledLocale = uiLocale;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AppIntlProvider locale={controlledLocale}>
      <TenantSessionProvider session={tenantSession}>
        <MemoryRouter>{children}</MemoryRouter>
      </TenantSessionProvider>
    </AppIntlProvider>
  );
  const hook = renderHook(() => useChatSession({ embedded: true, sessionId: SESSION_ID }), { wrapper });
  return {
    ...hook,
    setUiLocale(nextLocale: AppLocale) {
      controlledLocale = nextLocale;
      hook.rerender();
    },
  };
}

/** 等待会话与模型配置就绪后发送 raw 用户内容。 */
async function sendRawTurn(result: ReturnType<typeof renderLanguageHook>['result']): Promise<void> {
  await waitFor(() => {
    expect(result.current.sessionsLoading).toBe(false);
    expect(result.current.selectedModelConfig?.id).toBe('model-1');
  });
  act(() => result.current.setInput(RAW_USER_CONTENT));
  await act(async () => { await result.current.send(); });
  await waitFor(() => expect(streamChatTurnMock).toHaveBeenCalledTimes(1));
}

beforeEach(() => {
  window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(tenantSession));
  streamChatTurnMock.mockImplementation(async (
    _body: Record<string, unknown>,
    onEvent: (event: StreamEvent) => void,
  ) => {
    onEvent({
      event: 'complete',
      data: { session_id: SESSION_ID, sessionId: SESSION_ID, reply: 'RAW assistant reply' },
    });
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('useChatSession language snapshots', () => {
  it('renders an independent reply-language control in the chat header', () => {
    const setAgentReplyLocale = vi.fn();
    const chat = {
      auth: null,
      currentSession: null,
      openRename: vi.fn(),
      logout: vi.fn(),
      agentReplyLocale: 'en-US',
      agentReplyLocaleLocked: false,
      setAgentReplyLocale,
    } as unknown as ReturnType<typeof useChatSession>;

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(tenantSession.user)));
    render(
      <AppIntlProvider locale="en-US">
        <TenantSessionProvider session={tenantSession}>
          <MemoryRouter>
            <ChatHeader chat={chat} />
          </MemoryRouter>
        </TenantSessionProvider>
      </AppIntlProvider>,
    );

    const control = screen.getByRole('combobox', { name: 'Agent reply language' });
    expect((control as HTMLSelectElement).value).toBe('en-US');
    fireEvent.change(control, { target: { value: 'zh-CN' } });
    expect(setAgentReplyLocale).toHaveBeenCalledWith('zh-CN');
  });

  it.each([
    ['zh-CN', 'zh-CN'],
    ['zh-CN', 'en-US'],
    ['en-US', 'zh-CN'],
    ['en-US', 'en-US'],
  ] as const)('maps UI %s and session reply %s independently into the request', async (uiLocale, agentReplyLocale) => {
    const session = sessionFor(agentReplyLocale);
    stubChatFetch(session);
    const { result } = renderLanguageHook(uiLocale);

    await sendRawTurn(result);

    expect(streamChatTurnMock.mock.calls[0][0]).toMatchObject({
      message: RAW_USER_CONTENT,
      ui_locale: uiLocale,
      agent_reply_locale: agentReplyLocale,
      ui_locale_source: 'user_preference',
      agent_reply_locale_source: 'session_snapshot',
    });
  });

  it('resumes a queued turn with its original snapshot instead of current UI preferences', async () => {
    const session = sessionFor('zh-CN');
    const queued: PreparedChatTurn = {
      queueId: 'queue-restored',
      conversationId: SESSION_ID,
      agentId: 'agent-1',
      turnId: 'turn-restored',
      text: RAW_USER_CONTENT,
      attachments: [],
      interactionMode: 'normal',
      modelConfigId: 'model-1',
      createdAt: '2026-08-30T08:00:00.000Z',
      languageContext: {
        version: 1,
        uiLocale: 'en-US',
        agentReplyLocale: 'en-US',
        uiLocaleSource: 'user_preference',
        agentReplyLocaleSource: 'session_snapshot',
      },
    };
    window.sessionStorage.setItem(
      chatQueueStorageKey('tenant_demo', 'user-1'),
      JSON.stringify([queued]),
    );
    stubChatFetch(session);
    renderLanguageHook('zh-CN');

    await waitFor(() => expect(streamChatTurnMock).toHaveBeenCalledTimes(1));

    expect(streamChatTurnMock.mock.calls[0][0]).toMatchObject({
      message: RAW_USER_CONTENT,
      ui_locale: 'en-US',
      agent_reply_locale: 'en-US',
      ui_locale_source: 'user_preference',
      agent_reply_locale_source: 'session_snapshot',
    });
  });

  it('does not rewrite historical or raw user content when the UI locale changes', async () => {
    const session = sessionFor('en-US');
    stubChatFetch(session);
    const { result, setUiLocale } = renderLanguageHook('zh-CN');

    await waitFor(() => {
      expect(result.current.displayedMessages.some((item) => item.content === RAW_USER_CONTENT)).toBe(true);
    });
    act(() => setUiLocale('en-US'));

    expect(result.current.displayedMessages.find((item) => item.id === 'message-raw-user')?.content)
      .toBe(RAW_USER_CONTENT);
  });
});
