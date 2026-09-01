import { SaveOutlined } from '../icons';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button as UIButton, Card, CardContent, CardHeader, CardTitle, Input, Switch, Textarea, notify } from '@/components/ui';
import { api } from '../api/client';
import { createTenantClient } from '../api/tenant-client';
import { useTenantSession } from '../contexts/TenantSessionContext';
import type { EnterpriseAuthUser } from '../auth';
import AccountApiKeyDialog from '../components/AccountApiKeyDialog';
import { apiErrorMessage } from '../lib/apiErrorMessages';
import { copyTextToClipboard } from '../lib/clipboard';
import { createAppTranslator, getStoredLocale, useAppIntl } from '../i18n';
import { RawContent, RawIdentifier } from '../i18n/RawContent';
import type { NetworkSettingsRead, UIConfigRead } from '../types';
import { BrainCircuit, Copy, KeyRound, Network, RotateCcw, ShieldCheck } from 'lucide-react';

type RuntimeSettingsUIConfigRead = UIConfigRead & {
  sandbox_status: NonNullable<UIConfigRead['sandbox_status']>;
};

type RuntimeSettingsTranslator = ReturnType<typeof createAppTranslator>['t'];
type RuntimeTenantContext = NonNullable<ReturnType<typeof useTenantSession>>;

/** Prevent an old tenant generation from publishing state or user-facing errors. */
function isCurrentTenantGeneration(
  context: RuntimeTenantContext | null,
  generation: number,
): context is RuntimeTenantContext {
  return Boolean(context && !context.signal.aborted && context.isCurrentGeneration(generation));
}

/** Maps the backend's finite sandbox status vocabulary to localized product labels. */
function sandboxStatusLabel(status: string, t: RuntimeSettingsTranslator): string {
  switch (status) {
    case 'ready':
      return t('runtimeSettings.sandbox.status.ready');
    case 'degraded':
      return t('runtimeSettings.sandbox.status.degraded');
    case 'disabled':
      return t('runtimeSettings.sandbox.status.disabled');
    default:
      return t('runtimeSettings.sandbox.status.unavailable');
  }
}

/** Maps a known sandbox diagnostic code to localized remediation prose; unknown codes fail closed. */
function sandboxRemediationMessage(
  code: string | null | undefined,
  t: RuntimeSettingsTranslator,
): string | null {
  switch (code) {
    case 'SANDBOX_UNAVAILABLE':
      return t('runtimeSettings.sandbox.remediation.runtimeUnavailable');
    case 'SANDBOX_ROOT_USER':
      return t('runtimeSettings.sandbox.remediation.rootUser');
    case 'SANDBOX_USERNS_DISABLED':
      return t('runtimeSettings.sandbox.remediation.userNamespacesDisabled');
    case 'SANDBOX_WINDOWS_SETUP_REQUIRED':
      return t('runtimeSettings.sandbox.remediation.windowsSetupRequired');
    case 'SANDBOX_UNSANDBOXED_FALLBACK':
      return t('runtimeSettings.sandbox.remediation.unsandboxedFallback');
    default:
      return null;
  }
}

/** Maps a known setup code to localized instructions while leaving its command as raw content. */
function sandboxSetupMessage(
  code: string | null | undefined,
  t: RuntimeSettingsTranslator,
): string | null {
  if (code === 'SANDBOX_WINDOWS_SETUP_REQUIRED') {
    return t('runtimeSettings.sandbox.setup.windowsRequired');
  }
  return null;
}

type UiConfigForm = {
  show_thinking_trace: boolean;
  show_skill_trace: boolean;
  show_tool_trace: boolean;
  reflection_max_rounds: string;
  agent_loop_max_actions: string;
  context_token_budget: string;
  context_compaction_trigger_ratio: string;
  context_recent_round_limit: string;
  context_long_summary_token_budget: string;
  context_medium_summary_token_budget: string;
  context_allowed_roles: Array<'user' | 'assistant'>;
  context_long_summary_prefix: string;
  context_medium_summary_prefix: string;
  sandbox_enabled: boolean;
  harness_storage_path: string;
  sandbox_network_mode: 'all' | 'allowlist' | 'deny';
  sandbox_allowed_domains: string;
};

const DEFAULT_UI_CONFIG: UiConfigForm = {
  show_thinking_trace: true,
  show_skill_trace: true,
  show_tool_trace: true,
  reflection_max_rounds: '1',
  agent_loop_max_actions: '32',
  context_token_budget: '32000',
  context_compaction_trigger_ratio: '0.70',
  context_recent_round_limit: '6',
  context_long_summary_token_budget: '4000',
  context_medium_summary_token_budget: '4000',
  context_allowed_roles: ['user', 'assistant'],
  context_long_summary_prefix: '历史的信息可以被总结为：',
  context_medium_summary_prefix: '近期的历史信息总结为：',
  sandbox_enabled: false,
  harness_storage_path: '',
  sandbox_network_mode: 'all',
  sandbox_allowed_domains: '',
};

export type NetworkSettingsForm = {
  mode: 'local' | 'lan' | 'public';
  port: string;
  public_url: string;
};

const DEFAULT_NETWORK_SETTINGS: NetworkSettingsForm = {
  mode: 'local',
  port: '5173',
  public_url: '',
};

function formatDateOnly(value: string): string {
  const normalized = /(?:z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  return new Intl.DateTimeFormat(getStoredLocale(), {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** 为运行设置页的导出校验与辅助函数提供稳定翻译器。 */
function currentRuntimeSettingsTranslator() {
  return createAppTranslator(getStoredLocale());
}

/** 将错误映射到稳定语义文案；未知错误不展示原始异常正文。 */
function runtimeSettingsErrorMessage(
  error: unknown,
  fallbackId:
    | 'runtimeSettings.error.uiLoad'
    | 'runtimeSettings.error.networkLoad'
    | 'runtimeSettings.toast.saveFailed'
    | 'runtimeSettings.toast.networkSaveFailed'
    | 'runtimeSettings.toast.copyFailed',
): string {
  const { t } = currentRuntimeSettingsTranslator();
  const message = apiErrorMessage(error, fallbackId, { t });
  return message === t('common.error.generic') ? t(fallbackId) : message;
}

/** Renders tenant runtime controls, including the Harness-only workspace setting and effective root. */
export default function RuntimeSettingsPage({ currentUser }: { currentUser: EnterpriseAuthUser }) {
  const { t } = useAppIntl();
  const tenantContext = useTenantSession();
  const tenantApi = useMemo(() => createTenantClient(tenantContext), [tenantContext]);
  const [form, setForm] = useState<UiConfigForm>(DEFAULT_UI_CONFIG);
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState('');
  const [sandboxSetup, setSandboxSetup] = useState<Pick<RuntimeSettingsUIConfigRead, 'sandbox_setup_code' | 'sandbox_setup_params'>>({});
  const [effectiveStoragePath, setEffectiveStoragePath] = useState('');
  const [apiKeyOpen, setApiKeyOpen] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [networkSettings, setNetworkSettings] = useState<NetworkSettingsRead | null>(null);
  const [networkForm, setNetworkForm] = useState<NetworkSettingsForm>(DEFAULT_NETWORK_SETTINGS);
  const [networkLoading, setNetworkLoading] = useState(false);
  const [sandboxStatus, setSandboxStatus] = useState<Pick<RuntimeSettingsUIConfigRead, 'sandbox_status' | 'sandbox_status_code' | 'sandbox_status_params' | 'sandbox_remediation_code' | 'sandbox_remediation_params'>>({ sandbox_status: 'unavailable' });
  const update = (patch: Partial<UiConfigForm>) => setForm((prev) => ({ ...prev, ...patch }));

  useEffect(() => {
    const context = tenantContext;
    if (!context) return;
    const generation = context.generation;
    tenantApi.get<RuntimeSettingsUIConfigRead>('/api/enterprise/ui-config')
      .then((row) => {
        if (!isCurrentTenantGeneration(context, generation)) return;
        setForm({
          show_thinking_trace: row.show_thinking_trace,
          show_skill_trace: row.show_skill_trace,
          show_tool_trace: row.show_tool_trace,
          reflection_max_rounds: String(row.reflection_max_rounds),
          agent_loop_max_actions: String(row.agent_loop_max_actions),
          context_token_budget: String(row.context_token_budget),
          context_compaction_trigger_ratio: String(row.context_compaction_trigger_ratio),
          context_recent_round_limit: String(row.context_recent_round_limit),
          context_long_summary_token_budget: String(row.context_long_summary_token_budget),
          context_medium_summary_token_budget: String(row.context_medium_summary_token_budget),
          context_allowed_roles: row.context_allowed_roles,
          context_long_summary_prefix: row.context_long_summary_prefix,
          context_medium_summary_prefix: row.context_medium_summary_prefix,
          sandbox_enabled: row.sandbox_enabled,
          harness_storage_path: row.harness_storage_path || '',
          sandbox_network_mode: row.sandbox_network_mode || 'all',
          sandbox_allowed_domains: (row.sandbox_allowed_domains || []).join('\n'),
        });
        setUpdatedAt(row.updated_at);
        setEffectiveStoragePath(row.effective_harness_storage_path || '');
        setSandboxSetup({ sandbox_setup_code: row.sandbox_setup_code, sandbox_setup_params: row.sandbox_setup_params });
        setSandboxStatus({
          sandbox_status: row.sandbox_status,
          sandbox_status_code: row.sandbox_status_code,
          sandbox_status_params: row.sandbox_status_params,
          sandbox_remediation_code: row.sandbox_remediation_code,
          sandbox_remediation_params: row.sandbox_remediation_params,
        });
      })
      .catch(() => {
        if (!isCurrentTenantGeneration(context, generation)) return;
        notify.error(t('runtimeSettings.error.uiLoad'));
      });
  }, [t, tenantApi, tenantContext]);

  useEffect(() => {
    const context = tenantContext;
    if (!context) return;
    const generation = context.generation;
    tenantApi.get<NetworkSettingsRead>('/api/enterprise/network-settings')
      .then((row) => {
        if (!isCurrentTenantGeneration(context, generation)) return;
        setNetworkSettings(row);
        setNetworkForm({ mode: row.mode, port: String(row.port), public_url: row.public_url || '' });
      })
      .catch(() => {
        if (!isCurrentTenantGeneration(context, generation)) return;
        notify.error(t('runtimeSettings.error.networkLoad'));
      });
  }, [t, tenantApi, tenantContext]);

  async function save() {
    /** Saves runtime controls while preserving the compatible Harness workspace API field. */

    const reflectionMaxRounds = Number(form.reflection_max_rounds);
    const agentLoopMaxActions = Number(form.agent_loop_max_actions);
    if (Number.isNaN(reflectionMaxRounds) || Number.isNaN(agentLoopMaxActions)) {
      notify.error(t('runtimeSettings.validation.agentLoopNumeric'));
      return;
    }
    const contextError = validateContextSettings(form);
    if (contextError) {
      notify.error(contextError);
      return;
    }
    const context = tenantContext;
    if (!context) return;
    const generation = context.generation;
    setLoading(true);
    try {
      const row = await tenantApi.put<RuntimeSettingsUIConfigRead>('/api/enterprise/ui-config', {
        show_thinking_trace: form.show_thinking_trace,
        show_skill_trace: form.show_skill_trace,
        show_tool_trace: form.show_tool_trace,
        reflection_max_rounds: reflectionMaxRounds,
        agent_loop_max_actions: agentLoopMaxActions,
        context_token_budget: Number(form.context_token_budget),
        context_compaction_trigger_ratio: Number(form.context_compaction_trigger_ratio),
        context_recent_round_limit: Number(form.context_recent_round_limit),
        context_long_summary_token_budget: Number(form.context_long_summary_token_budget),
        context_medium_summary_token_budget: Number(form.context_medium_summary_token_budget),
        context_allowed_roles: form.context_allowed_roles,
        context_long_summary_prefix: form.context_long_summary_prefix.trim(),
        context_medium_summary_prefix: form.context_medium_summary_prefix.trim(),
        sandbox_enabled: form.sandbox_enabled,
        harness_storage_path: form.harness_storage_path.trim(),
        sandbox_network_mode: form.sandbox_network_mode,
        sandbox_allowed_domains: form.sandbox_allowed_domains.split(/[\n,]/).map((item) => item.trim()).filter(Boolean),
      });
      if (!isCurrentTenantGeneration(context, generation)) return;
      setUpdatedAt(row.updated_at);
      setEffectiveStoragePath(row.effective_harness_storage_path || '');
      setSandboxSetup({ sandbox_setup_code: row.sandbox_setup_code, sandbox_setup_params: row.sandbox_setup_params });
      setSandboxStatus({
        sandbox_status: row.sandbox_status,
        sandbox_status_code: row.sandbox_status_code,
        sandbox_status_params: row.sandbox_status_params,
        sandbox_remediation_code: row.sandbox_remediation_code,
        sandbox_remediation_params: row.sandbox_remediation_params,
      });
      if (row.restart_scheduled) {
        setRestarting(true);
        notify.success(t('runtimeSettings.toast.restartScheduled'));
        await waitForApplicationRestart();
        if (!isCurrentTenantGeneration(context, generation)) return;
        window.location.reload();
        return;
      }
      notify.success(t('runtimeSettings.toast.saved'));
    } catch (error) {
      if (!isCurrentTenantGeneration(context, generation)) return;
      notify.error(runtimeSettingsErrorMessage(error, 'runtimeSettings.toast.saveFailed'));
    } finally {
      if (isCurrentTenantGeneration(context, generation)) setLoading(false);
    }
  }

  async function saveNetworkSettings() {
    const validationError = validateNetworkSettings(networkForm);
    if (validationError) {
      notify.error(validationError);
      return;
    }
    const context = tenantContext;
    if (!context) return;
    const generation = context.generation;
    setNetworkLoading(true);
    try {
      const row = await tenantApi.put<NetworkSettingsRead>('/api/enterprise/network-settings', {
        mode: networkForm.mode,
        port: Number(networkForm.port),
        public_url: networkForm.public_url.trim(),
      });
      if (!isCurrentTenantGeneration(context, generation)) return;
      setNetworkSettings(row);
      setNetworkForm({ mode: row.mode, port: String(row.port), public_url: row.public_url || '' });
      notify.success(
        row.restart_required
          ? t('runtimeSettings.toast.networkSavedRestartRequired')
          : t('runtimeSettings.toast.networkSaved'),
      );
    } catch (error) {
      if (!isCurrentTenantGeneration(context, generation)) return;
      notify.error(runtimeSettingsErrorMessage(error, 'runtimeSettings.toast.networkSaveFailed'));
    } finally {
      if (isCurrentTenantGeneration(context, generation)) setNetworkLoading(false);
    }
  }

  const localizedSandboxRemediation = sandboxRemediationMessage(
    sandboxStatus.sandbox_remediation_code,
    t,
  );
  const localizedSandboxSetup = sandboxSetupMessage(sandboxSetup.sandbox_setup_code, t);
  const rawSandboxBackend = typeof sandboxStatus.sandbox_status_params?.backend === 'string'
    ? sandboxStatus.sandbox_status_params.backend
    : null;
  const rawSandboxSetupCommand = typeof sandboxSetup.sandbox_setup_params?.command === 'string'
    ? sandboxSetup.sandbox_setup_params.command
    : null;

  return (
    <>
      <div className="page-title">
        <div><h3>{t('runtimeSettings.heading')}</h3><p className="text-[12px] text-muted-foreground">{t('runtimeSettings.description')}</p></div>
        <UIButton disabled={loading || restarting} onClick={() => void save()}>
          {restarting ? <RotateCcw className="size-[15px] animate-spin" /> : <SaveOutlined />}
          {restarting ? t('runtimeSettings.actions.waitRestart') : t('runtimeSettings.save')}
        </UIButton>
      </div>
      <Card className="editor-card settings-card">
        <CardHeader><CardTitle>{t('runtimeSettings.section.agentLoop')}</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-[16px]">
          <SwitchRow label={t('runtimeSettings.field.showThinkingTrace')} checked={form.show_thinking_trace} onChange={(next) => update({ show_thinking_trace: next })} />
          <SwitchRow label={t('runtimeSettings.field.showSkillTrace')} checked={form.show_skill_trace} onChange={(next) => update({ show_skill_trace: next })} />
          <SwitchRow label={t('runtimeSettings.field.showToolTrace')} checked={form.show_tool_trace} onChange={(next) => update({ show_tool_trace: next })} />
          <LabeledField label={t('runtimeSettings.field.reflectionMaxRounds')} hint={t('runtimeSettings.hint.reflectionMaxRounds')}><Input type="number" min={0} max={5} step={1} value={form.reflection_max_rounds} onChange={(e) => update({ reflection_max_rounds: e.target.value })} /></LabeledField>
          <LabeledField label={t('runtimeSettings.field.agentLoopMaxActions')} hint={t('runtimeSettings.hint.agentLoopMaxActions')}><Input type="number" min={1} max={100} step={1} value={form.agent_loop_max_actions} onChange={(e) => update({ agent_loop_max_actions: e.target.value })} /></LabeledField>
        </CardContent>
      </Card>
      <Card className="editor-card settings-card overflow-hidden">
        <CardHeader className="border-b border-[#edf0f5] bg-[linear-gradient(110deg,#f8fbff_0%,#ffffff_52%,#f6f9ff_100%)]">
          <div className="flex flex-wrap items-center justify-between gap-[12px]">
            <div>
              <CardTitle className="flex items-center gap-[8px]">
                <span className="flex size-[28px] items-center justify-center rounded-[9px] bg-[#eaf2ff] text-[#1a71ff]">
                  <BrainCircuit className="size-[15px]" />
                </span>
                {t('runtimeSettings.section.context')}
              </CardTitle>
              <p className="mt-[7px] text-[11px] leading-[17px] text-muted-foreground">
                {t('runtimeSettings.context.description')}
              </p>
            </div>
            <UIButton
              type="button"
              variant="outline"
              className="h-[32px] gap-[6px] text-[11px]"
              onClick={() => update({
                context_token_budget: DEFAULT_UI_CONFIG.context_token_budget,
                context_compaction_trigger_ratio: DEFAULT_UI_CONFIG.context_compaction_trigger_ratio,
                context_recent_round_limit: DEFAULT_UI_CONFIG.context_recent_round_limit,
                context_long_summary_token_budget: DEFAULT_UI_CONFIG.context_long_summary_token_budget,
                context_medium_summary_token_budget: DEFAULT_UI_CONFIG.context_medium_summary_token_budget,
                context_allowed_roles: DEFAULT_UI_CONFIG.context_allowed_roles,
                context_long_summary_prefix: DEFAULT_UI_CONFIG.context_long_summary_prefix,
                context_medium_summary_prefix: DEFAULT_UI_CONFIG.context_medium_summary_prefix,
              })}
            >
              <RotateCcw className="size-[13px]" />
              {t('runtimeSettings.actions.resetContextDefaults')}
            </UIButton>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-[18px] pt-[18px]">
          <div className="rounded-[11px] border border-[#dce8fb] bg-[#f7faff] px-[13px] py-[11px] text-[11px] leading-[18px] text-[#52637d]">
            {t('runtimeSettings.context.summary')}
          </div>
          <div className="grid gap-[14px] md:grid-cols-2">
            <LabeledField label={t('runtimeSettings.field.contextTokenBudget')} hint={t('runtimeSettings.hint.contextTokenBudget')}>
              <Input type="number" min={512} max={262144} step={512} value={form.context_token_budget} onChange={(event) => update({ context_token_budget: event.target.value })} />
            </LabeledField>
            <LabeledField label={t('runtimeSettings.field.contextCompactionRatio')} hint={t('runtimeSettings.hint.contextCompactionRatio')}>
              <Input type="number" min={0.1} max={0.95} step={0.05} value={form.context_compaction_trigger_ratio} onChange={(event) => update({ context_compaction_trigger_ratio: event.target.value })} />
            </LabeledField>
            <LabeledField label={t('runtimeSettings.field.contextRecentRounds')} hint={t('runtimeSettings.hint.contextRecentRounds')}>
              <Input type="number" min={1} max={50} step={1} value={form.context_recent_round_limit} onChange={(event) => update({ context_recent_round_limit: event.target.value })} />
            </LabeledField>
            <div className="grid grid-cols-2 gap-[10px]">
              <LabeledField label={t('runtimeSettings.field.contextLongSummaryBudget')} hint={t('runtimeSettings.hint.tokenUnit')}>
                <Input type="number" min={128} max={32768} step={128} value={form.context_long_summary_token_budget} onChange={(event) => update({ context_long_summary_token_budget: event.target.value })} />
              </LabeledField>
              <LabeledField label={t('runtimeSettings.field.contextMediumSummaryBudget')} hint={t('runtimeSettings.hint.tokenUnit')}>
                <Input type="number" min={128} max={32768} step={128} value={form.context_medium_summary_token_budget} onChange={(event) => update({ context_medium_summary_token_budget: event.target.value })} />
              </LabeledField>
            </div>
          </div>
          <div className="rounded-[11px] border border-[#e6e9f0] bg-[#fbfbfc] px-[13px] py-[12px]">
            <p className="text-[12px] font-medium text-[#464c5e]">{t('runtimeSettings.context.rolesTitle')}</p>
            <p className="mt-[3px] text-[11px] leading-[16px] text-muted-foreground">{t('runtimeSettings.context.rolesHint')}</p>
            <div className="mt-[10px] grid gap-[8px] sm:grid-cols-2">
              <SwitchRow label={t('runtimeSettings.context.role.user')} checked={form.context_allowed_roles.includes('user')} onChange={(checked) => update({ context_allowed_roles: toggleContextRole(form.context_allowed_roles, 'user', checked) })} />
              <SwitchRow label={t('runtimeSettings.context.role.assistant')} checked={form.context_allowed_roles.includes('assistant')} onChange={(checked) => update({ context_allowed_roles: toggleContextRole(form.context_allowed_roles, 'assistant', checked) })} />
            </div>
          </div>
          <div className="grid gap-[14px] md:grid-cols-2">
            <LabeledField label={t('runtimeSettings.field.contextLongSummaryPrefix')} hint={t('runtimeSettings.hint.contextLongSummaryPrefix')}>
              <Textarea rows={3} maxLength={200} value={form.context_long_summary_prefix} onChange={(event) => update({ context_long_summary_prefix: event.target.value })} />
            </LabeledField>
            <LabeledField label={t('runtimeSettings.field.contextMediumSummaryPrefix')} hint={t('runtimeSettings.hint.contextMediumSummaryPrefix')}>
              <Textarea rows={3} maxLength={200} value={form.context_medium_summary_prefix} onChange={(event) => update({ context_medium_summary_prefix: event.target.value })} />
            </LabeledField>
          </div>
        </CardContent>
      </Card>
      <Card className="editor-card settings-card">
        <CardHeader><CardTitle className="flex items-center gap-[8px]"><Network className="size-[16px]" />{t('runtimeSettings.section.network')}</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-[16px]">
          {networkSettings && <NetworkEndpointDetails settings={networkSettings} />}
          <div className="grid gap-[14px] md:grid-cols-2">
            <LabeledField label={t('runtimeSettings.field.networkMode')} hint={t('runtimeSettings.hint.networkMode')}>
              <select
                className="h-[36px] rounded-md border border-input bg-background px-[10px] text-[13px]"
                value={networkForm.mode}
                onChange={(event) => setNetworkForm((current) => ({ ...current, mode: event.target.value as NetworkSettingsForm['mode'] }))}
              >
                <option value="local">{t('runtimeSettings.networkMode.local')}</option><option value="lan">{t('runtimeSettings.networkMode.lan')}</option><option value="public">{t('runtimeSettings.networkMode.public')}</option>
              </select>
            </LabeledField>
            <LabeledField label={t('runtimeSettings.field.networkPort')} hint={t('runtimeSettings.hint.networkPort')}>
              <Input type="number" min={1} max={65535} step={1} value={networkForm.port} onChange={(event) => setNetworkForm((current) => ({ ...current, port: event.target.value }))} />
            </LabeledField>
          </div>
          {networkForm.mode === 'lan' && <p className="rounded-md border border-amber-200 bg-amber-50 px-[12px] py-[10px] text-[12px] leading-[18px] text-amber-900">{t('runtimeSettings.network.lanNotice')}</p>}
          {networkForm.mode === 'public' && <>
            <LabeledField label={t('runtimeSettings.field.publicUrl')} hint={t('runtimeSettings.hint.publicUrl')}>
              <Input value={networkForm.public_url} onChange={(event) => setNetworkForm((current) => ({ ...current, public_url: event.target.value }))} placeholder={t('runtimeSettings.placeholder.publicUrl')} />
            </LabeledField>
            <p className="rounded-md border border-amber-200 bg-amber-50 px-[12px] py-[10px] text-[12px] leading-[18px] text-amber-900">{t('runtimeSettings.network.publicNotice')}</p>
          </>}
          {networkSettings?.restart_required && <p className="rounded-md border border-[#dce8fb] bg-[#f7faff] px-[12px] py-[10px] text-[12px] leading-[18px] text-[#52637d]">{t('runtimeSettings.network.pendingBaseUrl', { value: networkSettings.pending_base_url || '' })}</p>}
          <div><UIButton variant="outline" disabled={networkLoading} onClick={() => void saveNetworkSettings()}>{networkLoading ? <RotateCcw className="size-[15px] animate-spin" /> : <SaveOutlined />}{networkLoading ? t('runtimeSettings.actions.savingNetwork') : t('runtimeSettings.actions.saveNetwork')}</UIButton></div>
        </CardContent>
      </Card>
      <Card className="editor-card settings-card">
        <CardHeader><CardTitle className="flex items-center gap-[8px]"><ShieldCheck className="size-[16px]" />{t('runtimeSettings.section.sandbox')}</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-[16px]">
          <SwitchRow label={t('runtimeSettings.field.sandboxEnabled')} checked={form.sandbox_enabled} onChange={(next) => update({ sandbox_enabled: next })} hint={t('runtimeSettings.adminHint')} />
          <div className={`whitespace-pre-line rounded-md border px-[12px] py-[10px] text-[12px] leading-[18px] ${sandboxStatus.sandbox_status === 'ready' ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : sandboxStatus.sandbox_status === 'degraded' ? 'border-red-300 bg-red-50 text-red-900' : sandboxStatus.sandbox_status === 'disabled' ? 'border-slate-200 bg-slate-50 text-slate-700' : 'border-amber-200 bg-amber-50 text-amber-900'}`}>
            <div className="font-medium">{t('runtimeSettings.sandbox.statusLine', { status: sandboxStatusLabel(sandboxStatus.sandbox_status, t) })}</div>
            {rawSandboxBackend && rawSandboxBackend !== 'disabled' && <div><span>{t('runtimeSettings.sandbox.backendLabel')}</span> <RawIdentifier value={rawSandboxBackend} /></div>}
            {localizedSandboxRemediation && <div>{localizedSandboxRemediation}</div>}
          </div>
          {localizedSandboxSetup && <div className="whitespace-pre-line rounded-md border border-amber-200 bg-amber-50 px-[12px] py-[10px] text-[12px] leading-[18px] text-amber-900"><div>{localizedSandboxSetup}</div>{rawSandboxSetupCommand && <><div className="mt-[6px]">{t('runtimeSettings.sandbox.setup.commandLabel')}</div><code className="mt-[3px] block break-all"><RawContent value={rawSandboxSetupCommand} /></code></>}</div>}
          <div className="rounded-md border border-[#dce8fb] bg-[#f7faff] px-[12px] py-[10px] text-[12px] leading-[18px] text-[#52637d]">
            <div className="font-medium text-[#2f3442]">{t('runtimeSettings.sandbox.effectiveWorkspace')}</div>
            <code className="mt-[4px] block break-all text-[11px]"><RawContent value={effectiveStoragePath || '—'} /></code>
          </div>
          {!form.sandbox_enabled && <LabeledField label={t('runtimeSettings.field.harnessWorkspacePath')} hint={t('runtimeSettings.hint.harnessWorkspacePath')}><Input value={form.harness_storage_path} onChange={(e) => update({ harness_storage_path: e.target.value })} placeholder={effectiveStoragePath || t('runtimeSettings.placeholder.harnessWorkspacePath')} /></LabeledField>}
          {form.sandbox_enabled && <p className="rounded-md border border-amber-200 bg-amber-50 px-[12px] py-[10px] text-[12px] leading-[18px] text-amber-900">{t('runtimeSettings.sandbox.workspaceNotice')}</p>}
          {form.sandbox_enabled && <LabeledField label={t('runtimeSettings.field.sandboxNetworkMode')} hint={t('runtimeSettings.hint.sandboxNetworkMode')}>
            <select className="h-[36px] rounded-md border border-input bg-background px-[10px] text-[13px]" value={form.sandbox_network_mode} onChange={(e) => update({ sandbox_network_mode: e.target.value as UiConfigForm['sandbox_network_mode'] })}>
              <option value="all">{t('runtimeSettings.sandboxNetworkMode.all')}</option><option value="allowlist">{t('runtimeSettings.sandboxNetworkMode.allowlist')}</option><option value="deny">{t('runtimeSettings.sandboxNetworkMode.deny')}</option>
            </select>
          </LabeledField>}
          {form.sandbox_enabled && form.sandbox_network_mode === 'allowlist' && <LabeledField label={t('runtimeSettings.field.sandboxAllowedDomains')} hint={t('runtimeSettings.hint.sandboxAllowedDomains')}><Textarea rows={4} value={form.sandbox_allowed_domains} onChange={(e) => update({ sandbox_allowed_domains: e.target.value })} placeholder={t('runtimeSettings.placeholder.sandboxAllowedDomains')} /></LabeledField>}
          <p className="text-[11px] leading-[16px] text-muted-foreground">{t('runtimeSettings.sandbox.disabledHint')}</p>
          {updatedAt && <span className="text-[12px] text-muted-foreground">{t('runtimeSettings.updatedAt', { value: formatDateOnly(updatedAt) })}</span>}
        </CardContent>
      </Card>
      <Card className="editor-card settings-card">
        <CardHeader><CardTitle className="flex items-center gap-[8px]"><KeyRound className="size-[16px]" />{t('runtimeSettings.section.apiKey')}</CardTitle></CardHeader>
        <CardContent className="flex items-center justify-between gap-[20px]">
          <div><p className="text-[13px] font-medium text-[#2f3442]">{t('runtimeSettings.apiKey.title')}</p><p className="mt-[4px] text-[11px] leading-[17px] text-muted-foreground">{t('runtimeSettings.apiKey.description')}</p></div>
          <UIButton variant="outline" onClick={() => setApiKeyOpen(true)}><KeyRound className="size-[15px]" />{t('runtimeSettings.actions.manageApiKeys')}</UIButton>
        </CardContent>
      </Card>
      <AccountApiKeyDialog
        account={{
          id: currentUser.id,
          username: currentUser.username,
          display_name: currentUser.display_name ?? undefined,
          role: currentUser.role,
        }}
        open={apiKeyOpen}
        onClose={() => setApiKeyOpen(false)}
      />
    </>
  );
}

export function validateContextSettings(form: UiConfigForm): string | null {
  const { t } = currentRuntimeSettingsTranslator();
  const tokenBudget = Number(form.context_token_budget);
  const triggerRatio = Number(form.context_compaction_trigger_ratio);
  const recentRoundLimit = Number(form.context_recent_round_limit);
  const longSummaryBudget = Number(form.context_long_summary_token_budget);
  const mediumSummaryBudget = Number(form.context_medium_summary_token_budget);
  const integerValues = [tokenBudget, recentRoundLimit, longSummaryBudget, mediumSummaryBudget];
  if (![...integerValues, triggerRatio].every(Number.isFinite)) {
    return t('runtimeSettings.validation.contextNumeric');
  }
  if (!integerValues.every(Number.isInteger)) {
    return t('runtimeSettings.validation.contextInteger');
  }
  if (tokenBudget < 512 || tokenBudget > 262_144) {
    return t('runtimeSettings.validation.contextTokenBudgetRange');
  }
  if (triggerRatio < 0.1 || triggerRatio > 0.95) {
    return t('runtimeSettings.validation.contextRatioRange');
  }
  if (recentRoundLimit < 1 || recentRoundLimit > 50) {
    return t('runtimeSettings.validation.contextRecentRoundsRange');
  }
  if (
    longSummaryBudget < 128
    || longSummaryBudget > 32_768
    || mediumSummaryBudget < 128
    || mediumSummaryBudget > 32_768
  ) {
    return t('runtimeSettings.validation.contextSummaryBudgetRange');
  }
  if (longSummaryBudget + mediumSummaryBudget > tokenBudget) {
    return t('runtimeSettings.validation.contextSummaryBudgetTotal');
  }
  if (form.context_allowed_roles.length === 0) {
    return t('runtimeSettings.validation.contextRolesRequired');
  }
  if (!form.context_long_summary_prefix.trim() || !form.context_medium_summary_prefix.trim()) {
    return t('runtimeSettings.validation.contextPrefixRequired');
  }
  return null;
}

/** Normalizes the one current same-machine API Base URL that the settings card displays. */
export function buildApiEndpointLinks(activeBaseUrl: string): { baseUrl: string } {
  const baseUrl = activeBaseUrl.replace(/\/+$/, '');
  return { baseUrl };
}

/** Validates next-launch browser input before the backend repeats the authoritative validation. */
export function validateNetworkSettings(form: NetworkSettingsForm): string | null {
  const { t } = currentRuntimeSettingsTranslator();
  const port = Number(form.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return t('runtimeSettings.validation.networkPortRange');
  }
  if (form.mode !== 'public') return null;
  if (!form.public_url.trim()) return t('runtimeSettings.validation.publicUrlRequired');
  try {
    const parsed = new URL(form.public_url.trim());
    if (
      !['http:', 'https:'].includes(parsed.protocol)
      || !parsed.hostname
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
      || !['', '/'].includes(parsed.pathname)
    ) {
      return t('runtimeSettings.validation.publicUrlFormat');
    }
  } catch {
    return t('runtimeSettings.validation.publicUrlRequired');
  }
  return null;
}

function NetworkEndpointDetails({ settings }: { settings: NetworkSettingsRead }) {
  const { t } = currentRuntimeSettingsTranslator();
  /** Copies only a caller-safe integration value and informs the administrator of the result. */
  async function copyApiValue(value: string, label: string): Promise<void> {
    try {
      await copyTextToClipboard(value);
      notify.success(t('runtimeSettings.toast.copiedValue', { label }));
    } catch (error) {
      notify.error(runtimeSettingsErrorMessage(error, 'runtimeSettings.toast.copyFailed'));
    }
  }

  const links = buildApiEndpointLinks(settings.active_base_url);
  return <div className="flex flex-col gap-[10px] rounded-[11px] border border-[#e6e9f0] bg-[#fbfbfc] px-[13px] py-[12px]">
    <EndpointRow label={t('runtimeSettings.endpoint.baseUrl')} value={links.baseUrl} onCopy={() => void copyApiValue(links.baseUrl, t('runtimeSettings.endpoint.baseUrlLabel'))} />
  </div>;
}

function EndpointRow({ label, value, onCopy }: { label: string; value: string; onCopy: () => void }) {
  const { t } = currentRuntimeSettingsTranslator();
  /** Renders the one read-only API Base URL and its explicit copy action. */
  return <div className="flex flex-wrap items-center justify-between gap-[8px] border-b border-[#e8ebf0] pb-[10px] last:border-0 last:pb-0">
    <div className="min-w-0"><p className="text-[11px] font-medium text-[#464c5e]">{label}</p><code className="mt-[3px] block break-all text-[11px] text-[#52637d]"><RawContent value={value} /></code></div>
    <div className="flex shrink-0 gap-[6px]">
      <UIButton type="button" variant="outline" size="sm" onClick={onCopy}><Copy className="size-[13px]" />{t('runtimeSettings.actions.copy')}</UIButton>
    </div>
  </div>;
}

function toggleContextRole(
  roles: UiConfigForm['context_allowed_roles'],
  role: UiConfigForm['context_allowed_roles'][number],
  checked: boolean,
): UiConfigForm['context_allowed_roles'] {
  if (checked) return roles.includes(role) ? roles : [...roles, role];
  return roles.filter((item) => item !== role);
}

function LabeledField({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="flex flex-col gap-[6px]"><span className="text-[12px] font-medium text-[#464c5e]">{label}</span>{hint && <span className="text-[11px] leading-[16px] text-muted-foreground">{hint}</span>}{children}</label>;
}

function SwitchRow({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (next: boolean) => void }) {
  return <label className="flex items-center justify-between gap-[16px]"><span><span className="block text-[12px] font-medium text-[#464c5e]">{label}</span>{hint && <span className="mt-[3px] block text-[11px] leading-[16px] text-muted-foreground">{hint}</span>}</span><Switch checked={checked} onCheckedChange={onChange} /></label>;
}

async function waitForApplicationRestart(): Promise<void> {
  const { t } = currentRuntimeSettingsTranslator();
  await new Promise((resolve) => window.setTimeout(resolve, 1800));
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await api.get('/api/health');
      return;
    } catch {
      await new Promise((resolve) => window.setTimeout(resolve, 1000));
    }
  }
  throw new Error(t('runtimeSettings.validation.restartTimeout'));
}
