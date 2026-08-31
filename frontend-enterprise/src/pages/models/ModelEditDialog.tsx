import { useEffect, useState, type ReactNode } from 'react';
import { LoaderCircle, LogIn, LogOut } from 'lucide-react';

import { api, ApiError } from '@/api/client';
import { TENANT_ID } from '@/api/client';
import { useAppIntl } from '@/i18n';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
} from '@/components/ui';
import { Button as UIButton } from '@/components/ui/button';
import { notify } from '@/components/ui/app-toast';
import IconModels from '@/assets/icons/sys-models.svg?react';
import type { CodexSubscriptionAccountRead, ModelAuthMode, ModelConfigRead } from '@/types';
import { modelActionError, providerErrorFromApiError, subscriptionAccountMessage, toastContentForProviderError } from '../ModelsPage';
import { CONFIG_NAME_MAX_LENGTH, type ApiKeyProtocol } from './channelPresets';

export type ModelEditDialogProps = {
  open: boolean;
  selected: ModelConfigRead | null;
  availableProtocols: ApiKeyProtocol[];
  subscriptionAccount: CodexSubscriptionAccountRead | null;
  subscriptionLoading: boolean;
  onStartSubscriptionLogin: () => void;
  onCancelSubscriptionLogin: () => void;
  onRequestSubscriptionLogout: () => void;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
};

type ModelForm = {
  name: string;
  auth_mode: ModelAuthMode;
  api_protocol: ApiKeyProtocol;
  base_url: string;
  model: string;
  api_key: string;
  temperature: string;
  max_output_tokens: string;
  extra_body: string;
  is_default: boolean;
  enabled: boolean;
};

const BLANK_FORM: ModelForm = {
  name: '',
  auth_mode: 'api_key',
  api_protocol: 'openai_chat_completions',
  base_url: '',
  model: '',
  api_key: '',
  temperature: '0.2',
  max_output_tokens: '8192',
  extra_body: '{}',
  is_default: false,
  enabled: true,
};

/** 将 API 协议映射为统一语义名称，避免编辑页复制协议标签字面量。 */
function protocolLabel(protocol: ApiKeyProtocol, t: ReturnType<typeof useAppIntl>['t']): string {
  switch (protocol) {
    case 'openai_chat_completions':
      return t('chat.modelSetup.protocol.openaiChat');
    case 'openai_responses':
      return t('chat.modelSetup.protocol.openaiResponses');
    case 'anthropic_messages':
      return t('chat.modelSetup.protocol.anthropicMessages');
    default:
      return t('chat.modelSetup.protocol.gemini');
  }
}

export default function ModelEditDialog({
  open,
  selected,
  availableProtocols,
  subscriptionAccount,
  subscriptionLoading,
  onStartSubscriptionLogin,
  onCancelSubscriptionLogin,
  onRequestSubscriptionLogout,
  onOpenChange,
  onSaved,
}: ModelEditDialogProps) {
  const { t } = useAppIntl();
  const [form, setForm] = useState<ModelForm>(BLANK_FORM);
  const [saving, setSaving] = useState(false);
  const [saveStage, setSaveStage] = useState<'saving' | 'testing' | null>(null);

  useEffect(() => {
    if (!open || !selected) return;
    setForm({
      name: selected.name,
      auth_mode: selected.auth_mode || 'api_key',
      api_protocol: selected.auth_mode === 'chatgpt_subscription'
        ? 'openai_chat_completions'
        : selected.api_protocol as ApiKeyProtocol,
      base_url: selected.base_url || '',
      model: selected.model,
      api_key: '',
      temperature: String(selected.temperature),
      max_output_tokens: String(selected.max_output_tokens),
      extra_body: JSON.stringify(selected.extra_body || {}, null, 2),
      is_default: selected.is_default,
      enabled: selected.enabled,
    });
  }, [open, selected]);

  const updateForm = <K extends keyof ModelForm>(key: K, value: ModelForm[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const isSubscriptionForm = form.auth_mode === 'chatgpt_subscription';

  function closeDialog() {
    if (saving) return;
    onOpenChange(false);
  }

  async function save() {
    if (!selected) return;
    const name = form.name.trim();
    const model = form.model.trim();
    if (!name || !model) {
      notify.error(t('modelSetup.validation.requiredFields'));
      return;
    }
    const temperature = Number(form.temperature);
    const maxOutputTokens = Number(form.max_output_tokens);
    // A blank field must not silently become 0 — Number('') is 0, which
    // passes Number.isNaN and gets sent as a real (nonsensical) value.
    if (
      !form.temperature.trim() ||
      !form.max_output_tokens.trim() ||
      Number.isNaN(temperature) ||
      Number.isNaN(maxOutputTokens)
    ) {
      notify.error(t('modelSetup.validation.numericFields'));
      return;
    }
    let extraBody: Record<string, unknown> = {};
    if (!isSubscriptionForm) {
      try {
        const parsed = JSON.parse(form.extra_body.trim() || '{}') as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('not an object');
        }
        extraBody = parsed as Record<string, unknown>;
      } catch {
        notify.error(t('modelSetup.validation.extraBodyInvalid'));
        return;
      }
    }
    const payload = {
      tenant_id: TENANT_ID,
      name,
      auth_mode: form.auth_mode,
      model,
      temperature,
      max_output_tokens: maxOutputTokens,
      is_default: form.enabled && form.is_default,
      enabled: form.enabled,
      ...(isSubscriptionForm ? {} : {
        api_protocol: form.api_protocol,
        base_url: form.base_url.trim() || undefined,
        extra_body: extraBody,
        api_key: form.api_key || undefined,
      }),
    };
    setSaving(true);
    setSaveStage(form.enabled ? 'testing' : 'saving');
    try {
      const verifyQuery = form.enabled ? '?verify_before_save=true' : '';
      await api.put<ModelConfigRead>(`/api/enterprise/model-configs/${selected.id}${verifyQuery}`, payload);
      if (form.enabled) {
        notify.success(form.is_default ? t('modelSetup.toast.enabledDefault') : t('modelSetup.toast.enabled'));
      } else {
        notify.success(t('modelSetup.toast.saved'));
      }
      onOpenChange(false);
      onSaved();
    } catch (error) {
      const providerError = error instanceof ApiError ? providerErrorFromApiError(error) : null;
      notify.error(
        providerError
          ? toastContentForProviderError(providerError, t('modelSetup.toast.saveFailed'))
          : modelActionError(error, t('modelSetup.toast.saveFailed')),
      );
    } finally {
      setSaving(false);
      setSaveStage(null);
    }
  }

  if (!selected) return null;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && closeDialog()}>
      <DialogContent
        aria-describedby={undefined}
        className="flex max-h-[calc(100dvh-4rem)] w-[calc(100%-2rem)] flex-col gap-[16px] overflow-hidden rounded-[14px] px-[20px] py-[16px] sm:max-w-[640px]"
      >
        <div className="flex items-center gap-[6px] px-[12px] text-[#757f9c]">
          <IconModels className="size-[14px] shrink-0" />
          <DialogTitle className="min-w-0 truncate text-[14px] font-normal leading-none text-[#757f9c]">
            {t('modelsPage.edit.title', { name: selected.name })}
          </DialogTitle>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-[12px]">
          <div className="grid grid-cols-1 gap-[14px] sm:grid-cols-2">
            <LabeledField label={t('chat.modelSetup.name')}>
              <Input
                value={form.name}
                placeholder={t('modelSetup.field.configNamePlaceholder')}
                maxLength={CONFIG_NAME_MAX_LENGTH}
                onChange={(event) => updateForm('name', event.target.value)}
              />
              {form.name.length >= CONFIG_NAME_MAX_LENGTH && (
                <p className="text-[11px] text-[#b42318]">
                  {t('modelSetup.validation.nameLength', { count: CONFIG_NAME_MAX_LENGTH })}
                </p>
              )}
            </LabeledField>
            <LabeledField label={t('modelsPage.column.authMode')}>
              <Select
                value={form.auth_mode}
                onValueChange={(value) => updateForm('auth_mode', value as ModelAuthMode)}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="api_key">{t('modelsPage.authMode.apiKey')}</SelectItem>
                  <SelectItem value="chatgpt_subscription">{t('modelsPage.authMode.subscription')}</SelectItem>
                </SelectContent>
              </Select>
            </LabeledField>
            <LabeledField label={t('modelSetup.field.modelLabel')}>
              <Input value={form.model} placeholder={t('chat.modelSetup.modelPlaceholder')} onChange={(event) => updateForm('model', event.target.value)} />
            </LabeledField>
            {isSubscriptionForm ? (
              <div className="flex flex-col gap-[10px] rounded-[10px] border border-[#dce7ff] bg-[#f6f9ff] p-[12px] sm:col-span-2">
                <div className="flex flex-wrap items-start justify-between gap-[10px]">
                  <div className="min-w-0">
                    <p className="text-[12px] font-medium text-[#29466f]">{t('modelsPage.card.subscription')}</p>
                    <p className="mt-[3px] text-[12px] leading-[18px] text-[#5d6f8c]">
                      {subscriptionAccount ? subscriptionAccount.message ? subscriptionAccountMessage(subscriptionAccount) : subscriptionAccountMessage(subscriptionAccount) : t('modelsPage.subscription.pending')}
                      {subscriptionAccount?.status === 'connected' && subscriptionAccount.plan_type
                        ? `（${subscriptionAccount.plan_type}）`
                        : ''}
                    </p>
                  </div>
                  {subscriptionAccount?.status === 'connected' ? (
                    <UIButton
                      type="button"
                      variant="outline"
                      disabled={subscriptionLoading}
                      onClick={onRequestSubscriptionLogout}
                      className="h-[30px] gap-[4px] border-[#cbd8f2] bg-white px-[10px] text-[12px] text-[#464c5e]"
                    >
                      <LogOut className="size-[13px]" />
                      {t('modelsPage.confirm.logout.confirm')}
                    </UIButton>
                  ) : subscriptionAccount?.status === 'pending' ? (
                    <UIButton
                      type="button"
                      variant="outline"
                      disabled={subscriptionLoading}
                      onClick={onCancelSubscriptionLogin}
                      className="h-[30px] border-[#cbd8f2] bg-white px-[10px] text-[12px] text-[#464c5e]"
                    >
                      {t('modelSetup.actions.cancelLogin')}
                    </UIButton>
                  ) : (
                    <UIButton
                      type="button"
                      disabled={subscriptionLoading}
                      onClick={onStartSubscriptionLogin}
                      className="h-[30px] gap-[4px] bg-[#1a71ff] px-[10px] text-[12px] text-white hover:bg-[#1463df]"
                    >
                      {subscriptionLoading ? <LoaderCircle className="size-[13px] animate-spin" /> : <LogIn className="size-[13px]" />}
                      {t('modelSetup.actions.connectSubscription')}
                    </UIButton>
                  )}
                </div>
                <p className="text-[11px] leading-[16px] text-[#7483a0]">
                  {t('modelsPage.subscription.ownershipNotice')}
                </p>
              </div>
            ) : (
              <>
                <LabeledField label={t('chat.modelSetup.protocol')}>
                  <Select
                    value={form.api_protocol}
                    onValueChange={(value) => updateForm('api_protocol', value as ApiKeyProtocol)}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {availableProtocols.includes('openai_chat_completions') && (
                        <SelectItem value="openai_chat_completions">{protocolLabel('openai_chat_completions', t)}</SelectItem>
                      )}
                      {availableProtocols.includes('openai_responses') && (
                        <SelectItem value="openai_responses">{protocolLabel('openai_responses', t)}</SelectItem>
                      )}
                      {availableProtocols.includes('anthropic_messages') && (
                        <SelectItem value="anthropic_messages">{protocolLabel('anthropic_messages', t)}</SelectItem>
                      )}
                      {availableProtocols.includes('gemini_generate_content') && (
                        <SelectItem value="gemini_generate_content">{protocolLabel('gemini_generate_content', t)}</SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                </LabeledField>
                <LabeledField label={t('chat.modelSetup.baseUrl')}>
                  <Input
                    value={form.base_url}
                    placeholder={form.api_protocol === 'openai_chat_completions' || form.api_protocol === 'openai_responses'
                      ? t('chat.modelSetup.baseUrlOpenAI')
                      : t('chat.modelSetup.baseUrlOther')}
                    onChange={(event) => updateForm('base_url', event.target.value)}
                  />
                </LabeledField>
                <LabeledField label={t('chat.modelSetup.apiKey')}>
                  <Input
                    type="password"
                    value={form.api_key}
                    placeholder={t('chat.modelSetup.keepExistingKey')}
                    onChange={(event) => updateForm('api_key', event.target.value)}
                  />
                </LabeledField>
              </>
            )}
            <div className="grid grid-cols-2 gap-[14px]">
              <LabeledField label={t('chat.modelSetup.temperature')}>
                <Input
                  type="number"
                  min={0}
                  max={form.api_protocol === 'anthropic_messages' ? 1 : 2}
                  step={0.1}
                  value={form.temperature}
                  onChange={(event) => updateForm('temperature', event.target.value)}
                />
              </LabeledField>
              <LabeledField label={t('chat.modelSetup.maxTokens')}>
                <Input
                  type="number"
                  min={128}
                  max={32000}
                  value={form.max_output_tokens}
                  onChange={(event) => updateForm('max_output_tokens', event.target.value)}
                />
              </LabeledField>
            </div>
            {!isSubscriptionForm && form.api_protocol === 'openai_chat_completions' && <div className="sm:col-span-2">
              <LabeledField label={t('modelSetup.custom.extraBodyLabel')}>
                <Textarea
                  rows={5}
                  value={form.extra_body}
                  placeholder={t('modelSetup.custom.extraBodyPlaceholder')}
                  className="min-h-[116px] resize-y font-mono text-[12px]"
                  onChange={(event) => updateForm('extra_body', event.target.value)}
                />
              </LabeledField>
            </div>}
          </div>
          <div className="mt-[16px] flex flex-wrap items-center gap-[24px]">
            <label className="flex cursor-pointer items-center gap-[8px]">
              <Switch checked={form.is_default} onCheckedChange={(next) => updateForm('is_default', next)} />
              <span className="text-[12px] font-medium text-[#464c5e]">{t('modelSetup.toggle.defaultShort')}</span>
            </label>
            <label className="flex cursor-pointer items-center gap-[8px]">
              <Switch checked={form.enabled} onCheckedChange={(next) => updateForm('enabled', next)} />
              <span className="text-[12px] font-medium text-[#464c5e]">{t('modelSetup.toggle.enabled')}</span>
            </label>
          </div>
        </div>

        <div className="flex items-center justify-end gap-[8px] px-[12px]">
          <UIButton
            variant="outline"
            disabled={saving}
            onClick={closeDialog}
            className="h-[32px] w-[80px] rounded-[10px] border-[#e3e7f1] bg-white px-[12px] text-[14px] font-normal text-[#464c5e] hover:border-[#e3e7f1] hover:bg-[#f6f6f6] hover:text-[#18181a]"
          >
            {t('common.action.cancel')}
          </UIButton>
          <UIButton
            disabled={saving}
            onClick={() => void save()}
            className="h-[32px] w-[80px] rounded-[10px] bg-[#18181a] px-[12px] text-[14px] font-normal text-white hover:bg-[#303030]"
          >
            {saving && <LoaderCircle className="size-[14px] animate-spin" />}
            {saveStage === 'testing' ? t('modelSetup.actions.testAndSave') : saving ? t('modelSetup.actions.saving') : t('common.action.save')}
          </UIButton>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function LabeledField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-[6px]">
      <span className="text-[12px] font-medium text-[#464c5e]">{label}</span>
      {children}
    </label>
  );
}
