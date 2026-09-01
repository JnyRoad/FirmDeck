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
import type { AgentProfileRead, ChatSession, ModelConfigRead } from '@/types';

import { useChatSession } from './useChatSession';

const streamChatTurnMock = vi.hoisted(() => vi.fn());
const uploadChatAttachmentsMock = vi.hoisted(() => vi.fn());

vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return {
    ...actual,
    streamChatTurn: streamChatTurnMock,
    uploadChatAttachments: uploadChatAttachmentsMock,
  };
});

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

function stubTenantFetch(options: {
  sessions?: Promise<Response>;
  events?: Promise<Response>;
  sessionList?: ChatSession[];
  selectedSessions?: Record<string, ChatSession>;
  verifiedSession?: TenantAuthSessionFixture;
}) {
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push([input, init]);
    const url = String(input);
    if (url.includes('/api/auth/me')) {
      const verifiedSession = options.verifiedSession || readStoredTenantSession();
      return Promise.resolve(jsonResponse(verifiedSession.user));
    }
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

beforeEach(() => {
  window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(tenantAuthSession('tenant-a')));
  streamChatTurnMock.mockReset();
  uploadChatAttachmentsMock.mockReset();
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
