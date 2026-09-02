import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { notify } from '@/components/ui/app-toast';
import { createTenantClient } from '@/api/tenant-client';
import { useTenantSession } from '@/contexts/TenantSessionContext';
import { useAppIntl } from '@/i18n';
import { apiErrorMessage } from '@/lib/apiErrorMessages';
import type { CodexSubscriptionAccountRead } from '@/types';

type SubscriptionAction = 'login' | 'login/cancel' | 'logout';

type UseCodexSubscriptionAccountOptions = {
  enabled?: boolean;
};

type UseCodexSubscriptionAccountResult = {
  account: CodexSubscriptionAccountRead | null;
  loading: boolean;
  reload: () => Promise<void>;
  startLogin: () => Promise<void>;
  cancelLogin: () => Promise<void>;
  logout: () => Promise<void>;
};

/** 管理指定租户的本机 Codex 订阅账号状态，并在登录待处理时持续轮询。 */
export function useCodexSubscriptionAccount({
  enabled = true,
}: UseCodexSubscriptionAccountOptions = {}): UseCodexSubscriptionAccountResult {
  const { t } = useAppIntl();
  const tenantContext = useTenantSession();
  const tenantApi = useMemo(() => createTenantClient(tenantContext), [tenantContext]);
  const [account, setAccount] = useState<CodexSubscriptionAccountRead | null>(null);
  const [loading, setLoading] = useState(false);
  const requestGenerationRef = useRef(0);
  const accountActionInFlightRef = useRef(false);

  /** 验证请求仍属于当前租户代次，避免切换租户后发布旧的订阅状态。 */
  function isCurrentRequest(requestGeneration: number, generation: number): boolean {
    return Boolean(
      enabled
      && tenantContext
      && !tenantContext.signal.aborted
      && tenantContext.generation === generation
      && tenantContext.isCurrentGeneration(generation)
      && requestGenerationRef.current === requestGeneration,
    );
  }

  /** 读取当前租户的订阅账号状态。 */
  const reload = useCallback(async () => {
    if (!enabled || !tenantContext || accountActionInFlightRef.current) return;
    const contextGeneration = tenantContext.generation;
    const requestGeneration = ++requestGenerationRef.current;
    try {
      const nextAccount = await tenantApi.get<CodexSubscriptionAccountRead>(
        '/api/enterprise/model-configs/codex-subscription/account',
      );
      if (!isCurrentRequest(requestGeneration, contextGeneration)) {
        return;
      }
      setAccount(nextAccount);
    } catch (error) {
      if (!isCurrentRequest(requestGeneration, contextGeneration)) {
        return;
      }
      // A failed refresh makes the pending snapshot unusable. Clearing it
      // also tears down the pending-only interval, so one outage cannot
      // produce an unbounded stream of requests and global toasts.
      setAccount(null);
      notify.error(apiErrorMessage(error, t('modelsPage.toast.subscriptionStatusLoadFailed')));
    }
  }, [enabled, t, tenantApi, tenantContext]);
  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  useEffect(() => {
    requestGenerationRef.current += 1;
    accountActionInFlightRef.current = false;
    setAccount(null);
    setLoading(false);
    if (!enabled || !tenantContext) {
      return;
    }
    void reloadRef.current();
  }, [enabled, tenantContext, tenantContext?.generation]);

  useEffect(() => {
    if (!enabled || loading || account?.status !== 'pending') return;
    const timer = window.setInterval(() => {
      void reload();
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [account?.status, enabled, loading, reload]);

  /** 执行订阅账号动作并用服务端返回状态更新界面。 */
  const updateAccount = useCallback(
    async (action: SubscriptionAction, fallbackMessage: string) => {
      if (!enabled || !tenantContext) return;
      const contextGeneration = tenantContext.generation;
      accountActionInFlightRef.current = true;
      const requestGeneration = ++requestGenerationRef.current;
      setLoading(true);
      try {
        const nextAccount = await tenantApi.post<CodexSubscriptionAccountRead>(
          `/api/enterprise/model-configs/codex-subscription/${action}`,
        );
        if (!isCurrentRequest(requestGeneration, contextGeneration)) {
          return;
        }
        setAccount(nextAccount);
        switch (nextAccount.status) {
          case 'connected':
            notify.successText(t('modelsPage.subscription.connected'));
            break;
          case 'pending':
            notify.successText(t('modelsPage.subscription.pending'));
            break;
          case 'requires_login':
            notify.successText(t('modelsPage.subscription.requiresLogin'));
            break;
          default:
            notify.successText(t('modelsPage.subscription.unavailable'));
        }
      } catch (error) {
        if (!isCurrentRequest(requestGeneration, contextGeneration)) {
          return;
        }
        notify.error(apiErrorMessage(error, fallbackMessage));
      } finally {
        if (requestGenerationRef.current === requestGeneration) {
          accountActionInFlightRef.current = false;
        }
        if (isCurrentRequest(requestGeneration, contextGeneration)) {
          setLoading(false);
        }
      }
    },
    [enabled, t, tenantApi, tenantContext],
  );

  /** 启动本机 Codex 登录流程。 */
  const startLogin = useCallback(
    () => updateAccount('login', t('modelsPage.toast.subscriptionLoginFailed')),
    [t, updateAccount],
  );

  /** 取消仍在等待的本机 Codex 登录流程。 */
  const cancelLogin = useCallback(
    () => updateAccount('login/cancel', t('modelsPage.toast.subscriptionCancelFailed')),
    [t, updateAccount],
  );

  /** 退出当前本机 ChatGPT 订阅账号。 */
  const logout = useCallback(
    () => updateAccount('logout', t('modelsPage.toast.subscriptionLogoutFailed')),
    [t, updateAccount],
  );

  return {
    account,
    loading,
    reload,
    startLogin,
    cancelLogin,
    logout,
  };
}
