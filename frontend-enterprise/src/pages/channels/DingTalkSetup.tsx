import { useMemo, useState } from 'react';
import { createToastNotifier } from '@/components/ui/app-toast';

import { Input } from '@/components/ui';
import { Button as UIButton } from '@/components/ui/button';
import { createMessageDescriptor, type MessageDescriptor } from '@/i18n/descriptors';
import { RawIdentifier } from '@/i18n/RawContent';
import { useAppIntl } from '@/i18n/useAppIntl';
import type { MessageId } from '@/i18n/types';
import { backendErrorMessageDescriptor } from '@/lib/apiErrorMessages';
import { createTenantClient } from '../../api/tenant-client';
import { useTenantSession } from '../../contexts/TenantSessionContext';
import type { ChannelBindingRead } from '../../types';
import { StatusBadge } from '../scheduled-tasks/StatusBadge';

const PRIMARY_BUTTON_CLASS =
  'h-8 gap-1 rounded-[10px] bg-primary px-5 text-[12px] font-normal text-white hover:bg-primary/80';
const OUTLINE_BUTTON_CLASS =
  'h-8 gap-1 rounded-[10px] border-[#e3e7f1] px-5 text-[12px] font-normal text-[#464c5e] hover:bg-[#f6f6f6] hover:text-primary';

/** 将稳定后端错误投影为当前 setup 页面可展示的 descriptor，禁止原始异常文本成为 UI。 */
function errorDescriptor(error: unknown, fallbackId: MessageId): MessageDescriptor {
  const descriptor = backendErrorMessageDescriptor(error);
  return descriptor
    ? { id: descriptor.messageId, values: descriptor.values }
    : createMessageDescriptor(fallbackId);
}

type DingTalkTenantContext = NonNullable<ReturnType<typeof useTenantSession>>;

/** Prevent a stale tenant generation from publishing credential state or toasts. */
function isCurrentTenantGeneration(
  context: DingTalkTenantContext | null,
  generation: number,
): context is DingTalkTenantContext {
  return Boolean(context && !context.signal.aborted && context.isCurrentGeneration(generation));
}

/** 渲染钉钉凭证配置区域；provider ID/secret 只作为 raw 表单数据处理。 */
export default function DingTalkSetup({
  binding,
  onChanged,
}: {
  binding: ChannelBindingRead;
  onChanged: (updated: ChannelBindingRead) => void;
}) {
  const { t } = useAppIntl();
  const toast = createToastNotifier({ t });
  const tenantContext = useTenantSession();
  const tenantApi = useMemo(() => createTenantClient(tenantContext), [tenantContext]);
  const configuredClientId = binding.client_id || String(binding.config_json?.client_id || '');
  const [editing, setEditing] = useState(!configuredClientId);
  const [clientId, setClientId] = useState(configuredClientId);
  const [clientSecret, setClientSecret] = useState('');
  const [saving, setSaving] = useState(false);

  /** 保存钉钉凭证；clientId/secret 是 raw provider 输入，仅提交给后端不翻译。 */
  async function save() {
    if (!clientId.trim() || !clientSecret.trim()) {
      toast.error(createMessageDescriptor('channels.credentials.completeRequired'));
      return;
    }
    const context = tenantContext;
    if (!context) return;
    const generation = context.generation;
    setSaving(true);
    try {
      const updated = await tenantApi.post<ChannelBindingRead>(
        `/api/enterprise/channels/${binding.id}/dingtalk/credentials`,
        { client_id: clientId.trim(), client_secret: clientSecret.trim() },
      );
      if (!isCurrentTenantGeneration(context, generation)) return;
      setClientSecret('');
      setEditing(false);
      onChanged(updated);
      toast.success(createMessageDescriptor('channels.toast.saved'));
    } catch (error) {
      if (!isCurrentTenantGeneration(context, generation)) return;
      toast.error(errorDescriptor(error, 'channels.credentials.saveFailed'));
    } finally {
      if (isCurrentTenantGeneration(context, generation)) setSaving(false);
    }
  }

  if (configuredClientId && !editing) {
    return (
      <div className="flex flex-wrap items-center gap-[10px] rounded-[10px] bg-[#fafbfc] p-[16px]">
        <span className="text-[12px] text-[#464c5e]">{t('channels.credentials.configured')}</span>
        <span className="text-[12px] text-[#858b9c]">
          {t('channels.credentials.clientIdLabel')}: <RawIdentifier value={configuredClientId} />
        </span>
        <StatusBadge tone={binding.connected ? 'green' : 'gray'}>
          {binding.connected ? t('channels.status.connected') : t('channels.status.disconnected')}
        </StatusBadge>
        <UIButton
          variant="outline"
          onClick={() => { setClientSecret(''); setEditing(true); }}
          className={OUTLINE_BUTTON_CLASS}
        >
          {t('channels.credentials.rotateSecret')}
        </UIButton>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-[12px] rounded-[10px] bg-[#fafbfc] p-[16px]">
      <span className="text-[12px] leading-[1.6] text-[#858b9c]">
        {t('channels.credentials.dingtalkPath')}
      </span>
      <label className="flex flex-col gap-[6px] text-[12px] text-[#464c5e]">
        {t('channels.credentials.clientIdLabel')}
        <Input value={clientId} disabled={Boolean(configuredClientId)} autoComplete="off" onChange={(e) => setClientId(e.target.value)} className="h-8 rounded-[10px] text-[12px]" />
      </label>
      <label className="flex flex-col gap-[6px] text-[12px] text-[#464c5e]">
        {t('channels.credentials.clientSecretLabel')}
        <Input type="password" value={clientSecret} autoComplete="off" onChange={(e) => setClientSecret(e.target.value)} className="h-8 rounded-[10px] text-[12px]" />
      </label>
      <div className="flex justify-end gap-[8px]">
        {configuredClientId && <UIButton variant="outline" onClick={() => setEditing(false)} className={OUTLINE_BUTTON_CLASS}>{t('common.action.cancel')}</UIButton>}
        <UIButton onClick={() => void save()} disabled={saving} className={PRIMARY_BUTTON_CLASS}>{t('common.action.save')}</UIButton>
      </div>
    </div>
  );
}
