// @vitest-environment jsdom

import { createElement, type ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TenantSessionContextValue } from '@/contexts/TenantSessionContext';
import { notify } from '@/components/ui/app-toast';
import { I18nProvider, useAppIntl } from '@/i18n';
import type { CodexSubscriptionAccountRead } from '@/types';
import { useCodexSubscriptionAccount } from './useCodexSubscriptionAccount';

const testState = vi.hoisted(() => ({
  mockedGet: vi.fn(),
  mockedPost: vi.fn(),
  currentContext: null as TenantSessionContextValue | null,
}));

vi.mock('@/api/tenant-client', () => ({
  createTenantClient: vi.fn(() => ({
    get: testState.mockedGet,
    post: testState.mockedPost,
  })),
}));

vi.mock('@/contexts/TenantSessionContext', () => ({
  useTenantSession: () => testState.currentContext,
}));

const mockedGet = testState.mockedGet;
const mockedPost = testState.mockedPost;

const requiresLogin: CodexSubscriptionAccountRead = {
  status: 'requires_login',
  plan_type: null,
  message: '未登录',
};

const pending: CodexSubscriptionAccountRead = {
  status: 'pending',
  plan_type: null,
  message: '等待登录',
};

const connected: CodexSubscriptionAccountRead = {
  status: 'connected',
  plan_type: 'Plus',
  message: '已连接',
};

/** 为 hook 提供真实的应用本地化上下文。 */
function Wrapper({ children }: { children: ReactNode }) {
  return createElement(I18nProvider, null, children);
}

function makeTenantContext(tenantId: string, generation = 1): TenantSessionContextValue {
  const controller = new AbortController();
  return {
    session: {
      token: `token-${tenantId}`,
      scope: 'tenant',
      tenant: { id: tenantId, slug: tenantId, display_name: tenantId },
      user: {
        id: 'user-1',
        tenant_id: tenantId,
        username: 'test-user',
        display_name: 'Test User',
        role: 'admin',
        must_change_password: false,
        avatar_url: null,
      },
    },
    tenantId,
    tenantSlug: tenantId,
    userId: 'user-1',
    generation,
    signal: controller.signal,
    isCurrentGeneration: (candidate) => candidate === generation && !controller.signal.aborted,
  };
}

beforeEach(() => {
  testState.currentContext = makeTenantContext('tenant-isolated');
  mockedGet.mockReset();
  mockedPost.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage.setItem('staffdeck_locale', 'zh-CN');
});

describe('useCodexSubscriptionAccount', () => {
  it('loads and updates the subscription account in the caller tenant', async () => {
    mockedGet.mockResolvedValueOnce(requiresLogin);
    mockedPost.mockResolvedValueOnce(pending);

    const { result } = renderHook(() => useCodexSubscriptionAccount(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.account).toEqual(requiresLogin));
    expect(mockedGet).toHaveBeenCalledWith('/api/enterprise/model-configs/codex-subscription/account');
    expect(mockedGet.mock.calls[0][0]).not.toContain('tenant-isolated');

    await act(async () => result.current.startLogin());

    expect(mockedPost).toHaveBeenCalledWith('/api/enterprise/model-configs/codex-subscription/login');
    expect(mockedPost.mock.calls[0][0]).not.toContain('tenant-isolated');
    expect(result.current.account).toEqual(pending);
  });

  it('polls every two seconds only while login remains pending', async () => {
    vi.useFakeTimers();
    mockedGet.mockResolvedValueOnce(pending).mockResolvedValueOnce(connected);

    const { result } = renderHook(() => useCodexSubscriptionAccount(), { wrapper: Wrapper });

    await act(async () => Promise.resolve());
    expect(result.current.account).toEqual(pending);
    expect(mockedGet).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(result.current.account).toEqual(connected);
    expect(mockedGet).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(mockedGet).toHaveBeenCalledTimes(2);
  });

  it('clears a pending account and stops polling after a status refresh fails', async () => {
    vi.useFakeTimers();
    mockedGet.mockResolvedValueOnce(pending).mockRejectedValueOnce(new Error('status unavailable'));
    const notifyError = vi.spyOn(notify, 'error');

    const { result } = renderHook(() => useCodexSubscriptionAccount(), { wrapper: Wrapper });

    await act(async () => Promise.resolve());
    expect(result.current.account).toEqual(pending);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(result.current.account).toBeNull();
    expect(notifyError).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(mockedGet).toHaveBeenCalledTimes(2);
    expect(notifyError).toHaveBeenCalledTimes(1);
  });

  it('does not read subscription state when its consumer is disabled', async () => {
    const { result } = renderHook(() => useCodexSubscriptionAccount({ enabled: false }), { wrapper: Wrapper });

    await act(async () => Promise.resolve());
    expect(result.current.account).toBeNull();
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it('does not expose a stale account response after the caller tenant changes', async () => {
    let resolveFirstRequest: ((account: CodexSubscriptionAccountRead) => void) | undefined;
    mockedGet.mockImplementation(() => {
      if (testState.currentContext?.tenantId === 'tenant-first') {
        return new Promise<CodexSubscriptionAccountRead>((resolve) => {
          resolveFirstRequest = resolve;
        });
      }
      return Promise.resolve(connected);
    });

    testState.currentContext = makeTenantContext('tenant-first', 1);
    const { result, rerender } = renderHook(() => useCodexSubscriptionAccount(), { wrapper: Wrapper });

    testState.currentContext = makeTenantContext('tenant-second', 2);
    rerender();
    await waitFor(() => expect(result.current.account).toEqual(connected));

    await act(async () => {
      resolveFirstRequest?.(requiresLogin);
      await Promise.resolve();
    });
    expect(result.current.account).toEqual(connected);
  });

  it('does not let an older account read overwrite a newer login action for the same tenant', async () => {
    let resolveInitialRead: ((account: CodexSubscriptionAccountRead) => void) | undefined;
    mockedGet.mockImplementationOnce(
      () =>
        new Promise<CodexSubscriptionAccountRead>((resolve) => {
          resolveInitialRead = resolve;
        }),
    );
    mockedPost.mockResolvedValueOnce(pending);

    const { result } = renderHook(() => useCodexSubscriptionAccount(), { wrapper: Wrapper });
    expect(mockedGet).toHaveBeenCalledTimes(1);

    await act(async () => result.current.startLogin());
    expect(result.current.account).toEqual(pending);

    await act(async () => {
      resolveInitialRead?.(requiresLogin);
      await Promise.resolve();
    });
    expect(result.current.account).toEqual(pending);
  });

  it('blocks a queued poll after cancellation starts so the cancellation result remains current', async () => {
    mockedGet.mockResolvedValueOnce(pending).mockResolvedValueOnce(connected);
    mockedPost.mockResolvedValueOnce(requiresLogin);

    const { result } = renderHook(() => useCodexSubscriptionAccount(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.account).toEqual(pending));

    await act(async () => {
      const cancellation = result.current.cancelLogin();
      const queuedPoll = result.current.reload();
      await Promise.all([cancellation, queuedPoll]);
    });

    expect(mockedGet).toHaveBeenCalledTimes(1);
    expect(result.current.account).toEqual(requiresLogin);
    expect(result.current.loading).toBe(false);
  });

  it('keeps an account action current when the application locale changes', async () => {
    let resolveLogin: ((account: CodexSubscriptionAccountRead) => void) | undefined;
    mockedGet.mockResolvedValueOnce(requiresLogin).mockResolvedValueOnce(connected);
    mockedPost.mockImplementationOnce(
      () =>
        new Promise<CodexSubscriptionAccountRead>((resolve) => {
          resolveLogin = resolve;
        }),
    );

    const { result } = renderHook(
      () => {
        const subscription = useCodexSubscriptionAccount();
        const { setLocale } = useAppIntl();
        return { ...subscription, setLocale };
      },
      { wrapper: Wrapper },
    );
    await waitFor(() => expect(result.current.account).toEqual(requiresLogin));

    let loginPromise: Promise<void> | undefined;
    act(() => {
      loginPromise = result.current.startLogin();
    });
    act(() => result.current.setLocale('en-US'));
    await act(async () => {
      resolveLogin?.(pending);
      await loginPromise;
    });

    expect(mockedGet).toHaveBeenCalledTimes(1);
    expect(result.current.account).toEqual(pending);
    expect(result.current.loading).toBe(false);
  });
});
