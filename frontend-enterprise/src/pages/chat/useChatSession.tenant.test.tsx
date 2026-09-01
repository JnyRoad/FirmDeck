// @vitest-environment jsdom

import fs from 'node:fs';
import path from 'node:path';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import {
  createContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StreamEvent } from '@/api/client';
import { I18nProvider } from '@/i18n';
import type {
  AgentProfileRead,
  ChatMessage,
  ChatSession,
  HumanHandoffRead,
  ModelConfigRead,
  ScheduledTaskDraftRead,
} from '@/types';

import { useChatSession } from './useChatSession';

const streamChatTurnMock = vi.hoisted(() => vi.fn());
const uploadChatAttachmentsMock = vi.hoisted(() => vi.fn());
const toastSpies = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  loading: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
}));

vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return {
    ...actual,
    streamChatTurn: streamChatTurnMock,
    uploadChatAttachments: uploadChatAttachmentsMock,
  };
});

vi.mock('@/components/ui/app-toast', () => ({ notify: toastSpies }));

const AUTH_STORAGE_KEY = 'ultrarag_auth';
const TENANT_CONTEXT_MODULE_PATH = '../../contexts/TenantSessionContext';

type TenantAuthSessionFixture = {
  token: string;
  scope: 'tenant';
  tenant: {
    id: string;
    slug: string;
    display_name: string;
  };
  user: {
    id: string;
    tenant_id: string;
    username: string;
    display_name: string | null;
    role: 'admin' | 'member';
    must_change_password: boolean;
    avatar_url: string | null;
  };
};

type TenantSessionContextValue = {
  session: TenantAuthSessionFixture;
  tenantId: string;
  tenantSlug: string;
  userId: string;
  generation: number;
  signal: AbortSignal;
  isCurrentGeneration(generation: number): boolean;
};

type TenantSessionContextModule = {
  TenantSessionProvider: (props: {
    session: TenantAuthSessionFixture | null;
    children: ReactNode;
    onInvalidSession?: () => void;
  }) => JSX.Element;
  useTenantSession: () => TenantSessionContextValue | null;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/** 严格的租户会话 fixture；没有 deployment-wide tenant fallback。 */
function tenantAuthSession(tenantId: string, userId = `user-${tenantId}`): TenantAuthSessionFixture {
  return {
    token: `token-${tenantId}`,
    scope: 'tenant',
    tenant: {
      id: tenantId,
      slug: `${tenantId}-slug`,
      display_name: tenantId,
    },
    user: {
      id: userId,
      tenant_id: tenantId,
      username: 'admin',
      display_name: `${tenantId} operator`,
      role: 'admin',
      must_change_password: false,
      avatar_url: null,
    },
  };
}

function readStoredTenantSession(): TenantAuthSessionFixture {
  return JSON.parse(window.localStorage.getItem(AUTH_STORAGE_KEY) || '{}') as TenantAuthSessionFixture;
}

const LocalTenantContext = createContext<TenantSessionContextValue | null>(null);

/**
 * T030 的 RED fallback：在 T032 context 尚未存在时，仍先以 /api/auth/me 验证完整租户身份，
 * 再挂载 useChatSession。T032 文件出现后，renderVerifiedTenantHook 会优先使用正式 Provider。
 */
function LocalVerifiedTenantProvider({
  session,
  children,
}: {
  session: TenantAuthSessionFixture;
  children: ReactNode;
}) {
  const [verified, setVerified] = useState(false);
  const [generation] = useState(() => Date.now());
  const [controller] = useState(() => new AbortController());

  useEffect(() => {
    let active = true;
    setVerified(false);
    void fetch('/api/auth/me', {
      headers: { Authorization: `Bearer ${session.token}` },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('tenant verification failed');
        return response.json() as Promise<Record<string, unknown>>;
      })
      .then((user) => {
        if (
          active
          && user.id === session.user.id
          && user.tenant_id === session.tenant.id
        ) {
          setVerified(true);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
      controller.abort();
    };
  }, [controller, session]);

  const value = useMemo<TenantSessionContextValue>(() => ({
    session,
    tenantId: session.tenant.id,
    tenantSlug: session.tenant.slug,
    userId: session.user.id,
    generation,
    signal: controller.signal,
    isCurrentGeneration: (candidate) => candidate === generation && !controller.signal.aborted,
  }), [controller, generation, session]);

  return (
    <LocalTenantContext.Provider value={verified ? value : null}>
      {verified ? children : null}
    </LocalTenantContext.Provider>
  );
}

function isMissingTenantContextModule(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Cannot find|Failed to resolve|Unknown variable dynamic import|does not exist/i.test(message);
}

async function loadTenantContext(): Promise<TenantSessionContextModule | null> {
  try {
    const module = await import(/* @vite-ignore */ TENANT_CONTEXT_MODULE_PATH) as unknown as TenantSessionContextModule;
    if (typeof module.TenantSessionProvider !== 'function' || typeof module.useTenantSession !== 'function') {
      throw new Error(`T032 module ${TENANT_CONTEXT_MODULE_PATH} has no verified provider contract`);
    }
    return module;
  } catch (error) {
    if (isMissingTenantContextModule(error)) return null;
    throw new Error(`T032 tenant context loader failed: ${String(error)}`);
  }
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify(body ?? {}),
    json: async () => body,
  } as Response;
}

function tenantSession(tenantId: string, sessionId: string, userId = `user-${tenantId}`): ChatSession {
  return {
    id: sessionId,
    tenant_id: tenantId,
    user_id: userId,
    agent_id: 'agent-1',
    status: 'active',
    title: `${tenantId} conversation`,
    updated_at: '2026-08-31T00:00:00Z',
  };
}

const agent: AgentProfileRead = {
  id: 'agent-1',
  tenant_id: 'tenant-a',
  name: 'Test agent',
  is_overall: false,
  status: 'active',
  metadata: {},
  resources: [],
  created_at: '2026-08-31T00:00:00Z',
  updated_at: '2026-08-31T00:00:00Z',
};

const modelConfig: ModelConfigRead = {
  id: 'model-1',
  tenant_id: 'tenant-a',
  name: 'Test model',
  provider: 'openai',
  auth_mode: 'api_key',
  api_protocol: 'openai_chat_completions',
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
  updated_at: '2026-08-31T00:00:00Z',
};

type FetchCall = [RequestInfo | URL, RequestInit | undefined];

type TenantRequestHandler = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Response | Promise<Response> | undefined;

function stubTenantFetch(options: {
  sessions?: Promise<Response>;
  events?: Promise<Response>;
  sessionList?: ChatSession[];
  selectedSessions?: Record<string, ChatSession>;
  verifiedSession?: TenantAuthSessionFixture | ((init?: RequestInit) => TenantAuthSessionFixture);
  requestHandler?: TenantRequestHandler;
}) {
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push([input, init]);
    const url = String(input);
    if (url.includes('/api/auth/me')) {
      const verifiedSession = typeof options.verifiedSession === 'function'
        ? options.verifiedSession(init)
        : options.verifiedSession || readStoredTenantSession();
      return Promise.resolve(jsonResponse(verifiedSession.user));
    }
    const customResponse = options.requestHandler?.(input, init);
    if (customResponse !== undefined) return Promise.resolve(customResponse);
    if (url.includes('/api/chat/sessions?')) {
      return options.sessions || Promise.resolve(jsonResponse(options.sessionList || []));
    }
    const selected = Object.entries(options.selectedSessions || {})
      .find(([id]) => url.includes(`/api/chat/sessions/${id}?`))?.[1];
    if (selected) return Promise.resolve(jsonResponse(selected));
    if (url.includes('/api/chat/sessions/') && url.includes('/events?')) {
      return options.events || Promise.resolve(jsonResponse([]));
    }
    if (url.includes('/api/chat/sessions/') && url.includes('/messages?')) return Promise.resolve(jsonResponse([]));
    if (url.includes('/api/chat/sessions/') && url.includes('/trace?')) return Promise.resolve(jsonResponse([]));
    if (url.includes('/api/chat/agents?')) return Promise.resolve(jsonResponse([agent]));
    if (url.includes('/api/enterprise/model-configs?')) return Promise.resolve(jsonResponse([modelConfig]));
    if (url.includes('/api/chat/handoffs?')) return Promise.resolve(jsonResponse([]));
    if (url.includes('/api/chat/ui-config?')) return Promise.resolve(jsonResponse({}));
    if (url.includes('/api/chat/')) return Promise.resolve(jsonResponse([]));
    if (url.includes('/api/enterprise/')) return Promise.resolve(jsonResponse([]));
    return Promise.resolve(jsonResponse({}));
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

async function renderVerifiedTenantHook(
  initialPath: string,
  session: TenantAuthSessionFixture,
  options: Parameters<typeof useChatSession>[0] = {},
) {
  const context = await loadTenantContext();
  const Provider = context?.TenantSessionProvider || LocalVerifiedTenantProvider;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider session={session}>
      <I18nProvider>
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route path="/workspace/chat/:sessionId" element={<>{children}</>} />
            <Route path="/workspace/chat" element={<>{children}</>} />
            <Route path="/workspace/gallery" element={<>{children}</>} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>
    </Provider>
  );
  return renderHook(() => useChatSession(options), { wrapper });
}

/** 渲染一个可替换已验证租户的 hook；切换保留 hook 实例以复现旧请求跨 generation 收敛。 */
async function renderSwitchableTenantHook(
  initialPath: string,
  session: TenantAuthSessionFixture,
  options: Parameters<typeof useChatSession>[0] = {},
) {
  const context = await loadTenantContext();
  const Provider = context?.TenantSessionProvider || LocalVerifiedTenantProvider;
  let currentSession = session;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider session={currentSession}>
      <I18nProvider>
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route path="/workspace/chat/:sessionId" element={<>{children}</>} />
            <Route path="/workspace/chat" element={<>{children}</>} />
            <Route path="/workspace/gallery" element={<>{children}</>} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>
    </Provider>
  );
  const hook = renderHook(() => useChatSession(options), { wrapper });

  /** 切换到下一已验证租户并等待新 generation 对 hook 可见。 */
  const switchTenant = async (nextSession: TenantAuthSessionFixture) => {
    currentSession = nextSession;
    await act(async () => {
      hook.rerender();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(hook.result.current.auth?.tenant.id).toBe(nextSession.tenant.id);
    });
  };

  return { hook, switchTenant };
}

/** 构造带稳定 ID 的人工接续 fixture，供跨租户同 ID 竞争测试复用。 */
function tenantHandoff(tenantId: string, handoffId = 'handoff-shared'): HumanHandoffRead {
  return {
    id: handoffId,
    tenant_id: tenantId,
    session_id: 'session-shared',
    agent_id: 'agent-1',
    status: 'pending',
    created_at: '2026-08-31T00:00:00Z',
    updated_at: '2026-08-31T00:00:00Z',
  };
}

/** 构造带指定反馈状态的消息 fixture，供反馈回滚隔离测试复用。 */
function tenantMessage(feedbackRating: ChatMessage['feedback_rating']): ChatMessage {
  return {
    id: 'message-shared',
    role: 'assistant',
    content: 'Shared tenant message',
    created_at: '2026-08-31T00:00:00Z',
    feedback_rating: feedbackRating,
  };
}

const scheduledTaskDraft: ScheduledTaskDraftRead = {
  should_create: true,
  tenant_id: 'tenant-a',
  agent_id: 'agent-1',
  title: 'Shared scheduled task',
  prompt: 'Run the shared task',
  schedule_type: 'daily',
  schedule: { hour: 9 },
  timezone: 'UTC',
  confidence: 0.99,
};

beforeEach(() => {
  window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(tenantAuthSession('tenant-a')));
  streamChatTurnMock.mockReset();
  uploadChatAttachmentsMock.mockReset();
  toastSpies.error.mockReset();
  toastSpies.info.mockReset();
  toastSpies.loading.mockReset();
  toastSpies.success.mockReset();
  toastSpies.warning.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('useChatSession tenant replacement RED contracts', () => {
  it('aborts an ordinary tenant request when tenant A is replaced', async () => {
    const sessions = deferred<Response>();
    const sessionA = tenantAuthSession('tenant-a');
    const { calls } = stubTenantFetch({ sessions: sessions.promise, verifiedSession: sessionA });
    const hook = await renderVerifiedTenantHook('/workspace/chat/session-a', sessionA);

    await waitFor(() => {
      expect(calls.some(([input]) => String(input).includes('/api/chat/sessions?'))).toBe(true);
    });
    const sessionCall = calls.find(([input]) => String(input).includes('/api/chat/sessions?'));
    hook.unmount();

    const signal = sessionCall?.[1]?.signal as AbortSignal | undefined;
    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(true);
    expect(String(sessionCall?.[0])).toContain('tenant-a');
    expect(String(sessionCall?.[0])).not.toContain('tenant_demo');
    sessions.resolve(jsonResponse([]));
  });

  it('aborts the active chat SSE when tenant A is replaced', async () => {
    const stream = deferred<void>();
    let streamSignal: AbortSignal | undefined;
    streamChatTurnMock.mockImplementation(async (
      _body: Record<string, unknown>,
      _onEvent: (event: StreamEvent) => void,
      signal?: AbortSignal,
    ) => {
      streamSignal = signal;
      return stream.promise;
    });
    const sessionA = tenantAuthSession('tenant-a');
    stubTenantFetch({
      verifiedSession: sessionA,
      sessionList: [tenantSession('tenant-a', 'session-a')],
      selectedSessions: { 'session-a': tenantSession('tenant-a', 'session-a') },
    });
    const hook = await renderVerifiedTenantHook('/workspace/chat/session-a', sessionA, { embedded: true });

    await waitFor(() => {
      expect(hook.result.current.sessionsLoading).toBe(false);
      expect(hook.result.current.selectedModelConfig?.id).toBe('model-1');
    });
    act(() => hook.result.current.setInput('tenant A message'));
    act(() => {
      void hook.result.current.send();
    });
    await waitFor(() => expect(streamChatTurnMock).toHaveBeenCalledTimes(1));

    expect(streamChatTurnMock.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      tenant_id: 'tenant-a',
    }));
    expect(streamChatTurnMock.mock.calls[0]?.[0]).not.toEqual(expect.objectContaining({
      tenant_id: 'tenant_demo',
    }));
    hook.unmount();
    expect(streamSignal).toBeDefined();
    expect(streamSignal?.aborted).toBe(true);
    stream.resolve();
  });

  it('aborts an upload started in tenant A during teardown', async () => {
    const upload = deferred<unknown>();
    let uploadSignal: AbortSignal | undefined;
    uploadChatAttachmentsMock.mockImplementation(async (
      _tenantId: string,
      _files: File[],
      signal?: AbortSignal,
    ) => {
      uploadSignal = signal;
      return upload.promise;
    });
    const sessionA = tenantAuthSession('tenant-a');
    stubTenantFetch({ verifiedSession: sessionA, sessionList: [] });
    const hook = await renderVerifiedTenantHook('/workspace/chat', sessionA);

    await waitFor(() => expect(hook.result.current.auth?.user.tenant_id).toBe('tenant-a'));

    act(() => {
      hook.result.current.uploadComposerFiles([
        new File(['tenant A attachment'], 'a.txt', { type: 'text/plain' }),
      ]);
    });
    await waitFor(() => expect(uploadChatAttachmentsMock).toHaveBeenCalledTimes(1));

    expect(uploadChatAttachmentsMock.mock.calls[0]?.[0]).toBe('tenant-a');
    expect(uploadChatAttachmentsMock.mock.calls[0]?.[0]).not.toBe('tenant_demo');
    hook.unmount();
    expect(uploadSignal).toBeDefined();
    expect(uploadSignal?.aborted).toBe(true);
    upload.resolve([]);
  });

  it('aborts scheduled-session event polling during tenant teardown', async () => {
    const events = deferred<Response>();
    const sessionA = tenantAuthSession('tenant-a');
    const { calls } = stubTenantFetch({
      verifiedSession: sessionA,
      events: events.promise,
      sessionList: [tenantSession('tenant-a', 'session-a')],
      selectedSessions: { 'session-a': tenantSession('tenant-a', 'session-a') },
    });
    const hook = await renderVerifiedTenantHook('/workspace/chat/session-a', sessionA);

    await waitFor(() => {
      expect(calls.some(([input]) => String(input).includes('/api/chat/sessions/session-a/events?'))).toBe(true);
    });
    const eventCall = calls.find(([input]) => String(input).includes('/api/chat/sessions/session-a/events?'));
    hook.unmount();

    const signal = eventCall?.[1]?.signal as AbortSignal | undefined;
    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(true);
    events.resolve(jsonResponse([]));
  });

  it('rejects tenant A late session data after unmount before tenant B can render it', async () => {
    const tenantAList = deferred<Response>();
    let listRequestCount = 0;
    const calls: FetchCall[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init]);
      const url = String(input);
      if (url.includes('/api/auth/me')) {
        const verifiedSession = readStoredTenantSession();
        return Promise.resolve(jsonResponse(verifiedSession.user));
      }
      if (url.includes('/api/chat/sessions?')) {
        listRequestCount += 1;
        if (listRequestCount === 1) return tenantAList.promise;
        return Promise.resolve(jsonResponse([tenantSession('tenant-b', 'session-b', 'user-tenant-b')]));
      }
      if (url.includes('/api/chat/sessions/session-a?')) {
        return Promise.resolve(jsonResponse(tenantSession('tenant-a', 'session-a')));
      }
      if (url.includes('/api/chat/sessions/session-b?')) {
        return Promise.resolve(jsonResponse(tenantSession('tenant-b', 'session-b', 'user-tenant-b')));
      }
      if (url.includes('/api/chat/agents?')) return Promise.resolve(jsonResponse([agent]));
      if (url.includes('/api/enterprise/model-configs?')) return Promise.resolve(jsonResponse([modelConfig]));
      if (url.includes('/api/chat/handoffs?')) return Promise.resolve(jsonResponse([]));
      if (url.includes('/api/chat/ui-config?')) return Promise.resolve(jsonResponse({}));
      if (url.includes('/api/chat/sessions/') && url.includes('/events?')) return Promise.resolve(jsonResponse([]));
      if (url.includes('/api/chat/sessions/') && url.includes('/messages?')) return Promise.resolve(jsonResponse([]));
      if (url.includes('/api/chat/sessions/') && url.includes('/trace?')) return Promise.resolve(jsonResponse([]));
      if (url.includes('/api/chat/')) return Promise.resolve(jsonResponse([]));
      if (url.includes('/api/enterprise/')) return Promise.resolve(jsonResponse([]));
      return Promise.resolve(jsonResponse({}));
    });
    vi.stubGlobal('fetch', fetchMock);

    const sessionA = tenantAuthSession('tenant-a');
    const first = await renderVerifiedTenantHook('/workspace/chat/session-a', sessionA);
    await waitFor(() => expect(listRequestCount).toBe(1));
    const firstListCall = calls.find(([input]) => String(input).includes('/api/chat/sessions?'));
    first.unmount();

    const sessionB = tenantAuthSession('tenant-b', 'user-tenant-b');
    window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(sessionB));
    const second = await renderVerifiedTenantHook('/workspace/chat/session-b', sessionB);
    await waitFor(() => {
      expect(second.result.current.sessionsLoading).toBe(false);
      expect(second.result.current.sessions.map((session) => session.id)).toEqual(['session-b']);
    });

    tenantAList.resolve(jsonResponse([tenantSession('tenant-a', 'session-a')]));
    await act(async () => {
      await Promise.resolve();
    });
    expect(second.result.current.sessions.map((session) => session.id)).not.toContain('session-a');
    const signal = firstListCall?.[1]?.signal as AbortSignal | undefined;
    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(true);
  });
});

describe('useChatSession tenant client callback dependencies', () => {
  const callbackBoundaries = [
    ['replyToHandoff', '  /** 校验并提交人工接续文本'] as const,
    ['saveRename', '  const requestDelete'] as const,
    ['confirmDeleteSession', '  const abortStream'] as const,
    ['abortStream', '  /** 保存消息反馈'] as const,
    ['rateMessage', '  /** 将用户确认的定时任务'] as const,
    ['confirmScheduledTask', '  const dismissScheduledTaskDraft'] as const,
  ];

  it.each(callbackBoundaries)('includes tenantClient in %s dependencies', (callbackName, endMarker) => {
    const source = fs.readFileSync(path.resolve(__dirname, 'useChatSession.ts'), 'utf8');
    const start = source.indexOf(`  const ${callbackName} = useCallback`);
    const end = source.indexOf(endMarker, start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const block = source.slice(start, end);
    const dependencyList = block.match(/\}, \[([\s\S]*)\]\);\s*$/)?.[1] || '';
    expect(dependencyList.split(',').map((dependency) => dependency.trim())).toContain('tenantClient');
  });
});

/** 读取请求 URL 中由 tenant client 注入的租户身份。 */
function requestTenantId(input: RequestInfo | URL): string {
  return new URL(String(input), window.location.origin).searchParams.get('tenant_id') || '';
}

/** 读取请求路径以便测试只拦截目标 API 调用。 */
function requestPath(input: RequestInfo | URL): string {
  return new URL(String(input), window.location.origin).pathname;
}

/** 按请求 bearer 返回对应租户 fixture，模拟 provider 的服务端身份验证。 */
function verifiedSessionForRequest(
  sessionA: TenantAuthSessionFixture,
  sessionB: TenantAuthSessionFixture,
) {
  return (init?: RequestInit) => {
    const authorization = new Headers(init?.headers).get('Authorization');
    return authorization === `Bearer ${sessionB.token}` ? sessionB : sessionA;
  };
}

describe('useChatSession stale tenant callback side effects', () => {
  it('does not toast or remove the current handoff when an old reply is superseded', async () => {
    const replyRequest = deferred<Response>();
    const sessionA = tenantAuthSession('tenant-a');
    const sessionB = tenantAuthSession('tenant-b', 'user-tenant-b');
    const handoffA = tenantHandoff('tenant-a');
    const handoffB = tenantHandoff('tenant-b');
    const { fetchMock } = stubTenantFetch({
      verifiedSession: verifiedSessionForRequest(sessionA, sessionB),
      requestHandler: (input, init) => {
        const tenantId = requestTenantId(input);
        const pathname = requestPath(input);
        if (pathname === '/api/chat/handoffs' && tenantId === 'tenant-a') {
          return jsonResponse([handoffA]);
        }
        if (pathname === '/api/chat/handoffs' && tenantId === 'tenant-b') {
          return jsonResponse([handoffB]);
        }
        if (
          pathname === `/api/chat/handoffs/${handoffA.id}/reply`
          && tenantId === 'tenant-a'
          && init?.method === 'POST'
        ) {
          return replyRequest.promise;
        }
        return undefined;
      },
    });
    const { hook, switchTenant } = await renderSwitchableTenantHook('/workspace/chat', sessionA);

    await waitFor(() => expect(hook.result.current.handoffs).toEqual([handoffA]));
    act(() => hook.result.current.setHandoffReplies({ [handoffA.id]: 'tenant A reply' }));
    act(() => hook.result.current.submitHandoffReply(handoffA));
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => (
      requestPath(input) === `/api/chat/handoffs/${handoffA.id}/reply`
      && init?.method === 'POST'
    ))).toBe(true));

    await switchTenant(sessionB);
    await waitFor(() => expect(hook.result.current.handoffs).toEqual([handoffB]));
    replyRequest.resolve(jsonResponse(handoffA));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(hook.result.current.handoffs).toEqual([handoffB]);
    expect(toastSpies.success).not.toHaveBeenCalled();
    expect(toastSpies.error).not.toHaveBeenCalled();
  });

  it('does not toast or replace the current session when an old rename is superseded', async () => {
    const renameRequest = deferred<Response>();
    const sessionA = tenantAuthSession('tenant-a');
    const sessionB = tenantAuthSession('tenant-b', 'user-tenant-b');
    const sessionARecord = tenantSession('tenant-a', 'session-shared');
    const sessionBRecord = tenantSession('tenant-b', 'session-shared', 'user-tenant-b');
    const { fetchMock } = stubTenantFetch({
      sessionList: [sessionARecord],
      verifiedSession: verifiedSessionForRequest(sessionA, sessionB),
      requestHandler: (input, init) => {
        const tenantId = requestTenantId(input);
        const pathname = requestPath(input);
        if (pathname === '/api/chat/sessions' && tenantId === 'tenant-b') {
          return jsonResponse([sessionBRecord]);
        }
        if (
          pathname === `/api/chat/sessions/${sessionARecord.id}`
          && tenantId === 'tenant-a'
          && init?.method === 'PUT'
        ) {
          return renameRequest.promise;
        }
        return undefined;
      },
    });
    const { hook, switchTenant } = await renderSwitchableTenantHook('/workspace/chat', sessionA);

    await waitFor(() => expect(hook.result.current.sessions).toEqual([sessionARecord]));
    act(() => {
      hook.result.current.openRename(sessionARecord);
      hook.result.current.setRenameTitle('tenant A renamed');
    });
    const pendingRename = hook.result.current.saveRename();
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => (
      requestPath(input) === `/api/chat/sessions/${sessionARecord.id}`
      && init?.method === 'PUT'
    ))).toBe(true));

    await switchTenant(sessionB);
    await waitFor(() => expect(hook.result.current.sessions).toEqual([sessionBRecord]));
    renameRequest.resolve(jsonResponse({ ...sessionARecord, title: 'stale A title' }));

    await pendingRename;
    expect(hook.result.current.sessions).toEqual([sessionBRecord]);
    expect(toastSpies.success).not.toHaveBeenCalled();
    expect(toastSpies.error).not.toHaveBeenCalled();
  });

  it('does not toast or remove the current session when an old delete is superseded', async () => {
    const deleteRequest = deferred<Response>();
    const sessionA = tenantAuthSession('tenant-a');
    const sessionB = tenantAuthSession('tenant-b', 'user-tenant-b');
    const sessionARecord = tenantSession('tenant-a', 'session-shared');
    const sessionBRecord = tenantSession('tenant-b', 'session-shared', 'user-tenant-b');
    const { fetchMock } = stubTenantFetch({
      sessionList: [sessionARecord],
      verifiedSession: verifiedSessionForRequest(sessionA, sessionB),
      requestHandler: (input, init) => {
        const tenantId = requestTenantId(input);
        const pathname = requestPath(input);
        if (pathname === '/api/chat/sessions' && tenantId === 'tenant-b') {
          return jsonResponse([sessionBRecord]);
        }
        if (
          pathname === `/api/chat/sessions/${sessionARecord.id}`
          && tenantId === 'tenant-a'
          && init?.method === 'DELETE'
        ) {
          return deleteRequest.promise;
        }
        return undefined;
      },
    });
    const { hook, switchTenant } = await renderSwitchableTenantHook('/workspace/chat', sessionA);

    await waitFor(() => expect(hook.result.current.sessions).toEqual([sessionARecord]));
    act(() => hook.result.current.requestDelete(sessionARecord));
    const pendingDelete = hook.result.current.confirmDeleteSession();
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => (
      requestPath(input) === `/api/chat/sessions/${sessionARecord.id}`
      && init?.method === 'DELETE'
    ))).toBe(true));

    await switchTenant(sessionB);
    await waitFor(() => expect(hook.result.current.sessions).toEqual([sessionBRecord]));
    deleteRequest.resolve(jsonResponse({}));

    await pendingDelete;
    expect(hook.result.current.sessions).toEqual([sessionBRecord]);
    expect(toastSpies.success).not.toHaveBeenCalled();
    expect(toastSpies.error).not.toHaveBeenCalled();
  });

  it('only restores feedback in the current workspace when an old rating is superseded', async () => {
    const feedbackRequest = deferred<Response>();
    const sessionA = tenantAuthSession('tenant-a');
    const sessionB = tenantAuthSession('tenant-b', 'user-tenant-b');
    const sessionARecord = tenantSession('tenant-a', 'session-shared');
    const sessionBRecord = tenantSession('tenant-b', 'session-shared', 'user-tenant-b');
    const messageA = tenantMessage('up');
    const messageB = tenantMessage('down');
    const { fetchMock } = stubTenantFetch({
      sessionList: [],
      verifiedSession: verifiedSessionForRequest(sessionA, sessionB),
      requestHandler: (input, init) => {
        const tenantId = requestTenantId(input);
        const pathname = requestPath(input);
        if (pathname === '/api/chat/sessions' && tenantId === 'tenant-b') {
          return jsonResponse([]);
        }
        if (
          pathname === `/api/chat/sessions/${sessionARecord.id}`
          && (tenantId === 'tenant-a' || tenantId === 'tenant-b')
          && init?.method === 'GET'
        ) {
          return Promise.reject(new Error('selected session is outside this test'));
        }
        if (
          pathname === `/api/chat/sessions/${sessionARecord.id}/messages`
          && tenantId === 'tenant-a'
        ) {
          return jsonResponse([messageA]);
        }
        if (
          pathname === `/api/chat/sessions/${sessionBRecord.id}/messages`
          && tenantId === 'tenant-b'
        ) {
          return jsonResponse([messageB]);
        }
        if (
          pathname === `/api/chat/messages/${messageA.id}/feedback`
          && tenantId === 'tenant-a'
          && init?.method === 'POST'
        ) {
          return feedbackRequest.promise;
        }
        return undefined;
      },
    });
    const { hook, switchTenant } = await renderSwitchableTenantHook('/workspace/chat/session-shared', sessionA);

    await waitFor(() => expect(hook.result.current.displayedMessages).toEqual([messageA]));
    const pendingFeedback = hook.result.current.rateMessage(messageA, 'down');
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => (
      requestPath(input) === `/api/chat/messages/${messageA.id}/feedback`
      && init?.method === 'POST'
    ))).toBe(true));

    await switchTenant(sessionB);
    await waitFor(() => expect(hook.result.current.displayedMessages).toEqual([messageB]));
    feedbackRequest.resolve(jsonResponse({}));

    await pendingFeedback;
    expect(hook.result.current.displayedMessages).toEqual([messageB]);
    expect(hook.result.current.displayedMessages[0]?.feedback_rating).toBe('down');
    expect(toastSpies.error).not.toHaveBeenCalled();
  });

  it('does not toast or create a task when an old scheduled-task confirmation is superseded', async () => {
    const scheduledTaskRequest = deferred<Response>();
    const sessionA = tenantAuthSession('tenant-a');
    const sessionB = tenantAuthSession('tenant-b', 'user-tenant-b');
    const sessionARecord = tenantSession('tenant-a', 'session-shared');
    const { fetchMock } = stubTenantFetch({
      sessionList: [],
      verifiedSession: verifiedSessionForRequest(sessionA, sessionB),
      requestHandler: (input, init) => {
        const tenantId = requestTenantId(input);
        const pathname = requestPath(input);
        if (pathname === '/api/chat/sessions' && tenantId === 'tenant-b') {
          return jsonResponse([]);
        }
        if (
          pathname === `/api/chat/sessions/${sessionARecord.id}`
          && (tenantId === 'tenant-a' || tenantId === 'tenant-b')
          && init?.method === 'GET'
        ) {
          return Promise.reject(new Error('selected session is outside this test'));
        }
        if (
          pathname === '/api/chat/scheduled-tasks'
          && tenantId === 'tenant-a'
          && init?.method === 'POST'
        ) {
          return scheduledTaskRequest.promise;
        }
        return undefined;
      },
    });
    const { hook, switchTenant } = await renderSwitchableTenantHook('/workspace/chat/session-shared', sessionA);

    await waitFor(() => expect(hook.result.current.auth?.tenant.id).toBe('tenant-a'));
    const pendingTask = hook.result.current.confirmScheduledTask(scheduledTaskDraft);
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => (
      requestPath(input) === '/api/chat/scheduled-tasks'
      && init?.method === 'POST'
    ))).toBe(true));

    await switchTenant(sessionB);
    scheduledTaskRequest.resolve(jsonResponse({ id: 'stale-task', title: scheduledTaskDraft.title }));

    await pendingTask;
    expect(hook.result.current.createdScheduledTasks).toEqual({});
    expect(toastSpies.success).not.toHaveBeenCalled();
    expect(toastSpies.error).not.toHaveBeenCalled();
  });
});
