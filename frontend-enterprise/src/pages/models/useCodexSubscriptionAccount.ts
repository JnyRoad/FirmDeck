import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/api/client';
import { notify } from '@/components/ui/app-toast';
import { useI18n } from '@/i18n';
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
  const { t } = useI18n();
  const [account, setAccount] = useState<CodexSubscriptionAccountRead | null>(null);
  const [loading, setLoading] = useState(false);
  const activeTenantRef = useRef<string | null>(null);
  activeTenantRef.current = enabled ? tenantId : null;

  /** 读取当前租户的订阅账号状态。 */
  const reload = useCallback(async () => {
    if (!enabled) return;
    const requestTenantId = tenantId;
    try {
      const nextAccount = await api.get<CodexSubscriptionAccountRead>(
        `/api/enterprise/model-configs/codex-subscription/account?tenant_id=${encodeURIComponent(requestTenantId)}`,
      );
      if (activeTenantRef.current !== requestTenantId) return;
      setAccount(nextAccount);
    } catch (error) {
      if (activeTenantRef.current !== requestTenantId) return;
      notify.error(apiErrorMessage(error, t('无法读取 ChatGPT 订阅状态')));
    }
  }, [enabled, t, tenantId]);

  useEffect(() => {
    setAccount(null);
    setLoading(false);
    if (!enabled) {
      return;
    }
    void reload();
  }, [enabled, reload]);

  useEffect(() => {
    if (!enabled || account?.status !== 'pending') return;
    const timer = window.setInterval(() => {
      void reload();
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [account?.status, enabled, reload]);

  /** 执行订阅账号动作并用服务端返回状态更新界面。 */
  const updateAccount = useCallback(
    async (action: SubscriptionAction, fallbackMessage: string) => {
      if (!enabled) return;
      const requestTenantId = tenantId;
      setLoading(true);
      try {
        const nextAccount = await api.post<CodexSubscriptionAccountRead>(
          `/api/enterprise/model-configs/codex-subscription/${action}?tenant_id=${encodeURIComponent(requestTenantId)}`,
        );
        if (activeTenantRef.current !== requestTenantId) return;
        setAccount(nextAccount);
        if (nextAccount.message) notify.success(nextAccount.message);
      } catch (error) {
        if (activeTenantRef.current !== requestTenantId) return;
        notify.error(apiErrorMessage(error, fallbackMessage));
      } finally {
        if (activeTenantRef.current === requestTenantId) setLoading(false);
      }
    },
    [enabled, tenantId],
  );

  /** 启动本机 Codex 登录流程。 */
  const startLogin = useCallback(
    () => updateAccount('login', t('无法启动本机 Codex 登录')),
    [t, updateAccount],
  );

  /** 取消仍在等待的本机 Codex 登录流程。 */
  const cancelLogin = useCallback(
    () => updateAccount('login/cancel', t('无法取消本机 Codex 登录')),
    [t, updateAccount],
  );

  /** 退出当前本机 ChatGPT 订阅账号。 */
  const logout = useCallback(
    () => updateAccount('logout', t('无法退出 ChatGPT 订阅')),
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
