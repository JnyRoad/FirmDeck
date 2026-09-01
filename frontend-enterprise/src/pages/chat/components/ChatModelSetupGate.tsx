import { useEffect, useMemo, useState } from 'react';
import { AlertCircle } from 'lucide-react';

import { createTenantClient } from '@/api/tenant-client';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui';
import { notify } from '@/components/ui/app-toast';
import { Button } from '@/components/ui/button';
import { useTenantSession } from '@/contexts/TenantSessionContext';
import { useAppIntl } from '@/i18n';
import { apiErrorMessage } from '@/lib/apiErrorMessages';
import type { ModelConfigRead } from '@/types';
import type { ApiKeyProtocol } from '@/pages/models/channelPresets';
import ModelSetupWizard from '@/pages/models/ModelSetupWizard';
import { useCodexSubscriptionAccount } from '@/pages/models/useCodexSubscriptionAccount';

export type ChatModelSetupGateProps = {
  open: boolean;
  canConfigure: boolean;
  onOpenChange: (open: boolean) => void;
  onConfigured: (model: ModelConfigRead) => void;
};

/** 在聊天无可用模型时，为管理员展示共享向导，为其他用户保留只读权限提示。 */
export default function ChatModelSetupGate({
  open,
  canConfigure,
  onOpenChange,
  onConfigured,
}: ChatModelSetupGateProps) {
  const { t } = useAppIntl();
  const tenantContext = useTenantSession();
  const tenantApi = useMemo(() => createTenantClient(tenantContext), [tenantContext]);
  const [availableProtocols, setAvailableProtocols] = useState<ApiKeyProtocol[]>(['openai_chat_completions']);
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);
  const {
    account: subscriptionAccount,
    loading: subscriptionLoading,
    startLogin,
    cancelLogin,
    logout,
  } = useCodexSubscriptionAccount({ enabled: open && canConfigure });

  useEffect(() => {
    if (!open || !canConfigure || !tenantContext) return;
    let cancelled = false;
    const generation = tenantContext.generation;
    void tenantApi
      .get<{ protocols: ApiKeyProtocol[] }>(
        '/api/enterprise/model-configs/protocols',
      )
      .then((result) => {
        if (!cancelled && tenantContext.isCurrentGeneration(generation)) {
          setAvailableProtocols(result.protocols);
        }
      })
      .catch((error) => {
        if (!cancelled && tenantContext.isCurrentGeneration(generation)) {
          notify.error(apiErrorMessage(error, t('chat.modelSetup.protocolLoadFailed')));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [canConfigure, open, t, tenantApi, tenantContext]);

  if (!canConfigure) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>{t('chat.modelSetup.title')}</DialogTitle>
            <DialogDescription>
              {t('chat.modelSetup.description')}
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-start gap-[10px] rounded-[8px] border border-[#f0d9a8] bg-[#fffaf0] p-[12px] text-[13px] text-[#7b5c16]">
            <AlertCircle className="mt-[1px] size-[16px] shrink-0" />
            <span>{t('chat.modelSetup.noPermission')}</span>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('chat.modelSetup.later')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <>
      <ModelSetupWizard
        open={open}
        onOpenChange={onOpenChange}
        onCreated={(model, options) => {
          if (options?.tested) onConfigured(model);
        }}
        availableProtocols={availableProtocols}
        subscriptionAccount={subscriptionAccount}
        subscriptionLoading={subscriptionLoading}
        onStartSubscriptionLogin={() => void startLogin()}
        onCancelSubscriptionLogin={() => void cancelLogin()}
        onRequestSubscriptionLogout={() => setLogoutConfirmOpen(true)}
      />

      <ConfirmDialog
        open={logoutConfirmOpen}
        onOpenChange={setLogoutConfirmOpen}
        loading={subscriptionLoading}
        destructive={false}
        title={t('modelsPage.confirm.logout.title')}
        description={t('modelsPage.confirm.logout.description')}
        confirmText={t('modelsPage.confirm.logout.confirm')}
        onConfirm={() => {
          setLogoutConfirmOpen(false);
          void logout();
        }}
      />
    </>
  );
}
