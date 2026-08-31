// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StreamEvent } from '@/api/client';
import type { AppLocale } from '@/i18n/locales';
import { AppIntlProvider } from '@/i18n/provider';
import type { ChatSession, ModelConfigRead, TurnTraceRead } from '@/types';

import { useChatSession } from './useChatSession';

const streamChatTurnMock = vi.hoisted(() => vi.fn());

vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return { ...actual, streamChatTurn: streamChatTurnMock };
});

const AUTH_STORAGE_KEY = 'ultrarag_auth';
const SESSION_ID = 'session-i18n-event';
const RAW_USER_INPUT = 'RAW user input /路径?q=中文';
let traceRows: TurnTraceRead[] = [];

const session: ChatSession = {
  id: SESSION_ID,
  tenant_id: 'tenant_demo',
  user_id: 'user-1',
  agent_id: 'agent-1',
  status: 'active',
  title: 'Raw session title',
  updated_at: '2026-08-30T08:00:00.000Z',
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

/** 返回满足 api client 文本解析约定的 JSON Response。 */
function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify(body ?? {}),
  } as Response;
}

/** Stub Hook 所需端点，不向事件测试注入 legacy provider 或翻译层。 */
function stubChatFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes(`/api/chat/sessions/${SESSION_ID}/messages?`)) return jsonResponse([]);
    if (url.includes(`/api/chat/sessions/${SESSION_ID}/trace?`)) return jsonResponse(traceRows);
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

/** 仅通过 semantic Provider 挂载聊天 Hook，并固定现有会话边界。 */
function renderEventHook(locale: AppLocale) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AppIntlProvider initialLocale={locale}>
      <MemoryRouter>{children}</MemoryRouter>
    </AppIntlProvider>
  );
  return renderHook(() => useChatSession({ embedded: true, sessionId: SESSION_ID }), { wrapper });
}

/** 等待依赖就绪并开始一次不等待流终止的测试 turn。 */
async function startStreamingTurn(
  result: ReturnType<typeof renderEventHook>['result'],
): Promise<void> {
  await waitFor(() => {
    expect(result.current.sessionsLoading).toBe(false);
    expect(result.current.selectedModelConfig?.id).toBe('model-1');
  });
  act(() => result.current.setInput(RAW_USER_INPUT));
  act(() => { void result.current.send(); });
  await waitFor(() => expect(streamChatTurnMock).toHaveBeenCalledTimes(1));
}

/** 创建具备完整关联字段与不可变语言快照的 canonical SSE status 事件。 */
function canonicalRetryEvent(overrides: Record<string, unknown> = {}): StreamEvent {
  return {
    event: 'status',
    data: {
      event_type: 'status',
      code: 'agent.turn.retrying',
      params: { attempt: 2, max_attempts: 3 },
      request_id: 'req-event-1',
      trace_id: 'trace-event-1',
      language_context: {
        version: 1,
        ui_locale: 'en-US',
        agent_reply_locale: 'zh-CN',
        ui_locale_source: 'explicit_request',
        agent_reply_locale_source: 'session_snapshot',
      },
      phase: 'preparing',
      text: 'LEGACY_TEXT_MUST_NOT_DRIVE_UI',
      status_text: 'LEGACY_STATUS_MUST_NOT_DRIVE_UI',
      ...overrides,
    },
  };
}

beforeEach(() => {
  traceRows = [];
  window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({
    token: 'token-1',
    user: { id: 'user-1', tenant_id: 'tenant_demo', username: 'demo', role: 'admin' },
  }));
  stubChatFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('useChatSession canonical i18n events', () => {
  it.each([
    ['zh-CN', '生成定时任务草案'],
    ['en-US', 'Generated scheduled task draft'],
  ] as const)('re-localizes persisted structured traces for %s without backend text projection', async (locale, expected) => {
    traceRows = [{
      turn_id: 'turn-persisted-schedule',
      started_at: '2026-08-30T08:00:00.000Z',
      completed_at: '2026-08-30T08:00:01.000Z',
      lines: [{
        id: 'scheduled_task_draft',
        kind: 'decision',
        text: 'LEGACY_PERSISTED_TRACE_TEXT',
        detail: 'LEGACY_PERSISTED_TRACE_DETAIL',
        event_code: 'chat.scheduled.draft',
        params: {},
        event_data: {
          title: RAW_USER_INPUT,
          schedule_type: 'daily',
          schedule: { time: '16:50' },
        },
        state: 'completed',
      }],
    }];
    const { result } = renderEventHook(locale);

    await waitFor(() => {
      const line = result.current.turnTraceRef.current
        .get('turn-persisted-schedule')?.lines[0];
      expect(line?.text).toBe(expected);
      expect(line?.detail).toContain(RAW_USER_INPUT);
      expect(`${line?.text}\n${line?.detail}`).not.toContain('LEGACY_PERSISTED_TRACE');
    });
  });

  it.each([
    ['zh-CN', '任务帧操作已开始。'],
    ['en-US', 'The operation started.'],
  ] as const)('projects any registered persisted event code for %s', async (locale, expected) => {
    traceRows = [{
      turn_id: 'turn-persisted-event',
      started_at: '2026-08-30T08:00:00.000Z',
      lines: [{
        id: 'harness_frame_raw-id',
        kind: 'decision',
        text: 'LEGACY_GENERIC_TRACE_TEXT',
        event_type: 'task_frame_started',
        event_code: 'run.task.frame.started',
        params: {},
        event_data: { task_frame_id: 'raw-id' },
        state: 'running',
      }],
    }];
    const { result } = renderEventHook(locale);

    await waitFor(() => {
      const line = result.current.turnTraceRef.current.get('turn-persisted-event')?.lines[0];
      expect(line?.text).toBe(expected);
      expect(line?.text).not.toContain('LEGACY_GENERIC_TRACE_TEXT');
    });
  });

  it.each([
    ['zh-CN', '反思后重试（第 2 次，共 3 次）。'],
    ['en-US', 'Trying again after reflection (attempt 2 of 3).'],
  ] as const)('renders code/params for %s and never uses deprecated text projections', async (locale, expected) => {
    const event = canonicalRetryEvent();
    streamChatTurnMock.mockImplementation(async (
      _body: Record<string, unknown>,
      onEvent: (item: StreamEvent) => void,
    ) => {
      onEvent(event);
      await new Promise<void>(() => undefined);
    });
    const { result } = renderEventHook(locale);

    await startStreamingTurn(result);

    await waitFor(() => expect(result.current.currentStream.phase).toBe(expected));
    expect(result.current.currentStream.phase).not.toContain('LEGACY_');
    expect(event.data).toMatchObject({
      request_id: 'req-event-1',
      trace_id: 'trace-event-1',
      params: { attempt: 2, max_attempts: 3 },
      language_context: {
        ui_locale: 'en-US',
        agent_reply_locale: 'zh-CN',
      },
    });
  });

  it.each([
    ['unknown', canonicalRetryEvent({ code: 'agent.turn.not_registered' })],
    ['malformed', canonicalRetryEvent({ params: { attempt: 'two' } })],
  ])('fails closed for %s canonical envelopes instead of falling back to status_text', async (_case, event) => {
    streamChatTurnMock.mockImplementation(async (
      _body: Record<string, unknown>,
      onEvent: (item: StreamEvent) => void,
    ) => {
      onEvent(event as StreamEvent);
      await new Promise<void>(() => undefined);
    });
    const { result } = renderEventHook('en-US');

    await startStreamingTurn(result);

    expect(result.current.currentStream.phase).not.toContain('LEGACY_');
    const visibleTrace = Array.from(result.current.turnTraceRef.current.values())
      .flatMap((trace) => trace.lines)
      .map((line) => `${line.text}\n${line.detail || ''}`)
      .join('\n');
    expect(visibleTrace).not.toContain('LEGACY_');
  });

  it('keeps successful reply and provider data raw in their dedicated fields', async () => {
    const rawReply = 'Provider reply: 原文 <raw> /path';
    const providerData = { provider: 'vendor-x', finish_reason: '原始结束原因' };
    const event: StreamEvent = {
      event: 'stream_delta',
      data: {
        event_type: 'run.output.delta',
        code: 'agent.reply.delta',
        params: {},
        request_id: 'req-raw-1',
        trace_id: 'trace-raw-1',
        language_context: {
          version: 1,
          ui_locale: 'en-US',
          agent_reply_locale: 'zh-CN',
          ui_locale_source: 'explicit_request',
          agent_reply_locale_source: 'session_snapshot',
        },
        content: rawReply,
        provider_data: providerData,
      },
    };
    streamChatTurnMock.mockImplementation(async (
      _body: Record<string, unknown>,
      onEvent: (item: StreamEvent) => void,
    ) => {
      onEvent(event);
      await new Promise<void>(() => undefined);
    });
    const { result } = renderEventHook('en-US');

    await startStreamingTurn(result);

    await waitFor(() => {
      expect(result.current.displayedMessages.some((item) => item.content === rawReply)).toBe(true);
    });
    expect(event.data.provider_data).toEqual(providerData);
    expect(event.data.content).toBe(rawReply);
  });

  it('localizes general-skill trace chrome without rendering deprecated backend messages', async () => {
    const event: StreamEvent = {
      event: 'general_skill_trace',
      data: {
        phase: 'planning',
        message: 'LEGACY_GENERAL_SKILL_PRODUCT_TEXT',
        turn_id: 'turn-general-skill',
      },
    };
    streamChatTurnMock.mockImplementation(async (
      _body: Record<string, unknown>,
      onEvent: (item: StreamEvent) => void,
    ) => {
      onEvent(event);
      await new Promise<void>(() => undefined);
    });
    const { result } = renderEventHook('en-US');

    await startStreamingTurn(result);

    await waitFor(() => {
      const visibleTrace = Array.from(result.current.turnTraceRef.current.values())
        .flatMap((trace) => trace.lines)
        .map((line) => `${line.text}\n${line.detail || ''}`)
        .join('\n');
      expect(visibleTrace).toContain('Running general skill');
      expect(visibleTrace).not.toContain('LEGACY_GENERAL_SKILL_PRODUCT_TEXT');
    });
  });
});
