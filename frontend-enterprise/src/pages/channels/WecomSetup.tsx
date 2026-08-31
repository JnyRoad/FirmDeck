import { useState } from 'react';
import { createToastNotifier } from '@/components/ui/app-toast';

import { Input } from '@/components/ui';
import { Button as UIButton } from '@/components/ui/button';
import { createMessageDescriptor, type MessageDescriptor } from '@/i18n/descriptors';
import { RawContent, RawIdentifier } from '@/i18n/RawContent';
import { useAppIntl } from '@/i18n/useAppIntl';
import type { MessageId } from '@/i18n/types';
import { backendErrorMessageDescriptor } from '@/lib/apiErrorMessages';

import { api, TENANT_ID } from '../../api/client';
import type { ChannelBindingRead, ChannelCredentialFieldRead, ChannelMetaRead } from '../../types';
import { StatusBadge } from '../scheduled-tasks/StatusBadge';

const PRIMARY_BUTTON_CLASS =
  'h-8 gap-1 rounded-[10px] bg-[#18181a] px-5 text-[12px] font-normal text-white hover:bg-[#303030]';
const OUTLINE_BUTTON_CLASS =
  'h-8 gap-1 rounded-[10px] border-[#e3e7f1] px-5 text-[12px] font-normal text-[#464c5e] hover:bg-[#f6f6f6] hover:text-[#18181a]';

const DEFAULT_FIELDS: ChannelCredentialFieldRead[] = [
  { key: 'bot_id', label: 'bot_id' },
  { key: 'secret', label: 'secret', secret: true },
  { key: 'corp_id', label: 'corp_id' },
];

/** 将稳定后端错误投影为当前 setup 页面可展示的 descriptor，禁止原始异常文本成为 UI。 */
function errorDescriptor(error: unknown, fallbackId: MessageId): MessageDescriptor {
  const descriptor = backendErrorMessageDescriptor(error);
  return descriptor
    ? { id: descriptor.messageId, values: descriptor.values }
    : createMessageDescriptor(fallbackId);
}

/** 将后端凭证字段键映射到稳定产品消息；未知 provider 字段标签保持 raw。 */
function credentialFieldLabel(field: ChannelCredentialFieldRead, translate: (id: MessageId) => string): string {
  switch (field.key) {
    case 'bot_id':
      return translate('channels.credentials.botIdLabel');
    case 'secret':
      return translate('channels.credentials.botSecretLabel');
    case 'corp_id':
      return translate('channels.credentials.corpIdLabel');
    default:
      return field.label;
  }
}

/** 渲染企业微信凭证配置区域；provider 字段值原样提交和回显，不参与翻译。 */
export default function WecomSetup({
  binding,
  meta,
  onChanged,
}: {
  binding: ChannelBindingRead;
  meta?: ChannelMetaRead;
  onChanged: (updated: ChannelBindingRead) => void;
}) {
  const { t } = useAppIntl();
  const toast = createToastNotifier({ t });
  const fields = meta?.credential_fields?.length ? meta.credential_fields : DEFAULT_FIELDS;
  // bot_id 是 ChannelBindingRead 的顶层字段(后端 DTO 不回传 config_json)
  const configuredBotId =
    (typeof binding.bot_id === 'string' && binding.bot_id) ||
    (typeof binding.config_json?.bot_id === 'string' ? binding.config_json.bot_id : '');
  const configuredCorpId =
    (typeof binding.corp_id === 'string' && binding.corp_id) ||
    (typeof binding.config_json?.corp_id === 'string' ? binding.config_json.corp_id : '');
  const [editing, setEditing] = useState(!configuredBotId);
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  /** 保存企业微信凭证；provider 字段值保持 raw，仅作为 API 参数提交。 */
  async function save() {
    const incomplete = fields.some(
      (field) => !field.optional && !String(values[field.key] || '').trim(),
    );
    if (incomplete) {
      toast.error(createMessageDescriptor('channels.credentials.completeRequired'));
      return;
    }
    setSaving(true);
    try {
      const payload: Record<string, string> = { tenant_id: TENANT_ID };
      fields.forEach((field) => {
        const value = String(values[field.key] || '').trim();
        if (value) payload[field.key] = value;
      });
      const updated = await api.post<ChannelBindingRead>(
        `/api/enterprise/channels/${binding.id}/wecom/credentials`,
        payload,
      );
      toast.success(createMessageDescriptor('channels.toast.saved'));
      setValues({});
      setEditing(false);
      onChanged(updated);
    } catch (error) {
      toast.error(errorDescriptor(error, 'channels.credentials.saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  if (configuredBotId && !editing) {
    return (
      <div className="flex flex-wrap items-center gap-[10px] rounded-[10px] bg-[#fafbfc] p-[16px]">
        <span className="text-[12px] text-[#464c5e]">{t('channels.credentials.configured')}</span>
        <span className="text-[12px] text-[#858b9c]">
          {t('channels.credentials.botIdLabel')}: <RawIdentifier value={configuredBotId} />
        </span>
        {configuredCorpId && (
          <span className="text-[12px] text-[#858b9c]">
            {t('channels.credentials.corpIdLabel')}: <RawIdentifier value={configuredCorpId} />
          </span>
        )}
        <StatusBadge tone={binding.connected ? 'green' : 'gray'}>
          {binding.connected ? t('channels.status.connected') : t('channels.status.disconnected')}
        </StatusBadge>
        <UIButton
          variant="outline"
          onClick={() => {
            setValues({
              bot_id: configuredBotId,
              ...(configuredCorpId ? { corp_id: configuredCorpId } : {}),
            });
            setEditing(true);
          }}
          className={OUTLINE_BUTTON_CLASS}
        >
          {t('channels.credentials.reconfigure')}
        </UIButton>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-[12px] rounded-[10px] bg-[#fafbfc] p-[16px]">
      <span className="text-[12px] leading-[1.6] text-[#858b9c]">
        {t('channels.credentials.wecomPath')}
      </span>
      {fields.map((field) => (
        <label key={field.key} className="flex flex-col gap-[6px] text-[12px] text-[#464c5e]">
          {credentialFieldLabel(field, t)}
          <Input
            type={field.secret ? 'password' : 'text'}
            value={values[field.key] || ''}
            placeholder={field.placeholder || ''}
            autoComplete="off"
            onChange={(event) =>
              setValues((prev) => ({ ...prev, [field.key]: event.target.value }))
            }
            className="h-8 rounded-[10px] text-[12px]"
          />
          {field.key === 'corp_id' && (
            <span className="text-[11px] leading-[1.5] text-[#a0a6b8]">
              {t('channels.credentials.corpIdHelp')}
            </span>
          )}
        </label>
      ))}
      <div className="flex justify-end gap-[8px]">
        {configuredBotId && (
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
