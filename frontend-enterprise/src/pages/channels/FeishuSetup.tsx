import { useMemo, useState } from 'react';
import { createToastNotifier } from '@/components/ui/app-toast';

import { Input } from '@/components/ui';
import { Button as UIButton } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { createMessageDescriptor, type MessageDescriptor } from '@/i18n/descriptors';
import { RawContent, RawIdentifier } from '@/i18n/RawContent';
import { useAppIntl } from '@/i18n/useAppIntl';
import type { MessageId } from '@/i18n/types';
import { backendErrorMessageDescriptor } from '@/lib/apiErrorMessages';

import { createTenantClient } from '../../api/tenant-client';
import { useTenantSession } from '../../contexts/TenantSessionContext';
import { InfoCircleOutlined } from '../../icons';
import type { ChannelBindingRead } from '../../types';
import { StatusBadge } from '../scheduled-tasks/StatusBadge';

const PRIMARY_BUTTON_CLASS =
  'h-8 gap-1 rounded-[10px] bg-primary px-5 text-[12px] font-normal text-white hover:bg-primary/80';
const OUTLINE_BUTTON_CLASS =
  'h-8 gap-1 rounded-[10px] border-[#e3e7f1] px-5 text-[12px] font-normal text-[#464c5e] hover:bg-[#f6f6f6] hover:text-primary';

type PermissionEntry = {
  scope: string;
  labelId: MessageId;
};

const REQUIRED_PERMISSIONS: PermissionEntry[] = [
  { labelId: 'channels.feishu.permission.contactBase', scope: 'contact:contact.base:readonly' },
  { labelId: 'channels.feishu.permission.userBase', scope: 'contact:user.base:readonly' },
  { labelId: 'channels.feishu.permission.userId', scope: 'contact:user.id:readonly' },
  { labelId: 'channels.feishu.permission.groupAtWithBot', scope: 'im:message.group_at_msg.include_bot:readonly' },
  { labelId: 'channels.feishu.permission.groupAt', scope: 'im:message.group_at_msg:readonly' },
  { labelId: 'channels.feishu.permission.groupMessages', scope: 'im:message.group_msg' },
  { labelId: 'channels.feishu.permission.groupMessagesWithBot', scope: 'im:message.group_msg.include_bot:read' },
  { labelId: 'channels.feishu.permission.directMessages', scope: 'im:message.p2p_msg:readonly' },
  { labelId: 'channels.feishu.permission.reactionsRead', scope: 'im:message.reactions:read' },
  { labelId: 'channels.feishu.permission.reactionsWrite', scope: 'im:message.reactions:write_only' },
  { labelId: 'channels.feishu.permission.messagesRead', scope: 'im:message:readonly' },
  { labelId: 'channels.feishu.permission.sendAsBot', scope: 'im:message:send_as_bot' },
];

const REMOVABLE_PERMISSIONS: PermissionEntry[] = [
  { labelId: 'channels.feishu.permission.taskDataScope', scope: 'task:data_scope' },
  { labelId: 'channels.feishu.permission.emailUserScope', scope: 'mail:user_scope' },
  { labelId: 'channels.feishu.permission.emailDataScope', scope: 'mail:data_scope' },
  { labelId: 'channels.feishu.permission.hrEmployeesScope', scope: 'hr:employee_scope' },
  { labelId: 'channels.feishu.permission.hrCandidatesScope', scope: 'hr:candidate_scope' },
  { labelId: 'channels.feishu.permission.minutesScope', scope: 'minutes:basic_scope' },
];

/** 将稳定后端错误投影为当前 setup 页面可展示的 descriptor，禁止原始异常文本成为 UI。 */
function errorDescriptor(error: unknown, fallbackId: MessageId): MessageDescriptor {
  const descriptor = backendErrorMessageDescriptor(error);
  return descriptor
    ? { id: descriptor.messageId, values: descriptor.values }
    : createMessageDescriptor(fallbackId);
}

type FeishuTenantContext = NonNullable<ReturnType<typeof useTenantSession>>;

/** Prevent a stale tenant generation from publishing credential state or toasts. */
function isCurrentTenantGeneration(
  context: FeishuTenantContext | null,
  generation: number,
): context is FeishuTenantContext {
  return Boolean(context && !context.signal.aborted && context.isCurrentGeneration(generation));
}

/** 渲染飞书权限说明；权限标签产品化，scope 字符串保持 provider raw 标识。 */
function FeishuPermissionHint() {
  const { t } = useAppIntl();
  return (
    <div className="rounded-[10px] border border-[#e8edf5] bg-white p-[12px] text-[12px] text-[#464c5e]">
      <div className="flex items-start gap-[8px]">
        <div className="mt-[1px] flex h-4 w-4 items-center justify-center text-[#8b93a7]">
          <TooltipProvider delayDuration={120}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={t('channels.feishu.permission.helpAria')}
                  className="flex h-4 w-4 items-center justify-center rounded-full text-[#8b93a7] transition-colors hover:text-primary"
                >
                  <InfoCircleOutlined className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" align="start" className="max-w-[340px]">
                {t('channels.feishu.permission.help')}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        <div className="min-w-0 flex-1 leading-[1.6] text-[#596174]">
          <span className="text-[#18181a]">{t('channels.feishu.permission.minimum')}</span>{' '}
          {t('channels.feishu.permission.minimumDetails')}
        </div>
      </div>
      <div className="mt-[10px] grid gap-[8px] md:grid-cols-2">
        <div>
          <div className="mb-[4px] text-[11px] font-medium text-[#8b93a7]">{t('channels.feishu.permission.required')}</div>
          <div className="flex flex-wrap gap-[6px]">
            {REQUIRED_PERMISSIONS.map((item) => (
              <span key={item.scope} className="rounded-full bg-[#eef4ff] px-[8px] py-[2px] text-[#3f5fb8]">
                {t(item.labelId)}{' '}
                <RawIdentifier value={`(${item.scope})`} />
              </span>
            ))}
          </div>
        </div>
        <div>
          <div className="mb-[4px] text-[11px] font-medium text-[#8b93a7]">{t('channels.feishu.permission.optional')}</div>
          <div className="flex flex-wrap gap-[6px]">
            {REMOVABLE_PERMISSIONS.map((item) => (
              <span key={item.scope} className="rounded-full bg-[#f4f6fa] px-[8px] py-[2px] text-[#667085]">
                {t(item.labelId)}{' '}
                <RawIdentifier value={`(${item.scope})`} />
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** 渲染飞书凭证配置区域；App ID、tenant key 和 bot 名称不进入翻译资源。 */
export default function FeishuSetup({
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
  const configuredAppId = binding.app_id || '';
  const [editing, setEditing] = useState(!configuredAppId);
  const [appId, setAppId] = useState(configuredAppId);
  const [appSecret, setAppSecret] = useState('');
  const [saving, setSaving] = useState(false);

  /** 保存飞书凭证；App ID/Secret 是 raw provider 输入，仅提交给后端不翻译。 */
  async function save() {
    if (!appId.trim() || !appSecret.trim()) {
      toast.error(createMessageDescriptor('channels.credentials.completeRequired'));
      return;
    }
    const context = tenantContext;
    if (!context) return;
    const generation = context.generation;
    setSaving(true);
    try {
      const updated = await tenantApi.post<ChannelBindingRead>(
        `/api/enterprise/channels/${binding.id}/feishu/credentials`,
        {
          app_id: appId.trim(),
          app_secret: appSecret.trim(),
        },
      );
      if (!isCurrentTenantGeneration(context, generation)) return;
      setAppSecret('');
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

  if (configuredAppId && !editing) {
    return (
      <div className="flex flex-col gap-[10px] rounded-[10px] bg-[#fafbfc] p-[16px]">
        <div className="flex flex-wrap items-center gap-[10px]">
          <span className="text-[12px] text-[#464c5e]">{t('channels.credentials.configured')}</span>
          <span className="text-[12px] text-[#858b9c]">
            {t('channels.credentials.appIdLabel')}: <RawIdentifier value={configuredAppId} />
          </span>
          {binding.bot_name && (
            <span className="text-[12px] text-[#858b9c]">
              {t('channels.credentials.botNameLabel')}: <RawContent value={binding.bot_name} />
            </span>
          )}
          {binding.provider_tenant_key && (
            <span className="text-[12px] text-[#858b9c]">
              {t('channels.credentials.tenantLabel')}: <RawIdentifier value={binding.provider_tenant_key} />
            </span>
          )}
          <StatusBadge tone={binding.connected ? 'green' : 'gray'}>
            {binding.connected ? t('channels.status.connected') : t('channels.status.disconnected')}
          </StatusBadge>
          <UIButton
            variant="outline"
            onClick={() => {
              setAppId(configuredAppId);
              setAppSecret('');
              setEditing(true);
            }}
            className={OUTLINE_BUTTON_CLASS}
          >
            {t('channels.credentials.rotateSecret')}
          </UIButton>
        </div>
        <div className="rounded-[8px] bg-[#f4f6fa] px-[12px] py-[8px] text-[11px] leading-[1.6] text-[#667085]">
          {t('channels.feishu.traceDescription')}{' '}
          {t('channels.feishu.traceTogglePrefix')}{' '}
          <code className="rounded bg-[#e8edf5] px-[3px] py-[1px] text-[#3f5fb8]">
            channel_feishu_trace_enabled
          </code>{' '}
          {t('channels.feishu.traceToggleSuffix')}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-[12px] rounded-[10px] bg-[#fafbfc] p-[16px]">
      <FeishuPermissionHint />
      <label className="flex flex-col gap-[6px] text-[12px] text-[#464c5e]">
        {t('channels.credentials.appIdLabel')}
        <Input
          type="text"
          value={appId}
          disabled={Boolean(configuredAppId)}
          autoComplete="off"
          data-1p-ignore="true"
          data-lpignore="true"
          onChange={(event) => setAppId(event.target.value)}
          className="h-8 rounded-[10px] text-[12px]"
        />
      </label>
      <label className="flex flex-col gap-[6px] text-[12px] text-[#464c5e]">
        {t('channels.credentials.appSecretLabel')}
        <Input
          type="password"
          value={appSecret}
          autoComplete="off"
          name="feishu-app-secret-no-password-manager"
          data-1p-ignore="true"
          data-lpignore="true"
          onChange={(event) => setAppSecret(event.target.value)}
          className="h-8 rounded-[10px] text-[12px]"
        />
      </label>
      <div className="flex justify-end gap-[8px]">
        {configuredAppId && (
          <UIButton
            variant="outline"
            onClick={() => setEditing(false)}
            className={OUTLINE_BUTTON_CLASS}
          >
            {t('common.action.cancel')}
          </UIButton>
        )}
        <UIButton onClick={() => void save()} disabled={saving} className={PRIMARY_BUTTON_CLASS}>
          {t('common.action.save')}
        </UIButton>
      </div>
    </div>
  );
}
