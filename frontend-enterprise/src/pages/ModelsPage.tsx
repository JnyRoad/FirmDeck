import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, FlaskConical, LoaderCircle, Trash2 } from 'lucide-react';

import { ApiError } from '../api/client';
import { createTenantClient } from '../api/tenant-client';
import { useTenantSession } from '../contexts/TenantSessionContext';
import type { EnterpriseAuthUser } from '../auth';
import AppHeader from '@/components/AppHeader';
import { DataTable, type DataTableColumn } from '@/components/DataTable';
import { Paginator } from '@/components/Paginator';
import { StatCard } from '@/components/StatCard';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui';
import { Button as UIButton } from '@/components/ui/button';
import { notify } from '@/components/ui/app-toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { cn } from '@/lib/utils';
import { MENU_CONTENT_CLASS, MENU_ITEM_CLASS, MENU_ITEM_DANGER_CLASS } from '@/lib/enterprise-ui';
import { apiErrorCode, apiErrorMessage } from '@/lib/apiErrorMessages';
import IconAdd from '../assets/icons/add.svg?react';
import IconClear from '../assets/icons/field-clear.svg?react';
import IconEdit from '../assets/icons/edit.svg?react';
import IconModels from '../assets/icons/sys-models.svg?react';
import IconMore from '../assets/icons/more.svg?react';
import IconRefresh from '../assets/icons/refresh.svg?react';
import IconSearch from '../assets/icons/search.svg?react';
import { StatusBadge } from './scheduled-tasks/StatusBadge';
import { useClientPagination } from '../hooks/useClientPagination';
import type { CodexSubscriptionAccountRead, ModelAuthMode, ModelConfigRead } from '../types';
import { OPEN_MODEL_CREATE_EVENT } from '@/components/QuickStartGuide';
import { createAppTranslator, useAppIntl } from '@/i18n';
import { LOCALE_STORAGE_KEY, normalizeAppLocale } from '@/i18n/locales';
import ModelSetupWizard from './models/ModelSetupWizard';
import { ModelPayloadValidationError, type ApiKeyProtocol } from './models/channelPresets';
import { useCodexSubscriptionAccount } from './models/useCodexSubscriptionAccount';

const MODEL_PAGE_SIZE = 8;
const MODEL_TEST_UI_TIMEOUT_MS = 100_000;
const STABLE_MODEL_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]+$/;
type ModelsTenantContext = NonNullable<ReturnType<typeof useTenantSession>>;

/** Prevent stale tenant generations from publishing model state or toasts. */
function isCurrentTenantGeneration(
  context: ModelsTenantContext | null,
  generation: number,
): context is ModelsTenantContext {
  return Boolean(context && !context.signal.aborted && context.isCurrentGeneration(generation));
}

export type ModelProviderErrorDetail = {
  code: string;
  message: string;
  upstream_status?: number | null;
  provider_code?: string | null;
  provider_message?: string | null;
  upstream_body?: string | null;
  request_id?: string | null;
  retryable?: boolean;
};

type ModelTestResponse = {
  success: boolean;
  message: string;
  output?: string;
  activated: boolean;
  error?: ModelProviderErrorDetail | null;
};

// 调用/验证模型时可能出现的错误码的用户提示；配置校验类错误码已在 apiErrorMessages.ts
// 的 API_ERROR_MESSAGES 里有文案，不在此重复。
/** 读取当前 locale 的组件外 translator；存储缺失时回退到兼容默认值。 */
function currentModelsTranslator() {
  let storedLocale: string | null = null;
  try {
    storedLocale = typeof window === 'undefined' ? null : window.localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    storedLocale = null;
  }
  return createAppTranslator(normalizeAppLocale(storedLocale));
}

/** 将值收窄为稳定模型错误码，避免把原始 provider 文本误当作 catalog key。 */
function stableModelErrorCode(value: unknown): string | null {
  return typeof value === 'string' && STABLE_MODEL_ERROR_CODE_PATTERN.test(value) ? value : null;
}

/** 解析 ApiError.body 的首段 JSON；诊断附加文本存在时只读取第一段结构化载荷。 */
function parseApiErrorBody(body: string): { detail?: unknown } | null {
  try {
    return JSON.parse(body) as { detail?: unknown };
  } catch {
    const [firstLine] = body.split('\n');
    if (!firstLine) return null;
    try {
      return JSON.parse(firstLine) as { detail?: unknown };
    } catch {
      return null;
    }
  }
}

/** 将订阅状态投影为稳定 UI 文案，不直接展示后端返回的自然语言 message。 */
export function subscriptionAccountMessage(
  account: CodexSubscriptionAccountRead | null | undefined,
): string {
  const { t } = currentModelsTranslator();
  switch (account?.status) {
    case 'connected':
      return t('modelsPage.subscription.connected');
    case 'pending':
      return t('modelsPage.subscription.pending');
    case 'requires_login':
      return t('modelsPage.subscription.requiresLogin');
    default:
      return t('modelsPage.subscription.unavailable');
  }
}

export function modelAuthModeLabel(authMode: ModelAuthMode | string | null | undefined): string {
  const { t } = currentModelsTranslator();
  return authMode === 'chatgpt_subscription'
    ? t('modelsPage.authMode.subscription')
    : t('modelsPage.authMode.apiKey');
}

export function modelProviderErrorMessage(
  error: ModelProviderErrorDetail | null | undefined,
  fallback: string,
): string {
  const { t } = currentModelsTranslator();
  if (!error) return fallback;
  if (error.code === 'MODEL_UPSTREAM_ERROR') return t('modelsPage.error.upstream');
  if (error.code === 'MODEL_SUBSCRIPTION_AUTH_REQUIRED') {
    return t('modelsPage.error.subscriptionAuthRequired');
  }
  const message = apiErrorMessage(error.code, fallback, { t });
  return message === t('common.error.generic') ? t('modelsPage.error.genericProvider') : message;
}

// 把上游诊断字段（HTTP 状态、上游错误码/消息、原始响应体、Request ID）整理成一段纯文本，
// 只用于「查看详情」这类默认折叠的交互，不进入主提示文案。
export function modelProviderDiagnosticText(
  error: ModelProviderErrorDetail | null | undefined,
): string | null {
  if (!error) return null;
  const { t } = currentModelsTranslator();
  const parts: string[] = [];
  if (typeof error.upstream_status === 'number') {
    parts.push(t('modelsPage.diagnostic.httpStatus', { value: error.upstream_status }));
  }
  if (error.provider_code) parts.push(t('modelsPage.diagnostic.providerCode', { value: error.provider_code }));
  if (error.provider_message) {
    parts.push(t('modelsPage.diagnostic.providerMessage', { value: error.provider_message }));
  }
  if (error.upstream_body) parts.push(t('modelsPage.diagnostic.upstreamBody', { value: error.upstream_body }));
  if (error.request_id) parts.push(t('modelsPage.diagnostic.requestId', { value: error.request_id }));
  return parts.length ? parts.join('\n') : null;
}

// 折叠的诊断详情展示：默认只显示友好文案，点击「查看详情」才展开原始诊断文本；
// 诊断文本按纯文本渲染（React children 天然转义），不使用 dangerouslySetInnerHTML。
function ModelErrorToast({ message, diagnostic }: { message: string; diagnostic: string }) {
  const { t } = currentModelsTranslator();
  const [expanded, setExpanded] = useState(false);
  return (
    <span className="flex flex-col items-start gap-[6px]">
      <span>{message}</span>
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="text-[12px] underline underline-offset-2 opacity-80 hover:opacity-100"
      >
        {expanded ? t('modelsPage.detail.hide') : t('modelsPage.detail.show')}
      </button>
      {expanded && (
        <pre className="max-h-[160px] w-full max-w-[420px] overflow-auto whitespace-pre-wrap break-all rounded-[8px] bg-black/5 p-[8px] text-[11px] text-[#464c5e]">
          {diagnostic}
        </pre>
      )}
    </span>
  );
}

// 组装模型上游错误的 toast 内容：有可展示的诊断详情就附加折叠区域，否则只返回友好文案。
export function toastContentForProviderError(
  error: ModelProviderErrorDetail | null | undefined,
  fallback: string,
): ReactNode {
  const message = modelProviderErrorMessage(error, fallback);
  const diagnostic = modelProviderDiagnosticText(error);
  return diagnostic ? <ModelErrorToast message={message} diagnostic={diagnostic} /> : message;
}

export function providerErrorFromApiError(error: ApiError): ModelProviderErrorDetail | null {
  const payload = parseApiErrorBody(error.body);
  if (!payload?.detail || typeof payload.detail !== 'object' || Array.isArray(payload.detail)) return null;
  const detail = payload.detail as Partial<ModelProviderErrorDetail>;
  if (typeof detail.code !== 'string' || typeof detail.message !== 'string') return null;
  return detail as ModelProviderErrorDetail;
}

export function modelActionError(error: unknown, fallback: string): string {
  const { t } = currentModelsTranslator();
  if (error instanceof ModelPayloadValidationError) {
    return error.code === 'MODEL_CLIENT_EXTRA_BODY_INVALID'
      ? t('modelSetup.validation.extraBodyInvalid')
      : t('modelSetup.validation.numericFields');
  }
  if (error instanceof ApiError) {
    const providerError = providerErrorFromApiError(error);
    if (providerError) return modelProviderErrorMessage(providerError, fallback);
    const knownMessage = apiErrorMessage(error, fallback);
    if (knownMessage !== t('common.error.generic')) return knownMessage;
    const code = stableModelErrorCode(apiErrorCode(error));
    if (code) return t('modelsPage.error.withCode', { code });
    return fallback;
  }
  if (error instanceof Error && stableModelErrorCode(error.message)) {
    return t('modelsPage.error.withCode', { code: error.message });
  }
  return fallback;
}
const MODEL_CONFIGS_UPDATED_EVENT = 'ultrarag-enterprise-model-configs-updated';

/** 展示当前租户的模型配置，并复用统一向导与订阅账号状态。 */
export default function ModelsPage({
  currentUser,
  onLogout,
}: {
  currentUser?: EnterpriseAuthUser;
  onLogout?: () => void;
} = {}) {
  const { t } = useAppIntl();
  const tenantContext = useTenantSession();
  const tenantApi = useMemo(() => createTenantClient(tenantContext), [tenantContext]);
  const [rows, setRows] = useState<ModelConfigRead[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [editingModel, setEditingModel] = useState<ModelConfigRead | null>(null);
  const [editingModelGeneration, setEditingModelGeneration] = useState<number | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ModelConfigRead | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [subscriptionLogoutConfirmOpen, setSubscriptionLogoutConfirmOpen] = useState(false);
  const [subscriptionExplicitTenantId, setSubscriptionExplicitTenantId] = useState<string | null>(null);
  const [subscriptionExplicitGeneration, setSubscriptionExplicitGeneration] = useState<number | null>(null);
  const previousTenantGenerationRef = useRef<number | null>(tenantContext?.generation ?? null);
  const loadingRequestOwnerRef = useRef(0);
  const testingModelIdsRef = useRef(new Set<string>());
  const testingModelRequestOwnersRef = useRef(new Map<string, number>());
  const testingRequestOwnerRef = useRef(0);
  const [testingModelIds, setTestingModelIds] = useState<Set<string>>(new Set());
  const [availableProtocols, setAvailableProtocols] = useState<ApiKeyProtocol[]>(['openai_chat_completions']);
  const {
    account: subscriptionAccount,
    loading: subscriptionLoading,
    startLogin: startSubscriptionLogin,
    cancelLogin: cancelSubscriptionLogin,
    logout: logoutSubscription,
  } = useCodexSubscriptionAccount({
    enabled: Boolean(
      wizardOpen
      && tenantContext?.tenantId === subscriptionExplicitTenantId
      && tenantContext.generation === subscriptionExplicitGeneration,
    ) || Boolean(
      editingModel?.auth_mode === 'chatgpt_subscription'
      && tenantContext?.generation === editingModelGeneration,
    ),
  });

  /** 仅在订阅渠道被选中时查询当前租户账户，离开渠道后立即停用。 */
  function setSubscriptionChannelSelected(selected: boolean) {
    setSubscriptionExplicitTenantId(selected && tenantContext ? tenantContext.tenantId : null);
    setSubscriptionExplicitGeneration(selected && tenantContext ? tenantContext.generation : null);
  }

  /** 打开模型编辑并绑定当前租户代次；无返回值、不发请求，仅更新本地编辑状态。 */
  function openModelEditor(row: ModelConfigRead) {
    setEditingModel(row);
    setEditingModelGeneration(tenantContext?.generation ?? null);
  }

  /** 清理编辑目标及其租户代次资格；无返回值、不发请求，仅修改本地 React 状态。 */
  function clearModelEditor() {
    setEditingModel(null);
    setEditingModelGeneration(null);
  }

  const load = (showLoading = true) => {
    const context = tenantContext;
    if (!context) return Promise.resolve();
    const generation = context.generation;
    const requestOwner = showLoading ? ++loadingRequestOwnerRef.current : null;
    if (showLoading) setLoading(true);
    return tenantApi
      .get<ModelConfigRead[]>('/api/enterprise/model-configs')
      .then((items) => {
        if (!isCurrentTenantGeneration(context, generation)) return;
        setRows(items);
        window.dispatchEvent(new CustomEvent(MODEL_CONFIGS_UPDATED_EVENT, { detail: { models: items } }));
      })
      .catch((error) => {
        if (!isCurrentTenantGeneration(context, generation)) return;
        notify.error(modelActionError(error, t('modelsPage.toast.loadFailed')));
      })
      .finally(() => {
        if (showLoading && requestOwner === loadingRequestOwnerRef.current) setLoading(false);
      });
  };

  useEffect(() => {
    const nextGeneration = tenantContext?.generation ?? null;
    const previousGeneration = previousTenantGenerationRef.current;
    previousTenantGenerationRef.current = nextGeneration;
    if (previousGeneration === null || previousGeneration === nextGeneration) {
      return;
    }
    // Tenant generation is a hard UI isolation boundary: no modal target or
    // explicit subscription check may survive into the next tenant context.
    setWizardOpen(false);
    clearModelEditor();
    setDeleteTarget(null);
    setDeleting(false);
    setSubscriptionLogoutConfirmOpen(false);
    setSubscriptionExplicitTenantId(null);
    setSubscriptionExplicitGeneration(null);
    loadingRequestOwnerRef.current += 1;
    testingModelRequestOwnersRef.current.clear();
    testingModelIdsRef.current.clear();
    setLoading(false);
    setTestingModelIds(new Set());
  }, [tenantContext?.generation]);

  useEffect(() => {
    const context = tenantContext;
    if (!context) return;
    const generation = context.generation;
    void load();
    void tenantApi
      .get<{ protocols: ApiKeyProtocol[] }>('/api/enterprise/model-configs/protocols')
      .then((result) => {
        if (!isCurrentTenantGeneration(context, generation)) return;
        setAvailableProtocols(result.protocols);
      })
      .catch(() => {
        // Protocol discovery is an optional enhancement; an abort or stale
        // tenant generation must never become an unhandled rejection/toast.
      });
  }, [tenantApi, tenantContext]);

  useEffect(() => {
    if (!wizardOpen) {
      setSubscriptionExplicitTenantId(null);
      setSubscriptionExplicitGeneration(null);
    }
  }, [wizardOpen]);

  useEffect(() => {
    const openCreate = () => setWizardOpen(true);
    window.addEventListener(OPEN_MODEL_CREATE_EVENT, openCreate);
    return () => window.removeEventListener(OPEN_MODEL_CREATE_EVENT, openCreate);
  }, []);

  const filteredRows = useMemo(() => {
    const keyword = searchText.trim().toLowerCase();
    if (!keyword) return rows;
    return rows.filter((row) =>
      [row.name, row.model, row.api_protocol, row.base_url || '', modelAuthModeLabel(row.auth_mode)].some((value) =>
        (value || '').toLowerCase().includes(keyword),
      ),
    );
  }, [rows, searchText]);

  const pagination = useClientPagination(filteredRows, MODEL_PAGE_SIZE, searchText);

  const enabledCount = rows.filter((item) => item.enabled).length;
  const defaultRow = rows.find((item) => item.is_default);
  const providerCount = new Set(rows.map((item) => item.api_protocol).filter(Boolean)).size;

  /** 打开退出本机 Codex 的影响确认。 */
  function requestSubscriptionLogout() {
    setSubscriptionLogoutConfirmOpen(true);
  }

  /** 确认退出后关闭提示，并交由共享订阅账号逻辑执行。 */
  function confirmSubscriptionLogout() {
    setSubscriptionLogoutConfirmOpen(false);
    void logoutSubscription();
  }

  async function confirmDelete() {
    const row = deleteTarget;
    if (!row || deleting) return;
    const context = tenantContext;
    if (!context) return;
    const generation = context.generation;
    setDeleting(true);
    try {
      await tenantApi.delete(`/api/enterprise/model-configs/${row.id}`);
      if (!isCurrentTenantGeneration(context, generation)) return;
      notify.successText(t('modelsPage.toast.deleted'));
      setDeleteTarget(null);
      await load();
    } catch (error) {
      if (!isCurrentTenantGeneration(context, generation)) return;
      notify.error(modelActionError(error, t('modelsPage.toast.deleteFailed')));
    } finally {
      if (isCurrentTenantGeneration(context, generation)) setDeleting(false);
    }
  }

  async function setDefault(row: ModelConfigRead) {
    const context = tenantContext;
    if (!context) return;
    const generation = context.generation;
    try {
      await tenantApi.post(`/api/enterprise/model-configs/${row.id}/set-default`);
      if (!isCurrentTenantGeneration(context, generation)) return;
      notify.successText(t('modelsPage.toast.setDefault'));
      await load();
    } catch (error) {
      if (!isCurrentTenantGeneration(context, generation)) return;
      notify.error(modelActionError(error, t('modelsPage.toast.setDefaultFailed')));
    }
  }

  async function test(row: ModelConfigRead): Promise<boolean> {
    if (testingModelIdsRef.current.has(row.id)) return false;
    const context = tenantContext;
    if (!context) return false;
    const generation = context.generation;
    const requestOwner = ++testingRequestOwnerRef.current;
    testingModelRequestOwnersRef.current.set(row.id, requestOwner);
    testingModelIdsRef.current.add(row.id);
    setTestingModelIds(new Set(testingModelIdsRef.current));
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), MODEL_TEST_UI_TIMEOUT_MS);
    try {
      const result = await tenantApi.postWithSignal<ModelTestResponse>(
        `/api/enterprise/model-configs/${row.id}/test?activate_if_initial=true`,
        {},
        controller.signal,
      );
      if (!isCurrentTenantGeneration(context, generation)) return false;
      if (result.success) {
        // The verification output is provider-originated diagnostic data. Do not
        // surface it through the success toast; use catalog-owned copy instead.
        if (!result.activated) notify.successText(t('modelsPage.toast.testSucceeded'));
        return true;
      } else if (result.message === 'MODEL_VERIFICATION_STALE') {
        notify.warning(t('modelsPage.toast.stale'));
      } else {
        notify.error(toastContentForProviderError(result.error, result.message));
      }
      return false;
    } catch (error) {
      if (!isCurrentTenantGeneration(context, generation)) return false;
      notify.error(
        error instanceof DOMException && error.name === 'AbortError'
          ? t('modelsPage.error.testTimeout')
          : modelActionError(error, t('modelsPage.toast.testFailed')),
      );
      return false;
    } finally {
      window.clearTimeout(timeoutId);
      if (testingModelRequestOwnersRef.current.get(row.id) === requestOwner) {
        testingModelRequestOwnersRef.current.delete(row.id);
        testingModelIdsRef.current.delete(row.id);
        setTestingModelIds(new Set(testingModelIdsRef.current));
        if (isCurrentTenantGeneration(context, generation)) void load(false);
      }
    }
  }

  function renderActions(row: ModelConfigRead) {
    const isTesting = testingModelIds.has(row.id);
    return (
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={isTesting ? `${row.name} ${t('modelsPage.actions.testing')}` : t('modelsPage.actions.menu')}
          className="ml-auto grid size-7 place-items-center rounded-[8px] text-[#1a71ff] transition-colors outline-none hover:bg-black/5 hover:text-[#4a8dff] focus-visible:bg-black/5"
        >
          {isTesting ? <LoaderCircle className="size-3.5 animate-spin" /> : <IconMore className="size-3.5" />}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className={MENU_CONTENT_CLASS}>
          <DropdownMenuItem className={MENU_ITEM_CLASS} disabled={isTesting} onSelect={() => openModelEditor(row)}>
            <IconEdit />
            {t('modelsPage.actions.edit')}
          </DropdownMenuItem>
          <DropdownMenuItem
            className={MENU_ITEM_CLASS}
            disabled={isTesting || row.is_default}
            onSelect={() => void setDefault(row)}
          >
            <Check />
            {row.is_default ? t('modelsPage.actions.default') : t('modelsPage.actions.setDefault')}
          </DropdownMenuItem>
          <DropdownMenuItem className={MENU_ITEM_CLASS} disabled={isTesting} onSelect={() => void test(row)}>
            {isTesting ? <LoaderCircle className="animate-spin" /> : <FlaskConical />}
            {isTesting ? t('modelsPage.actions.testing') : t('modelsPage.actions.test')}
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            className={MENU_ITEM_DANGER_CLASS}
            disabled={isTesting}
            onSelect={() => setDeleteTarget(row)}
          >
            <Trash2 />
            {t('modelsPage.actions.delete')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  const columns: DataTableColumn<ModelConfigRead>[] = [
    {
      key: 'name',
      title: t('modelsPage.column.name'),
      width: 240,
      className: 'text-[#18181a]',
      render: (row) => (
        <div className="flex min-w-0 flex-col gap-[2px]">
          <span className="flex min-w-0 items-center gap-[6px]">
            <span className="truncate font-medium leading-[18px] text-[#18181a]">{row.name}</span>
            {row.is_default && <StatusBadge tone="green">{t('modelsPage.actions.default')}</StatusBadge>}
          </span>
          <span className="truncate text-[#858b9c]">
            {row.enabled ? t('modelsPage.mobile.enabled') : t('modelsPage.mobile.disabled')} · {modelAuthModeLabel(row.auth_mode)}
          </span>
        </div>
      ),
    },
    { key: 'model', title: t('modelsPage.column.model'), width: 180, render: (row) => <span className="block truncate">{row.model}</span> },
    {
      key: 'auth_mode',
      title: t('modelsPage.column.authMode'),
      className: 'whitespace-normal',
      render: (row) => (
        <div className="flex min-w-0 flex-col gap-[2px]">
          <span className="line-clamp-1 wrap-break-word text-[#464c5e]">{modelAuthModeLabel(row.auth_mode)}</span>
          <span className="line-clamp-1 wrap-break-word text-[#858b9c]">
            {row.auth_mode === 'chatgpt_subscription' ? t('modelsPage.authHint.subscriptionRuntime') : row.base_url || t('modelsPage.authHint.baseUrlMissing')}
          </span>
        </div>
      ),
    },
    {
      key: 'api_key',
      title: t('modelsPage.column.apiKey'),
      width: 180,
      render: (row) => <span className="block truncate font-mono text-[#858b9c]">
        {row.auth_mode === 'chatgpt_subscription' ? t('modelsPage.authMode.subscription') : row.api_key_masked || '-'}
      </span>,
    },
    {
      key: 'actions',
      title: t('modelsPage.column.actions'),
      width: 70,
      align: 'right',
      render: (row) => renderActions(row),
    },
  ];

  const renderMobileCard = (row: ModelConfigRead) => (
    <article
      className="min-w-0 rounded-[8px] border border-[#eceef1] bg-white p-[14px]"
      key={row.id}
    >
      <div className="flex min-w-0 items-start justify-between gap-[10px]">
        <div className="min-w-0">
          <span className="flex min-w-0 items-center gap-[6px]">
            <strong className="truncate text-[14px] font-semibold text-[#18181a]">{row.name}</strong>
            {row.is_default && <StatusBadge tone="green">{t('modelsPage.actions.default')}</StatusBadge>}
          </span>
          <span className="mt-[2px] block truncate text-[12px] text-[#858b9c]">
            {row.enabled ? t('modelsPage.mobile.enabled') : t('modelsPage.mobile.disabled')} · {modelAuthModeLabel(row.auth_mode)}
          </span>
        </div>
        {renderActions(row)}
      </div>
      <p className="mt-[8px] line-clamp-1 wrap-break-word text-[12px] text-[#858b9c]">{row.model}</p>
      <p className="mt-[4px] line-clamp-1 wrap-break-word font-mono text-[12px] text-[#858b9c]">
        {row.auth_mode === 'chatgpt_subscription' ? t('modelsPage.card.subscription') : row.api_key_masked || '-'}
      </p>
    </article>
  );

  return (
    <div className="min-h-full box-border px-[48px] pt-[32px] pb-[43px] max-[900px]:px-[16px]">
      <AppHeader className="items-center" onLogout={onLogout} userName={currentUser?.username} title={t('modelsPage.stats.models')} />

      <div className="mt-[20px] mb-[16px] flex items-center justify-end gap-[12px]">
        <UIButton
          variant="outline"
          onClick={() => void load()}
          disabled={loading}
          className="h-[34px] gap-[4px] rounded-[10px] border-[0.5px] border-[#e3e7f1] bg-white px-[20px] text-[12px] font-normal text-[#757f9c] hover:border-[#cbd3e6] hover:bg-white hover:text-[#18181a]"
        >
          <IconRefresh className={cn('size-[14px]', loading && 'animate-spin')} />
          {t('modelsPage.actions.refresh')}
        </UIButton>
        <UIButton
          data-guide-target="models-create"
          onClick={() => setWizardOpen(true)}
          className="h-[34px] gap-[4px] rounded-[10px] bg-[#18181a] px-[20px] text-[12px] font-normal text-white hover:bg-[#303030]"
        >
          <IconAdd className="size-[14px]" />
          {t('modelsPage.actions.create')}
        </UIButton>
      </div>

      <div className="flex flex-col gap-[24px] rounded-[20px_20px_0_0] bg-white p-[18px_18px_24px_18px] shadow-[0_-4px_16px_0_rgba(0,0,0,0.05)]">
        <div className="flex flex-wrap items-stretch gap-[20px]" aria-label={t('modelsPage.stats.aria')}>
          <StatCard label={t('modelsPage.stats.models')} value={rows.length} />
          <StatCard label={t('modelsPage.stats.active')} value={enabledCount} tone="green" />
          <StatCard
            label={t('modelsPage.stats.default')}
            value={<span title={defaultRow?.name || undefined}>{defaultRow?.name || '-'}</span>}
            valueClassName="min-w-0 flex-1 shrink truncate text-[18px] leading-[26px]"
          />
          <StatCard label={t('modelsPage.stats.protocols')} value={providerCount} />
        </div>

        <div className="flex flex-col gap-[18px]">
          <div className="flex items-center gap-[6px] px-[12px] text-[#757f9c]">
            <IconModels className="size-[14px] shrink-0" />
            <span className="text-[14px] font-normal leading-none">{t('modelsPage.list.title')}</span>
          </div>

          <label className="flex h-[34px] w-[300px] items-center gap-[8px] overflow-hidden rounded-[10px] border-[0.5px] border-[#e3e7f1] bg-white px-[12px] transition-colors focus-within:border-[#18181a] max-[900px]:w-full">
            <IconSearch className="size-[14px] shrink-0 text-[#858b9c]" />
            <input
              autoComplete="off"
              data-1p-ignore="true"
              data-lpignore="true"
              data-bwignore="true"
              value={searchText}
              placeholder={t('modelsPage.search.placeholder')}
              onChange={(event) => setSearchText(event.target.value)}
              className="h-full min-w-0 flex-1 bg-transparent text-[12px] text-[#17191f] outline-none placeholder:text-[#c0c6d4]"
            />
            {searchText && (
              <button
                type="button"
                aria-label={t('modelsPage.search.clear')}
                onClick={() => setSearchText('')}
                className="grid size-[16px] shrink-0 place-items-center text-[#c0c6d4] hover:text-[#858b9c]"
              >
                <IconClear className="size-[14px]" />
              </button>
            )}
          </label>

          <div className="grid gap-[10px] md:hidden">
            {filteredRows.length ? (
              pagination.pagedItems.map(renderMobileCard)
            ) : null}
          </div>

          <div className="hidden md:block">
            <DataTable
              aria-label={t('modelsPage.list.aria')}
              columns={columns}
              data={pagination.pagedItems}
              rowKey={(row) => row.id}
              loading={loading}
              emptyText={t('modelsPage.empty')}
            />
          </div>

          {filteredRows.length > 0 && (
            <Paginator
              aria-label={t('modelsPage.pagination.aria')}
              className="mt-0 mb-[6px]"
              page={pagination.page}
              pageCount={pagination.pageCount}
              onChange={pagination.setPage}
            />
          )}
        </div>
      </div>

      <ModelSetupWizard
        open={wizardOpen || editingModel !== null}
        editingModel={editingModel}
        onOpenChange={(open) => {
          if (open) return;
          setWizardOpen(false);
          clearModelEditor();
        }}
        onCreated={(model) => {
          void load();
          if (editingModel) {
            notify.successText(
              model.enabled
                ? (model.is_default ? t('modelSetup.toast.enabledDefault') : t('modelSetup.toast.enabled'))
                : t('modelSetup.toast.saved'),
            );
            return;
          }
          notify.successText(t('modelsPage.toast.createdTested', { name: model.name }));
        }}
        availableProtocols={availableProtocols}
        subscriptionAccount={subscriptionAccount}
        subscriptionLoading={subscriptionLoading}
        onSubscriptionSelected={setSubscriptionChannelSelected}
        onStartSubscriptionLogin={startSubscriptionLogin}
        onCancelSubscriptionLogin={cancelSubscriptionLogin}
        onRequestSubscriptionLogout={requestSubscriptionLogout}
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        loading={deleting}
        title={deleteTarget ? t('modelsPage.confirm.delete.title', { name: deleteTarget.name }) : ''}
        description={deleteTarget?.is_default
          ? t('modelsPage.confirm.delete.descriptionDefault')
          : t('modelsPage.confirm.delete.description')}
        confirmText={t('modelsPage.actions.delete')}
        onConfirm={() => void confirmDelete()}
      />

      <ConfirmDialog
        open={subscriptionLogoutConfirmOpen}
        onOpenChange={setSubscriptionLogoutConfirmOpen}
        loading={subscriptionLoading}
        destructive={false}
        title={t('modelsPage.confirm.logout.title')}
        description={t('modelsPage.confirm.logout.description')}
        confirmText={t('modelsPage.confirm.logout.confirm')}
        onConfirm={confirmSubscriptionLogout}
      />
    </div>
  );
}
