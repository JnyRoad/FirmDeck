import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  Link2,
  LoaderCircle,
  LogIn,
  LogOut,
  Search,
  SlidersHorizontal,
  X,
} from 'lucide-react';

import { api, ApiError } from '@/api/client';
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
import type { CodexSubscriptionAccountRead, ModelConfigRead } from '@/types';
import {
  modelActionError,
  providerErrorFromApiError,
  modelProviderErrorMessage,
  subscriptionAccountMessage,
} from '../ModelsPage';
import {
  CHANNEL_PRESETS,
  CONFIG_NAME_MAX_LENGTH,
  buildModelConfigPayload,
  fetchProviderModels,
  type ApiKeyProtocol,
  type ChannelPreset,
  type CustomFormValues,
  type VendorFormValues,
} from './channelPresets';
import ModelCombobox, { type ModelComboboxOption } from './ModelCombobox';

export type ModelSetupWizardProps = {
  open: boolean;
  tenantId: string;
  onOpenChange: (open: boolean) => void;
  onCreated: (model: ModelConfigRead, options?: { tested: boolean }) => void;
  availableProtocols: ApiKeyProtocol[];
  subscriptionAccount: CodexSubscriptionAccountRead | null;
  subscriptionLoading: boolean;
  onStartSubscriptionLogin: () => void;
  onCancelSubscriptionLogin: () => void;
  onRequestSubscriptionLogout: () => void;
  requireVerified?: boolean;
};

type Step = 1 | 2;

const BLANK_VENDOR_FORM: VendorFormValues = { apiKey: '', model: '' };
const BLANK_CUSTOM_FORM: CustomFormValues = {
  apiProtocol: 'openai_chat_completions',
  baseUrl: '',
  apiKey: '',
  model: '',
  temperature: '0.2',
  maxOutputTokens: '8192',
  extraBody: '{}',
};
const BLANK_SUBSCRIPTION_FORM = { model: '' };

type ModelsFetchState = {
  status: 'idle' | 'loading' | 'success' | 'empty' | 'error';
  options: ModelComboboxOption[];
};

const IDLE_MODELS_STATE: ModelsFetchState = { status: 'idle', options: [] };

function channelIcon(preset: ChannelPreset) {
  if (preset.category === 'custom') return <SlidersHorizontal className="size-[16px]" />;
  if (preset.category === 'subscription') return <Link2 className="size-[16px]" />;
  return <span>{preset.badgeLabel}</span>;
}

/** 引导管理员在调用方租户内配置模型，并只接受当前请求代次的异步结果。 */
/** 返回渠道的语义展示名；vendor 固定品牌名保留原样，内建渠道改用 message id。 */
function channelLabel(preset: ChannelPreset, t: ReturnType<typeof useAppIntl>['t']): string {
  if (preset.id === 'chatgpt_subscription') return t('modelSetup.channel.chatgptSubscription');
  if (preset.id === 'custom') return t('modelSetup.channel.custom');
  return preset.name;
}

/** 返回渠道描述文案；静态目录只保存 message id，不保存自然语言描述。 */
function channelDescription(preset: ChannelPreset, t: ReturnType<typeof useAppIntl>['t']): string {
  return t(preset.descriptionMessageId);
}

/** 将 API 协议映射为语义名称，避免在多个页面复制协议标签字面量。 */
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

export default function ModelSetupWizard({
  open,
  tenantId,
  onOpenChange,
  onCreated,
  availableProtocols,
  subscriptionAccount,
  subscriptionLoading,
  onStartSubscriptionLogin,
  onCancelSubscriptionLogin,
  onRequestSubscriptionLogout,
  requireVerified = false,
}: ModelSetupWizardProps) {
  const { t } = useAppIntl();
  const [step, setStep] = useState<Step>(1);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [vendorForm, setVendorForm] = useState<VendorFormValues>(BLANK_VENDOR_FORM);
  const [customForm, setCustomForm] = useState<CustomFormValues>(BLANK_CUSTOM_FORM);
  const [subscriptionForm, setSubscriptionForm] = useState(BLANK_SUBSCRIPTION_FORM);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showCustomAdvanced, setShowCustomAdvanced] = useState(false);
  const [configName, setConfigName] = useState('');
  const [configNameTouched, setConfigNameTouched] = useState(false);
  const [isDefault, setIsDefault] = useState(false);
  const [enabled, setEnabled] = useState(true);
  // The id of the draft row once a plain 保存 (or a passing 测试) has
  // persisted one — null means "保存"/"测试" will create instead of update.
  const [savedModelId, setSavedModelId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saveResult, setSaveResult] = useState<'idle' | 'error'>('idle');
  const [saveErrorMessage, setSaveErrorMessage] = useState<string | null>(null);
  const [vendorModelsState, setVendorModelsState] = useState<ModelsFetchState>(IDLE_MODELS_STATE);
  const [customModelsState, setCustomModelsState] = useState<ModelsFetchState>(IDLE_MODELS_STATE);
  const [subscriptionModelsState, setSubscriptionModelsState] = useState<ModelsFetchState>(IDLE_MODELS_STATE);
  const vendorFetchSignatureRef = useRef<string | null>(null);
  const customFetchSignatureRef = useRef<string | null>(null);
  const subscriptionFetchSignatureRef = useRef<string | null>(null);
  const vendorFetchGenerationRef = useRef(0);
  const customFetchGenerationRef = useRef(0);
  const subscriptionFetchGenerationRef = useRef(0);
  const activeTenantRef = useRef(tenantId);
  activeTenantRef.current = tenantId;

  const selectedChannel = useMemo(
    () => CHANNEL_PRESETS.find((preset) => preset.id === selectedChannelId) ?? null,
    [selectedChannelId],
  );

  const filteredPresets = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    if (!keyword) return CHANNEL_PRESETS;
    return CHANNEL_PRESETS.filter((preset) =>
      channelLabel(preset, t).toLowerCase().includes(keyword) || channelDescription(preset, t).toLowerCase().includes(keyword),
    );
  }, [search, t]);

  /** 清空模型列表并让所有尚未完成的列表请求失效。 */
  function resetModelListRequests() {
    setVendorModelsState(IDLE_MODELS_STATE);
    setCustomModelsState(IDLE_MODELS_STATE);
    setSubscriptionModelsState(IDLE_MODELS_STATE);
    vendorFetchSignatureRef.current = null;
    customFetchSignatureRef.current = null;
    subscriptionFetchSignatureRef.current = null;
    vendorFetchGenerationRef.current += 1;
    customFetchGenerationRef.current += 1;
    subscriptionFetchGenerationRef.current += 1;
  }

  /** 将向导恢复到首次打开时的初始状态。 */
  function resetAllSteps() {
    setStep(1);
    setSelectedChannelId(null);
    setSearch('');
    setVendorForm(BLANK_VENDOR_FORM);
    setCustomForm(BLANK_CUSTOM_FORM);
    setSubscriptionForm(BLANK_SUBSCRIPTION_FORM);
    setShowAdvanced(false);
    setShowCustomAdvanced(false);
    setConfigName('');
    setConfigNameTouched(false);
    setIsDefault(false);
    setEnabled(true);
    setSavedModelId(null);
    setSaving(false);
    setTesting(false);
    setSaveResult('idle');
    setSaveErrorMessage(null);
    resetModelListRequests();
  }

  useEffect(() => {
    resetModelListRequests();
    // 租户是列表请求的隔离边界；其余表单状态由当前打开流程继续管理。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  function handleClose() {
    if (saving || testing) return;
    resetAllSteps();
    onOpenChange(false);
  }

  function selectChannel(preset: ChannelPreset) {
    if (preset.id === selectedChannelId) return;
    // Every channel switch clears all branches' credential fields (FR-013) — a
    // credential entered for one channel (even a same-category one, e.g.
    // switching from OpenAI to Anthropic) must never leak into another's payload.
    if (selectedChannelId !== null) {
      setVendorForm(BLANK_VENDOR_FORM);
      setCustomForm(BLANK_CUSTOM_FORM);
      setSubscriptionForm(BLANK_SUBSCRIPTION_FORM);
      resetModelListRequests();
      // A test result — and any draft row id — belongs to the channel that
      // was just saved/tested. Carrying either across a channel switch would
      // either misrepresent an untested channel as already verified, or PUT
      // this channel's credentials onto another channel's saved row.
      setSavedModelId(null);
      setSaveResult('idle');
      setSaveErrorMessage(null);
      // A name the user typed for the old channel (e.g. "OpenAI · gpt-4o")
      // has nothing to do with the newly picked one — clear it so the
      // suggested-name effect can seed a fresh default for this channel.
      setConfigName('');
      setConfigNameTouched(false);
    }
    setSelectedChannelId(preset.id);
  }

  /** 获取当前租户下预设厂商的模型列表，并丢弃被后续请求取代的响应。 */
  async function fetchVendorModelsNow(channel: ChannelPreset, apiKey: string) {
    const trimmedKey = apiKey.trim();
    if (!trimmedKey || !channel.apiProtocol || !channel.baseUrl) return;
    const requestTenantId = tenantId;
    const signature = `${requestTenantId}:${channel.id}:${trimmedKey}`;
    if (vendorFetchSignatureRef.current === signature) return;
    vendorFetchSignatureRef.current = signature;
    const requestGeneration = ++vendorFetchGenerationRef.current;
    setVendorModelsState((prev) => ({ ...prev, status: 'loading' }));
    const result = await fetchProviderModels({
      tenantId: requestTenantId,
      apiProtocol: channel.apiProtocol,
      baseUrl: channel.baseUrl,
      apiKey: trimmedKey,
    });
    if (
      activeTenantRef.current !== requestTenantId ||
      vendorFetchSignatureRef.current !== signature ||
      vendorFetchGenerationRef.current !== requestGeneration
    ) {
      return;
    }
    if (result.success && result.models.length > 0) {
      setVendorModelsState({
        status: 'success',
        options: result.models.map((model) => ({ value: model.id, label: model.label })),
      });
    } else {
      setVendorModelsState({ status: result.success ? 'empty' : 'error', options: [] });
    }
  }

  /** 获取当前租户下自定义渠道的模型列表，并丢弃被后续请求取代的响应。 */
  async function fetchCustomModelsNow(form: CustomFormValues) {
    const baseUrl = form.baseUrl.trim();
    const apiKey = form.apiKey.trim();
    if (!baseUrl || !apiKey) return;
    const requestTenantId = tenantId;
    const signature = `${requestTenantId}:${form.apiProtocol}:${baseUrl}:${apiKey}`;
    if (customFetchSignatureRef.current === signature) return;
    customFetchSignatureRef.current = signature;
    const requestGeneration = ++customFetchGenerationRef.current;
    setCustomModelsState((prev) => ({ ...prev, status: 'loading' }));
    const result = await fetchProviderModels({
      tenantId: requestTenantId,
      apiProtocol: form.apiProtocol,
      baseUrl,
      apiKey,
    });
    if (
      activeTenantRef.current !== requestTenantId ||
      customFetchSignatureRef.current !== signature ||
      customFetchGenerationRef.current !== requestGeneration
    ) {
      return;
    }
    if (result.success && result.models.length > 0) {
      setCustomModelsState({
        status: 'success',
        options: result.models.map((model) => ({ value: model.id, label: model.label })),
      });
    } else {
      setCustomModelsState({ status: result.success ? 'empty' : 'error', options: [] });
    }
  }

  // The form object for whichever branch is active — shared by suggestedName() and save()
  // so both read `.model`/pass values through the same place instead of re-deriving it.
  const currentFormValues = selectedChannel
    ? selectedChannel.category === 'vendor'
      ? vendorForm
      : selectedChannel.category === 'custom'
        ? customForm
        : subscriptionForm
    : null;

  const vendorStepComplete = vendorForm.apiKey.trim() !== '' && vendorForm.model.trim() !== '';
  const customStepComplete =
    customForm.baseUrl.trim() !== '' && customForm.apiKey.trim() !== '' && customForm.model.trim() !== '';
  // Drives the connection-gated UI (model field enabled, auto-fetch effect) —
  // it must stay based on connection status alone, not the model field, or
  // the model list would never fetch before a model is typed.
  const subscriptionStepComplete = subscriptionAccount?.status === 'connected';
  // Gates 测试/保存: connected alone isn't enough — without a model, a "test"
  // would silently run against whatever default the backend happens to pick,
  // wasting an API call on a result the user never actually asked to verify.
  const subscriptionFormComplete = subscriptionStepComplete && subscriptionForm.model.trim() !== '';

  // The local Codex app-server has a real model/list RPC — fetch it once as
  // soon as the subscription connects, the same way the API-key branches
  // fetch on blur.
  useEffect(() => {
    if (!subscriptionStepComplete) {
      subscriptionFetchSignatureRef.current = null;
      subscriptionFetchGenerationRef.current += 1;
      setSubscriptionModelsState(IDLE_MODELS_STATE);
      return;
    }
    const requestTenantId = tenantId;
    const signature = `${requestTenantId}:codex_app_server`;
    if (subscriptionFetchSignatureRef.current === signature) return;
    subscriptionFetchSignatureRef.current = signature;
    const requestGeneration = ++subscriptionFetchGenerationRef.current;
    setSubscriptionModelsState({ status: 'loading', options: [] });
    void fetchProviderModels({ tenantId: requestTenantId, apiProtocol: 'codex_app_server' }).then((result) => {
      if (
        activeTenantRef.current !== requestTenantId ||
        subscriptionFetchSignatureRef.current !== signature ||
        subscriptionFetchGenerationRef.current !== requestGeneration
      ) {
        return;
      }
      if (result.success && result.models.length > 0) {
        setSubscriptionModelsState({
          status: 'success',
          options: result.models.map((model) => ({ value: model.id, label: model.label })),
        });
      } else {
        setSubscriptionModelsState({ status: result.success ? 'empty' : 'error', options: [] });
      }
    });
  }, [subscriptionStepComplete, tenantId]);

  const step2Complete = selectedChannel
    ? selectedChannel.category === 'vendor'
      ? vendorStepComplete
      : selectedChannel.category === 'custom'
        ? customStepComplete
        : subscriptionFormComplete
    : false;

  function suggestedName(): string {
    if (!selectedChannel || !currentFormValues) return '';
    const model = currentFormValues.model;
    const baseName = channelLabel(selectedChannel, t);
    const name = model ? `${baseName} · ${model}` : baseName;
    return name.slice(0, CONFIG_NAME_MAX_LENGTH);
  }

  // Keeps 配置名称 in sync with the channel/model choice until the user edits
  // it themselves — step 2 now includes naming, so this has to stay live
  // instead of being seeded once when moving to a separate naming step.
  useEffect(() => {
    if (configNameTouched) return;
    setConfigName(suggestedName());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedChannel, currentFormValues?.model, configNameTouched]);

  // Both 保存 and 测试 persist the same payload; they differ only in whether
  // the backend verifies+activates it (`verify`) and in what happens after.
  // buildModelConfigPayload throws (caught by the caller) on an invalid
  // extra_body; this only returns null when there's no channel selected.
  async function persist(verify: boolean): Promise<ModelConfigRead | null> {
    if (!selectedChannel) return null;
    const name = configName.trim() || suggestedName();
    // A plain (unverified) save must never claim enabled/default — the
    // backend rejects `enabled: true` on an update whose trust hasn't
    // changed, and either way an unverified row has no business being live.
    const payload = buildModelConfigPayload(selectedChannel, currentFormValues!, {
      name,
      isDefault: verify && isDefault,
      enabled: verify && enabled,
    });
    const query = verify ? '?verify_before_save=true' : '';
    const body = { tenant_id: tenantId, ...payload };
    const saved = savedModelId
      ? await api.put<ModelConfigRead>(`/api/enterprise/model-configs/${savedModelId}${query}`, body)
      : await api.post<ModelConfigRead>(`/api/enterprise/model-configs${query}`, body);
    setSavedModelId(saved.id);
    return saved;
  }

  async function saveDraft() {
    setSaving(true);
    setSaveResult('idle');
    setSaveErrorMessage(null);
    try {
      const saved = await persist(false);
      if (saved) onCreated(saved, { tested: false });
    } catch (error) {
      const providerError = error instanceof ApiError ? providerErrorFromApiError(error) : null;
      setSaveErrorMessage(
        providerError
          ? modelProviderErrorMessage(providerError, t('modelSetup.toast.saveFailed'))
          : modelActionError(error, t('modelSetup.toast.saveFailed')),
      );
      setSaveResult('error');
    } finally {
      setSaving(false);
    }
  }

  async function runTest() {
    setTesting(true);
    setSaveResult('idle');
    setSaveErrorMessage(null);
    try {
      const saved = await persist(true);
      if (!saved) return;
      // Test passed and the model is already saved+enabled — nothing left
      // for the user to confirm, so the wizard just closes instead of
      // asking for an extra "完成" click.
      onCreated(saved, { tested: true });
      resetAllSteps();
      onOpenChange(false);
    } catch (error) {
      const providerError = error instanceof ApiError ? providerErrorFromApiError(error) : null;
      setSaveErrorMessage(
        providerError
          ? modelProviderErrorMessage(providerError, t('modelSetup.toast.testFailed'))
          : modelActionError(error, t('modelSetup.toast.testFailed')),
      );
      setSaveResult('error');
    } finally {
      setTesting(false);
    }
  }

  const step1Summary = selectedChannel ? channelLabel(selectedChannel, t) : undefined;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && handleClose()}>
      <DialogContent
        aria-describedby={undefined}
        showCloseButton={false}
        className="flex h-[720px] max-h-[calc(100dvh-4rem)] w-[calc(100%-2rem)] flex-col overflow-hidden rounded-[14px] p-0 sm:max-w-[860px]"
      >
        <DialogTitle className="sr-only">{t('modelSetup.title')}</DialogTitle>
        <div className="flex min-h-0 flex-1">
          <nav className="flex w-[220px] shrink-0 flex-col gap-[4px] border-r border-[#f0f1f4] bg-[#fafbfc] p-[20px_14px]">
            <span className="px-[10px] pb-[14px] text-[12px] font-semibold text-[#858b9c]">{t('modelSetup.title')}</span>
            <SidebarStep index={1} label={t('modelSetup.steps.select')} current={step} summary={step1Summary} onJump={setStep} />
            <SidebarConnector />
            <SidebarStep index={2} label={t('modelSetup.steps.credentials')} current={step} onJump={setStep} />
          </nav>

          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-start justify-between gap-[10px] px-[24px] pt-[18px]">
              <StepHeader step={step} selectedChannel={selectedChannel} t={t} />
              <button
                type="button"
                aria-label={t('modelSetup.actions.close')}
                onClick={handleClose}
                className="grid size-[28px] shrink-0 place-items-center rounded-[8px] text-[#858b9c] outline-none hover:text-[#18181a]"
              >
                <X className="size-[14px]" />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-[24px] py-[18px]">
              {step === 1 && (
                <div className="flex h-full flex-col gap-[12px]">
                  <label className="flex h-[36px] shrink-0 items-center gap-[8px] rounded-[10px] border border-[#e3e7f1] px-[12px]">
                    <Search className="size-[14px] text-[#858b9c]" />
                    <input
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder={t('modelSetup.search.placeholder')}
                      className="min-w-0 flex-1 border-none text-[13px] text-[#18181a] outline-none"
                    />
                  </label>

                  <div className="min-h-0 flex-1 overflow-y-auto rounded-[12px] border border-[#e3e7f1]">
                    {filteredPresets.length === 0 ? (
                      <p className="p-[24px] text-center text-[13px] text-[#858b9c]">{t('modelSetup.emptySearch')}</p>
                    ) : (
                      filteredPresets.map((preset) => (
                        <ChannelRow
                          key={preset.id}
                          preset={preset}
                          label={channelLabel(preset, t)}
                          description={channelDescription(preset, t)}
                          selected={preset.id === selectedChannelId}
                          onSelect={() => selectChannel(preset)}
                        />
                      ))
                    )}
                  </div>
                </div>
              )}

              {step === 2 && selectedChannel && (
                <LabeledField label={t('chat.modelSetup.name')}>
                  <Input
                    value={configName}
                    maxLength={CONFIG_NAME_MAX_LENGTH}
                    onChange={(event) => {
                      setConfigNameTouched(true);
                      setConfigName(event.target.value);
                    }}
                  />
                  {configName.length >= CONFIG_NAME_MAX_LENGTH && (
                    <p className="text-[11px] text-[#b42318]">
                      {t('modelSetup.validation.nameLength', { count: CONFIG_NAME_MAX_LENGTH })}
                    </p>
                  )}
                </LabeledField>
              )}

              {step === 2 && selectedChannel?.category === 'vendor' && (
                <div className="mt-[16px] flex flex-col gap-[16px]">
                  <LabeledField label={t('chat.modelSetup.apiKey')}>
                    <Input
                      type="password"
                      value={vendorForm.apiKey}
                      placeholder={t('modelSetup.field.apiKeyPlaceholder')}
                      onChange={(event) => setVendorForm((prev) => ({ ...prev, apiKey: event.target.value }))}
                      onBlur={() => void fetchVendorModelsNow(selectedChannel, vendorForm.apiKey)}
                    />
                  </LabeledField>
                  <LabeledField label={t('modelSetup.field.modelLabel')}>
                    <ModelCombobox
                      value={vendorForm.model}
                      onChange={(value) => setVendorForm((prev) => ({ ...prev, model: value }))}
                      options={vendorModelsState.status === 'success' ? vendorModelsState.options : []}
                      loading={vendorModelsState.status === 'loading'}
                      placeholder={t('modelSetup.field.modelPlaceholder')}
                    />
                    {vendorModelsState.status === 'success' && (
                      <p className="text-[11px] text-[#247447]">{t('modelSetup.vendor.modelsFetched', { count: vendorModelsState.options.length })}</p>
                    )}
                    {(vendorModelsState.status === 'empty' || vendorModelsState.status === 'error') && (
                      <p className="text-[11px] text-[#858b9c]">{t('modelSetup.vendor.modelsFallback')}</p>
                    )}
                  </LabeledField>
                  <button
                    type="button"
                    onClick={() => setShowAdvanced((prev) => !prev)}
                    className="flex w-fit items-center gap-[4px] text-[12px] text-[#757f9c] hover:text-[#18181a]"
                  >
                    <ChevronRight className={`size-[12px] transition-transform ${showAdvanced ? 'rotate-90' : ''}`} />
                    {t('modelSetup.vendor.advancedToggle')}
                  </button>
                  {showAdvanced && (
                    <p className="rounded-[10px] bg-[#f6f6f7] p-[12px] text-[12px] leading-[18px] text-[#757f9c]">
                      {t('modelSetup.vendor.advancedSummary', {
                        protocol: protocolLabel(selectedChannel.apiProtocol as ApiKeyProtocol, t),
                        baseUrl: selectedChannel.baseUrl ?? '',
                      })}
                    </p>
                  )}
                </div>
              )}

              {step === 2 && selectedChannel?.category === 'custom' && (
                <div className="mt-[16px] flex flex-col gap-[14px]">
                  <div className="grid grid-cols-2 gap-[14px]">
                    <LabeledField label={t('chat.modelSetup.protocol')}>
                      <Select
                        value={customForm.apiProtocol}
                        onValueChange={(value) => {
                          // Both the fetched model list and whatever model was
                          // already picked belong to the old protocol — keeping
                          // either around would let the user save a model id
                          // that was never valid for the newly picked protocol.
                          const next = { ...customForm, apiProtocol: value as ApiKeyProtocol, model: '' };
                          customFetchSignatureRef.current = null;
                          setCustomModelsState(IDLE_MODELS_STATE);
                          setCustomForm(next);
                          void fetchCustomModelsNow(next);
                        }}
                      >
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {availableProtocols.map((protocol) => (
                            <SelectItem key={protocol} value={protocol}>{protocolLabel(protocol, t)}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </LabeledField>
                    <LabeledField label={t('modelSetup.field.modelLabel')}>
                      <ModelCombobox
                        value={customForm.model}
                        onChange={(value) => setCustomForm((prev) => ({ ...prev, model: value }))}
                        options={customModelsState.options}
                        loading={customModelsState.status === 'loading'}
                        placeholder={t('modelSetup.field.modelPlaceholder')}
                      />
                    </LabeledField>
                  </div>
                  <LabeledField label={t('chat.modelSetup.baseUrl')}>
                    <Input
                      value={customForm.baseUrl}
                      placeholder={t('modelSetup.custom.baseUrlPlaceholder')}
                      onChange={(event) => setCustomForm((prev) => ({ ...prev, baseUrl: event.target.value }))}
                      onBlur={() => void fetchCustomModelsNow(customForm)}
                    />
                  </LabeledField>
                  <LabeledField label={t('chat.modelSetup.apiKey')}>
                    <Input
                      type="password"
                      value={customForm.apiKey}
                      placeholder={t('modelSetup.field.apiKeyPlaceholder')}
                      onChange={(event) => setCustomForm((prev) => ({ ...prev, apiKey: event.target.value }))}
                      onBlur={() => void fetchCustomModelsNow(customForm)}
                    />
                  </LabeledField>
                  {(customModelsState.status === 'empty' || customModelsState.status === 'error') && (
                    <p className="-mt-[6px] text-[11px] text-[#858b9c]">{t('modelSetup.custom.modelsFallback')}</p>
                  )}
                  {customModelsState.status === 'success' && (
                    <p className="-mt-[6px] text-[11px] text-[#247447]">{t('modelSetup.custom.modelsFetched', { count: customModelsState.options.length })}</p>
                  )}
                  <button
                    type="button"
                    onClick={() => setShowCustomAdvanced((prev) => !prev)}
                    className="flex w-fit items-center gap-[4px] text-[12px] text-[#757f9c] hover:text-[#18181a]"
                  >
                    <ChevronRight className={`size-[12px] transition-transform ${showCustomAdvanced ? 'rotate-90' : ''}`} />
                    {t('modelSetup.custom.advancedToggle')}
                  </button>
                  {showCustomAdvanced && (
                    <div className="flex flex-col gap-[14px]">
                      <div className="grid grid-cols-2 gap-[14px]">
                        <LabeledField label={t('chat.modelSetup.temperature')}>
                          <Input
                            type="number"
                            min={0}
                            max={customForm.apiProtocol === 'anthropic_messages' ? 1 : 2}
                            step={0.1}
                            value={customForm.temperature}
                            onChange={(event) => setCustomForm((prev) => ({ ...prev, temperature: event.target.value }))}
                          />
                        </LabeledField>
                        <LabeledField label={t('chat.modelSetup.maxTokens')}>
                          <Input
                            type="number"
                            min={128}
                            max={32000}
                            value={customForm.maxOutputTokens}
                            onChange={(event) => setCustomForm((prev) => ({ ...prev, maxOutputTokens: event.target.value }))}
                          />
                        </LabeledField>
                      </div>
                      <LabeledField label={t('modelSetup.custom.extraBodyLabel')}>
                        <Textarea
                          rows={5}
                          value={customForm.extraBody}
                          placeholder={t('modelSetup.custom.extraBodyPlaceholder')}
                          className="min-h-[116px] resize-y font-mono text-[12px]"
                          onChange={(event) => setCustomForm((prev) => ({ ...prev, extraBody: event.target.value }))}
                        />
                      </LabeledField>
                    </div>
                  )}
                </div>
              )}

              {step === 2 && selectedChannel?.category === 'subscription' && (
                <div className="mt-[16px] flex flex-col gap-[16px]">
                  <div className="flex flex-col gap-[10px] rounded-[12px] border border-[#dce7ff] bg-[#f6f9ff] p-[16px]">
                    <div className="flex flex-wrap items-center justify-between gap-[12px]">
                      <div>
                        <p className="text-[13px] font-semibold text-[#29466f]">
                          {t('modelsPage.card.subscription')}
                        </p>
                        <p className="mt-[2px] text-[12px] text-[#5d6f8c]">
                          {subscriptionAccount ? subscriptionAccountMessage(subscriptionAccount) : t('modelsPage.subscription.pending')}
                        </p>
                      </div>
                      {subscriptionAccount?.status === 'connected' ? (
                        <UIButton
                          type="button"
                          variant="outline"
                          disabled={subscriptionLoading}
                          onClick={onRequestSubscriptionLogout}
                          className="h-[32px] gap-[6px] border-[#cbd8f2] bg-white px-[10px] text-[12px] text-[#464c5e]"
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
                          className="h-[32px] border-[#cbd8f2] bg-white px-[10px] text-[12px] text-[#464c5e]"
                        >
                          {t('modelSetup.actions.cancelLogin')}
                        </UIButton>
                      ) : (
                        <UIButton
                          type="button"
                          disabled={subscriptionLoading}
                          onClick={onStartSubscriptionLogin}
                          className="h-[32px] gap-[6px] bg-[#1a71ff] px-[10px] text-[12px] text-white hover:bg-[#1463df]"
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
                  <LabeledField label={t('modelSetup.field.modelLabel')}>
                    <ModelCombobox
                      disabled={!subscriptionStepComplete}
                      value={subscriptionForm.model}
                      options={subscriptionModelsState.status === 'success' ? subscriptionModelsState.options : []}
                      loading={subscriptionModelsState.status === 'loading'}
                      placeholder={subscriptionStepComplete ? t('modelSetup.field.modelPlaceholder') : t('modelSetup.subscription.modelPlaceholderDisabled')}
                      onChange={(value) => setSubscriptionForm({ model: value })}
                    />
                    {subscriptionModelsState.status === 'success' && (
                      <p className="text-[11px] text-[#247447]">{t('modelSetup.vendor.modelsFetched', { count: subscriptionModelsState.options.length })}</p>
                    )}
                    {(subscriptionModelsState.status === 'empty' || subscriptionModelsState.status === 'error') && (
                      <p className="text-[11px] text-[#858b9c]">{t('modelSetup.vendor.modelsFallback')}</p>
                    )}
                  </LabeledField>
                </div>
              )}

              {step === 2 && selectedChannel && (
                <div className="mt-[4px] flex flex-col gap-[16px] border-t border-[#f0f1f4] pt-[16px]">
                  <div className="flex flex-wrap items-center gap-[24px]">
                    <label className="flex cursor-pointer items-center gap-[8px]">
                      <Switch checked={isDefault} onCheckedChange={setIsDefault} />
                      <span className="text-[12px] font-medium text-[#464c5e]">{t('modelSetup.toggle.default')}</span>
                    </label>
                    <label className="flex cursor-pointer items-center gap-[8px]">
                      <Switch checked={enabled} onCheckedChange={setEnabled} />
                      <span className="text-[12px] font-medium text-[#464c5e]">{t('modelSetup.toggle.enabled')}</span>
                    </label>
                  </div>

                  {saveResult === 'error' && saveErrorMessage && (
                    <div className="flex items-start gap-[10px] rounded-[10px] border border-[#f2c4c4] bg-[#fff5f5] p-[12px]">
                      <span className="text-[13px] text-[#b42318]">{saveErrorMessage}</span>
                    </div>
                  )}
                  {saveResult !== 'error' && savedModelId && (
                    <p className="text-[12px] text-[#858b9c]">
                      {t('modelSetup.draftSavedHint')}
                    </p>
                  )}
                </div>
              )}
            </div>

            <div className="flex items-center justify-between border-t border-[#f0f1f4] px-[24px] py-[14px]">
              {step === 1 ? (
                  <button type="button" onClick={handleClose} className="h-[32px] px-[8px] text-[13px] text-[#757f9c] hover:text-[#18181a]">
                  {t('modelSetup.actions.cancel')}
                  </button>
              ) : (
                <UIButton
                  type="button"
                  variant="outline"
                  disabled={saving || testing}
                  onClick={() => setStep((prev) => (prev - 1) as Step)}
                  className="h-[34px] gap-[6px] rounded-[10px] border-[#e3e7f1] bg-white px-[16px] text-[13px] text-[#464c5e]"
                >
                  <ArrowLeft className="size-[14px]" />
                  {t('modelSetup.actions.back')}
                </UIButton>
              )}

              {step === 1 && (
                <UIButton
                  type="button"
                  disabled={!selectedChannelId}
                  onClick={() => setStep(2)}
                  className="h-[34px] gap-[6px] rounded-[10px] bg-[#18181a] px-[20px] text-[13px] text-white hover:bg-[#303030] disabled:opacity-40"
                >
                  {t('modelSetup.actions.next')}
                  <ArrowRight className="size-[14px]" />
                </UIButton>
              )}
              {step === 2 && (
                <div className="flex items-center gap-[8px]">
                  <UIButton
                    type="button"
                    variant="outline"
                    disabled={saving || testing || !step2Complete || !configName.trim()}
                    onClick={() => void runTest()}
                    className="h-[34px] gap-[6px] rounded-[10px] border-[#e3e7f1] bg-white px-[16px] text-[13px] text-[#464c5e] disabled:opacity-40"
                  >
                    {testing && <LoaderCircle className="size-[14px] animate-spin" />}
                    {testing ? t('modelSetup.actions.testing') : t('modelsPage.actions.test')}
                  </UIButton>
                  {!requireVerified && (
                    <UIButton
                      type="button"
                      disabled={saving || testing || !step2Complete || !configName.trim()}
                      onClick={() => void saveDraft()}
                      className="h-[34px] gap-[6px] rounded-[10px] bg-[#18181a] px-[20px] text-[13px] text-white hover:bg-[#303030] disabled:opacity-40"
                    >
                      {saving && <LoaderCircle className="size-[14px] animate-spin" />}
                      {saving ? t('modelSetup.actions.saving') : t('common.action.save')}
                    </UIButton>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function StepHeader({
  step,
  selectedChannel,
  t,
}: {
  step: Step;
  selectedChannel: ChannelPreset | null;
  t: ReturnType<typeof useAppIntl>['t'];
}) {
  if (step === 1) {
    return (
      <div>
        <h2 className="text-[18px] font-semibold text-[#18181a]">{t('modelSetup.steps.select')}</h2>
        <p className="mt-[4px] text-[13px] text-[#858b9c]">{t('modelSetup.step.selectDescription')}</p>
      </div>
    );
  }
  const title = selectedChannel?.category === 'vendor'
    ? t('modelSetup.step.vendorTitle', { name: selectedChannel.name })
    : selectedChannel?.category === 'custom'
      ? t('modelSetup.step.customTitle')
      : t('modelSetup.step.subscriptionTitle');
  const desc = selectedChannel?.category === 'vendor'
    ? t('modelSetup.step.vendorDescription')
    : selectedChannel?.category === 'custom'
      ? t('modelSetup.step.customDescription')
      : t('modelSetup.step.subscriptionDescription');
  return (
    <div>
      <h2 className="text-[18px] font-semibold text-[#18181a]">{title}</h2>
      <p className="mt-[4px] text-[13px] text-[#858b9c]">{desc}</p>
    </div>
  );
}

function ChannelRow({
  preset,
  label,
  description,
  selected,
  onSelect,
}: {
  preset: ChannelPreset;
  label: string;
  description: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      role="option"
      aria-selected={selected}
      aria-label={label}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') onSelect();
      }}
      className={`flex cursor-pointer items-center gap-[12px] border-b border-[#f0f1f4] px-[14px] py-[11px] last:border-b-0 ${selected ? 'bg-[#f6f9ff]' : ''}`}
    >
      <div
        className="grid size-[32px] shrink-0 place-items-center rounded-[9px] text-[13px] font-bold"
        style={{ background: preset.badgeColor.background, color: preset.badgeColor.text }}
      >
        {channelIcon(preset)}
      </div>
      <div className="min-w-0 flex-1">
        <p className={`text-[13px] font-semibold ${selected ? 'text-[#1a71ff]' : 'text-[#18181a]'}`}>{label}</p>
        <p className="mt-[1px] truncate text-[11.5px] text-[#858b9c]">{description}</p>
      </div>
      {selected ? (
        <div className="grid size-[16px] shrink-0 place-items-center rounded-full bg-[#1a71ff]">
          <Check className="size-[10px] text-white" />
        </div>
      ) : (
        <ChevronRight className="size-[14px] shrink-0 text-[#c0c6d4]" />
      )}
    </div>
  );
}

function SidebarConnector() {
  return <div className="ml-[19px] h-[14px] w-[2px] bg-[#e3e7f1]" />;
}

function SidebarStep({
  index,
  label,
  current,
  summary,
  onJump,
}: {
  index: Step;
  label: string;
  current: Step;
  summary?: string;
  onJump: (step: Step) => void;
}) {
  const state = index < current ? 'done' : index === current ? 'active' : 'upcoming';
  const clickable = state === 'done';
  return (
    <button
      type="button"
      disabled={!clickable}
      onClick={() => clickable && onJump(index)}
      className={`flex items-start gap-[10px] rounded-[10px] p-[10px] text-left ${
        state === 'active' ? 'bg-white shadow-[0_1px_3px_rgba(20,20,30,0.06)] border border-[#eceef1]' : ''
      } ${clickable ? 'cursor-pointer' : 'cursor-default'}`}
    >
      <span
        className={`mt-[1px] grid size-[20px] shrink-0 place-items-center rounded-full text-[10.5px] font-bold ${
          state === 'upcoming'
            ? 'border border-[#e3e7f1] text-[#c0c6d4]'
            : 'bg-[#1a71ff] text-white'
        }`}
      >
        {state === 'done' ? <Check className="size-[10px]" /> : index}
      </span>
      <span>
        <p className={`text-[12.5px] font-semibold ${state === 'upcoming' ? 'text-[#c0c6d4]' : state === 'active' ? 'text-[#18181a]' : 'text-[#464c5e]'}`}>
          {label}
        </p>
        {summary && <p className="mt-[2px] text-[11px] text-[#858b9c]">{summary}</p>}
      </span>
    </button>
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
