import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/api/client';
import { notify } from '@/components/ui/app-toast';
import { useAppIntl } from '@/i18n';
import { apiErrorMessage } from '@/lib/apiErrorMessages';
import type { CodexSubscriptionAccountRead } from '@/types';

type SubscriptionAction = 'login' | 'login/cancel' | 'logout';

type UseCodexSubscriptionAccountOptions = {
  tenantId: string;
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
  tenantId,
  enabled = true,
}: UseCodexSubscriptionAccountOptions): UseCodexSubscriptionAccountResult {
  const { t } = useAppIntl();
  const [account, setAccount] = useState<CodexSubscriptionAccountRead | null>(null);
  const [loading, setLoading] = useState(false);
  const activeTenantRef = useRef<string | null>(null);
  const requestGenerationRef = useRef(0);
  const accountActionInFlightRef = useRef(false);
  activeTenantRef.current = enabled ? tenantId : null;

  /** 读取当前租户的订阅账号状态。 */
  const reload = useCallback(async () => {
    if (!enabled || accountActionInFlightRef.current) return;
    const requestTenantId = tenantId;
    const requestGeneration = ++requestGenerationRef.current;
    try {
      const nextAccount = await api.get<CodexSubscriptionAccountRead>(
        `/api/enterprise/model-configs/codex-subscription/account?tenant_id=${encodeURIComponent(requestTenantId)}`,
      );
      if (
        activeTenantRef.current !== requestTenantId ||
        requestGenerationRef.current !== requestGeneration
      ) {
        return;
      }
      setAccount(nextAccount);
    } catch (error) {
      if (
        activeTenantRef.current !== requestTenantId ||
        requestGenerationRef.current !== requestGeneration
      ) {
        return;
      }
      notify.error(apiErrorMessage(error, t('modelsPage.toast.subscriptionStatusLoadFailed')));
    }
  }, [enabled, t, tenantId]);
  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  useEffect(() => {
    requestGenerationRef.current += 1;
    accountActionInFlightRef.current = false;
    setAccount(null);
    setLoading(false);
    if (!enabled) {
      return;
    }
    void reloadRef.current();
  }, [enabled, tenantId]);

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
      if (!enabled) return;
      const requestTenantId = tenantId;
      accountActionInFlightRef.current = true;
      const requestGeneration = ++requestGenerationRef.current;
      setLoading(true);
      try {
        const nextAccount = await api.post<CodexSubscriptionAccountRead>(
          `/api/enterprise/model-configs/codex-subscription/${action}?tenant_id=${encodeURIComponent(requestTenantId)}`,
        );
        if (
          activeTenantRef.current !== requestTenantId ||
          requestGenerationRef.current !== requestGeneration
        ) {
          return;
        }
        setAccount(nextAccount);
        switch (nextAccount.status) {
          case 'connected':
            notify.success(t('modelsPage.subscription.connected'));
            break;
          case 'pending':
            notify.success(t('modelsPage.subscription.pending'));
            break;
          case 'requires_login':
            notify.success(t('modelsPage.subscription.requiresLogin'));
            break;
          default:
            notify.success(t('modelsPage.subscription.unavailable'));
        }
      } catch (error) {
        if (
          activeTenantRef.current !== requestTenantId ||
          requestGenerationRef.current !== requestGeneration
        ) {
          return;
        }
        notify.error(apiErrorMessage(error, fallbackMessage));
      } finally {
        if (requestGenerationRef.current === requestGeneration) {
          accountActionInFlightRef.current = false;
        }
        if (
          activeTenantRef.current === requestTenantId &&
          requestGenerationRef.current === requestGeneration
        ) {
          setLoading(false);
        }
      }
    },
    [enabled, t, tenantId],
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
