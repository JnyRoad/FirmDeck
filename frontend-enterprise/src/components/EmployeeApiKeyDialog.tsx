import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  notify,
} from '@/components/ui';
import { createAppTranslator, getStoredLocale } from '@/i18n';
import { RawIdentifier } from '@/i18n/RawContent';
import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppIntlContext } from '@/i18n/provider';
import {
  Ban,
  Check,
  Copy,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  TerminalSquare,
  Trash2,
} from 'lucide-react';

import { createTenantClient } from '../api/tenant-client';
import { useTenantSession } from '../contexts/TenantSessionContext';
import { employeeDisplayName } from '../employee';
import { copyTextToClipboard } from '../lib/clipboard';
import type { AgentProfileRead } from '../types';
import { ConfirmDialog } from './ConfirmDialog';

type KeyAccess = 'runtime';
type CredentialAccess = KeyAccess | 'full_access';

type AgentApiCredential = {
  id: string;
  agent_id: string;
  name: string;
  access: CredentialAccess;
  key_prefix: string;
  can_reveal: boolean;
  scopes: string[];
  status: string;
  expires_at?: string | null;
  last_used_at?: string | null;
  created_at: string;
  revoked_at?: string | null;
};

type AgentApiCredentialCreated = AgentApiCredential & {
  api_key: string;
};
type AgentApiCredentialReveal = { api_key: string };

/** 为员工密钥对话框解析语义 i18n；缺少 Provider 时回退到当前持久化 locale。 */
function useEmployeeApiKeyIntl() {
  const context = useContext(AppIntlContext);
  return useMemo(() => context ?? createAppTranslator(getStoredLocale()), [context]);
}

/** 用当前语义 locale 格式化凭据时间；原始值非法时原样返回。 */
function formatCredentialDate(value: string | null | undefined, locale: string): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

const RUNTIME_ACCESS_META = {
  icon: TerminalSquare,
  access: 'runtime' as const,
};

/** 读取可本地化的密钥访问级别标签；未知值保留稳定英文/中文产品文案。 */
function accessLabel(access: CredentialAccess, t: ReturnType<typeof useEmployeeApiKeyIntl>['t']): string {
  return access === 'full_access'
    ? t('employeeApiKey.access.legacyFull')
    : t('employeeApiKey.access.runtime');
}

/** 展示并管理指定员工 API 密钥的创建、复制、轮换、禁用和删除操作。 */
export default function EmployeeApiKeyDialog({
  agent,
  open,
  onClose,
}: {
  agent: AgentProfileRead | null;
  open: boolean;
  onClose: () => void;
}) {
  const { locale, t } = useEmployeeApiKeyIntl();
  const tenantContext = useTenantSession();
  const tenantApi = useMemo(() => createTenantClient(tenantContext), [tenantContext]);
  const [credentials, setCredentials] = useState<AgentApiCredential[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState<KeyAccess | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);
  const [revealingId, setRevealingId] = useState<string | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<AgentApiCredential | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AgentApiCredential | null>(null);
  const [revealed, setRevealed] = useState<AgentApiCredentialCreated | null>(null);
  const [copied, setCopied] = useState(false);
  const revealedKeyRef = useRef<HTMLInputElement | null>(null);
  const displayName = useMemo(() => (agent ? employeeDisplayName(agent) : '数字员工'), [agent]);
  const closeBlocked = creating || actingId || revealingId || pendingRevoke || pendingDelete;

  // Secrets and credential rows are tenant-bound UI state. Drop them during
  // the provider's replacement gap so a new tenant can never inherit the
  // previous tenant's list or transient plaintext key.
  useEffect(() => {
    if (tenantContext) return;
    setCredentials([]);
    setRevealed(null);
    setCopied(false);
    setLoading(false);
    setCreating(null);
    setActingId(null);
    setRevealingId(null);
    setPendingRevoke(null);
    setPendingDelete(null);
  }, [tenantContext]);

  /** 读取指定员工的 API 密钥列表；失败时仅显示安全文案或既有错误消息。 */
  async function load() {
    const context = tenantContext;
    const generation = context?.generation;
    if (!agent || !context || generation === undefined) return;
    setLoading(true);
    try {
      const rows = await tenantApi.get<AgentApiCredential[]>(
        `/api/enterprise/agents/${encodeURIComponent(agent.id)}/api-credentials`,
      );
      if (!context.isCurrentGeneration(generation)) return;
      setCredentials(rows);
    } catch (error) {
      if (!context.isCurrentGeneration(generation)) return;
      notify.error(error instanceof Error ? error.message : t('employeeApiKey.toast.loadFailed'));
    } finally {
      if (context.isCurrentGeneration(generation)) setLoading(false);
    }
  }

  useEffect(() => {
    if (!open || !agent) {
      setRevealed(null);
      setCopied(false);
      return;
    }
    setRevealed(null);
    setCopied(false);
    void load();
  }, [agent, open, tenantApi]);

  /** 为指定员工创建新的运行密钥，并仅在受控状态中短暂展示完整值。 */
  async function createCredential(access: KeyAccess) {
    const context = tenantContext;
    const generation = context?.generation;
    if (!agent || !context || generation === undefined) return;
    setCreating(access);
    try {
      const created = await tenantApi.post<AgentApiCredentialCreated>(
        `/api/enterprise/agents/${encodeURIComponent(agent.id)}/api-credentials`,
        {
          name: t('employeeApiKey.nameTemplate', {
            name: displayName,
            accessLabel: accessLabel(access, t),
          }),
          access,
        },
      );
      if (!context.isCurrentGeneration(generation)) return;
      setRevealed(created);
      setCopied(false);
      await load();
      if (!context.isCurrentGeneration(generation)) return;
      notify.success(t('employeeApiKey.toast.createSuccess'));
    } catch (error) {
      if (!context.isCurrentGeneration(generation)) return;
      notify.error(error instanceof Error ? error.message : t('employeeApiKey.toast.createFailed'));
    } finally {
      if (context.isCurrentGeneration(generation)) setCreating(null);
    }
  }

  /** 轮换已有员工密钥，并让旧密钥立即失效。 */
  async function rotateCredential(row: AgentApiCredential) {
    const context = tenantContext;
    const generation = context?.generation;
    if (!agent || !context || generation === undefined) return;
    setActingId(row.id);
    try {
      const rotated = await tenantApi.post<AgentApiCredentialCreated>(
        `/api/enterprise/agents/${encodeURIComponent(agent.id)}/api-credentials/${encodeURIComponent(row.id)}/rotate`,
        {},
      );
      if (!context.isCurrentGeneration(generation)) return;
      setRevealed(rotated);
      setCopied(false);
      await load();
      if (!context.isCurrentGeneration(generation)) return;
      notify.success(t('employeeApiKey.toast.rotateSuccess'));
    } catch (error) {
      if (!context.isCurrentGeneration(generation)) return;
      notify.error(error instanceof Error ? error.message : t('employeeApiKey.toast.rotateFailed'));
    } finally {
      if (context.isCurrentGeneration(generation)) setActingId(null);
    }
  }

  /** 通过单把密钥的受授权读取操作复制完整值，不把完整密钥写回列表状态。 */
  async function revealAndCopyCredential(row: AgentApiCredential) {
    const context = tenantContext;
    const generation = context?.generation;
    if (!agent || !context || generation === undefined) return;
    setRevealingId(row.id);
    try {
      const revealedKey = await tenantApi.post<AgentApiCredentialReveal>(
        `/api/enterprise/agents/${encodeURIComponent(agent.id)}/api-credentials/${encodeURIComponent(row.id)}/reveal`,
        {},
      );
      if (!context.isCurrentGeneration(generation)) return;
      await copyTextToClipboard(revealedKey.api_key);
      if (!context.isCurrentGeneration(generation)) return;
      notify.success(t('employeeApiKey.toast.copyFullSuccess'));
    } catch (error) {
      if (!context.isCurrentGeneration(generation)) return;
      notify.error(error instanceof Error ? error.message : t('employeeApiKey.toast.copyFullFailed'));
    } finally {
      if (context.isCurrentGeneration(generation)) setRevealingId(null);
    }
  }

  /** 在明确确认后禁用指定员工密钥，并刷新列表中的持久化状态。 */
  async function revokeCredential(row: AgentApiCredential) {
    const context = tenantContext;
    const generation = context?.generation;
    if (!agent || !context || generation === undefined) return;
    setActingId(row.id);
    try {
      await tenantApi.post(
        `/api/enterprise/agents/${encodeURIComponent(agent.id)}/api-credentials/${encodeURIComponent(row.id)}/revoke`,
        {},
      );
      if (!context.isCurrentGeneration(generation)) return;
      if (revealed?.id === row.id) setRevealed(null);
      await load();
      if (!context.isCurrentGeneration(generation)) return;
      notify.success(t('employeeApiKey.toast.revokeSuccess'));
    } catch (error) {
      if (!context.isCurrentGeneration(generation)) return;
      notify.error(error instanceof Error ? error.message : t('employeeApiKey.toast.revokeFailed'));
    } finally {
      if (context.isCurrentGeneration(generation)) {
        setActingId(null);
        setPendingRevoke(null);
      }
    }
  }

  /** 在明确确认后永久删除指定员工密钥，并移除可能展示的明文。 */
  async function deleteCredential(row: AgentApiCredential) {
    const context = tenantContext;
    const generation = context?.generation;
    if (!agent || !context || generation === undefined) return;
    setActingId(row.id);
    try {
      await tenantApi.delete(
        `/api/enterprise/agents/${encodeURIComponent(agent.id)}/api-credentials/${encodeURIComponent(row.id)}`,
      );
      if (!context.isCurrentGeneration(generation)) return;
      if (revealed?.id === row.id) setRevealed(null);
      await load();
      if (!context.isCurrentGeneration(generation)) return;
      notify.success(t('employeeApiKey.toast.deleteSuccess'));
    } catch (error) {
      if (!context.isCurrentGeneration(generation)) return;
      notify.error(error instanceof Error ? error.message : t('employeeApiKey.toast.deleteFailed'));
    } finally {
      if (context.isCurrentGeneration(generation)) {
        setActingId(null);
        setPendingDelete(null);
      }
    }
  }

  /** 复制新创建或轮换后返回的完整密钥；浏览器拒绝时回退到选中文本。 */
  async function copyKey() {
    const context = tenantContext;
    const generation = context?.generation;
    const key = revealed?.api_key;
    if (!key || !context || generation === undefined) return;
    try {
      await copyTextToClipboard(key);
      if (!context.isCurrentGeneration(generation)) return;
      setCopied(true);
      notify.success(t('employeeApiKey.toast.copySuccess'));
    } catch {
      if (!context.isCurrentGeneration(generation)) return;
      revealedKeyRef.current?.focus();
      revealedKeyRef.current?.select();
      setCopied(false);
      notify.error(t('employeeApiKey.toast.copyFallback'));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !closeBlocked) onClose();
      }}
    >
      <DialogContent
        aria-describedby="employee-api-key-description"
        className="flex max-h-[calc(100dvh-3rem)] w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden rounded-[18px] border-0 bg-[#f7f8fa] p-0 shadow-[0_28px_80px_rgba(24,31,46,0.20)] sm:max-w-[780px]"
      >
        <DialogHeader className="border-b border-[#e9ecf2] bg-white px-[26px] py-[22px]">
          <div className="flex items-center gap-[12px]">
            <span className="grid size-[38px] place-items-center rounded-[12px] bg-[#18181a] text-white">
              <KeyRound className="size-[18px]" />
            </span>
            <div>
              <DialogTitle className="text-[16px] font-semibold text-[#18181a]">
                {t('employeeApiKey.title', { name: displayName })}
              </DialogTitle>
              <DialogDescription
                id="employee-api-key-description"
                className="mt-[5px] text-[12px] text-[#757f9c]"
              >
                {t('employeeApiKey.description')}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-[18px] overflow-y-auto px-[26px] py-[22px]">
          <section className="grid gap-[12px]" aria-label={t('common.action.create')}>
            <article className="rounded-[16px] border border-[#e2e6ee] bg-white p-[18px]">
              <RUNTIME_ACCESS_META.icon className="size-[20px] text-[#5d6880]" />
              <h3 className="mt-[13px] text-[14px] font-semibold text-[#18181a]">
                {t('employeeApiKey.access.runtime')}
              </h3>
              <p className="mt-[4px] text-[12px] font-medium text-[#464c5e]">
                {t('employeeApiKey.card.description')}
              </p>
              <p className="mt-[8px] text-[11px] leading-[17px] text-[#7b8498]">
                {t('employeeApiKey.card.detail')}
              </p>
              <Button
                type="button"
                disabled={Boolean(creating || actingId || revealingId)}
                onClick={() => void createCredential(RUNTIME_ACCESS_META.access)}
                className="mt-[14px] h-[32px] w-full rounded-[10px] bg-[#18181a] text-[12px] text-white hover:bg-[#303033]"
              >
                {creating === RUNTIME_ACCESS_META.access && <LoaderCircle className="size-[14px] animate-spin" />}
                {t('employeeApiKey.actions.createRuntime')}
              </Button>
            </article>
          </section>

          {revealed && (
            <section className="rounded-[16px] border border-[#f0d28e] bg-[#fff9e9] p-[18px]" aria-live="polite">
              <div className="flex items-start justify-between gap-[14px]">
                <div>
                  <strong className="text-[13px] text-[#6b4d12]">
                    {t('employeeApiKey.revealed.banner')}
                  </strong>
                  <p className="mt-[4px] text-[11px] text-[#96732f]">
                    {accessLabel(revealed.access, t)} · <RawIdentifier value={revealed.name} />
                  </p>
                </div>
                <span className="rounded-full bg-[#f7e8bc] px-[8px] py-[3px] text-[10px] text-[#7b5c19]">
                  {t('employeeApiKey.copy.available')}
                </span>
              </div>
              <div className="mt-[12px] flex items-center gap-[8px] rounded-[12px] bg-[#1d2027] p-[8px] pl-[12px]">
                <input
                  ref={revealedKeyRef}
                  readOnly
                  value={revealed.api_key}
                  onFocus={(event) => event.currentTarget.select()}
                  data-i18n-raw-kind="identifier"
                  translate="no"
                  className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-[#e7ebf3] outline-none"
                />
                <Button
                  type="button"
                  onClick={() => void copyKey()}
                  className="h-[30px] shrink-0 rounded-[8px] bg-white px-[10px] text-[11px] text-[#18181a] hover:bg-[#edf0f5]"
                >
                  {copied ? <Check className="size-[13px]" /> : <Copy className="size-[13px]" />}
                  {copied ? t('employeeApiKey.copy.copied') : t('employeeApiKey.copy.copy')}
                </Button>
              </div>
            </section>
          )}

          <section>
            <div className="mb-[10px] flex items-center justify-between">
              <div>
                <h3 className="text-[13px] font-semibold text-[#18181a]">
                  {t('employeeApiKey.list.title')}
                </h3>
                <p className="mt-[3px] text-[11px] text-[#8a92a3]">
                  {t('employeeApiKey.list.description')}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                disabled={loading}
                onClick={() => void load()}
                className="h-[30px] rounded-[9px] px-[9px] text-[11px] text-[#687187] hover:bg-white"
              >
                <RefreshCw className={loading ? 'size-[13px] animate-spin' : 'size-[13px]'} />
                {t('employeeApiKey.actions.refresh')}
              </Button>
            </div>

            <div className="overflow-hidden rounded-[16px] border border-[#e4e8ef] bg-white">
              {loading && !credentials.length ? (
                <div className="grid h-[92px] place-items-center text-[#8b93a5]">
                  <LoaderCircle className="size-[18px] animate-spin" />
                </div>
              ) : credentials.length ? credentials.map((row, index) => (
                <div
                  key={row.id}
                  className={`flex flex-col gap-[12px] px-[16px] py-[14px] md:flex-row md:items-center ${index ? 'border-t border-[#edf0f4]' : ''}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-[7px]">
                      <RawIdentifier value={row.name} className="truncate text-[12px] font-bold text-[#252932]" />
                      <span className="rounded-full bg-[#edf1f8] px-[7px] py-[2px] text-[9px] font-medium text-[#56627a]">
                        {accessLabel(row.access, t)}
                      </span>
                      <span
                        className={row.status === 'active'
                          ? 'rounded-full bg-[#e8f7ec] px-[7px] py-[2px] text-[9px] text-[#218546]'
                          : 'rounded-full bg-[#f1f2f5] px-[7px] py-[2px] text-[9px] text-[#8a92a2]'}
                      >
                        {row.status === 'active'
                          ? t('employeeApiKey.status.active')
                          : t('employeeApiKey.status.revoked')}
                      </span>
                    </div>
                    <div className="mt-[6px] flex flex-wrap gap-x-[14px] gap-y-[3px] text-[10px] text-[#8a92a3]">
                      <RawIdentifier value={row.key_prefix} className="font-mono" />
                      <span>{t('employeeApiKey.createdAt', { value: formatCredentialDate(row.created_at, locale) })}</span>
                      <span>
                        {row.last_used_at
                          ? t('employeeApiKey.lastUsedAt', {
                            value: formatCredentialDate(row.last_used_at, locale),
                          })
                          : t('employeeApiKey.neverUsed')}
                      </span>
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-[6px]">
                    {row.status === 'active' && row.can_reveal ? (
                      <Button
                        type="button"
                        variant="outline"
                        disabled={Boolean(actingId || revealingId)}
                        onClick={() => void revealAndCopyCredential(row)}
                        className="h-[29px] rounded-[9px] border-[#e2e6ed] px-[9px] text-[10px] text-[#5e687c] hover:bg-[#f4f6f9]"
                      >
                        {revealingId === row.id ? <LoaderCircle className="size-[12px] animate-spin" /> : <Copy className="size-[12px]" />}
                        {t('employeeApiKey.actions.copyFull')}
                      </Button>
                    ) : row.status === 'active' ? (
                      <span className="text-[10px] text-[#8a92a3]">{t('employeeApiKey.legacyHint')}</span>
                    ) : null}
                    <Button
                      type="button"
                      variant="outline"
                      disabled={Boolean(actingId || revealingId)}
                      onClick={() => void rotateCredential(row)}
                      className="h-[29px] rounded-[9px] border-[#e2e6ed] px-[9px] text-[10px] text-[#5e687c] hover:bg-[#f4f6f9]"
                    >
                      <RefreshCw className={actingId === row.id ? 'size-[12px] animate-spin' : 'size-[12px]'} />
                      {t('employeeApiKey.actions.rotate')}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={row.status !== 'active' || Boolean(actingId || revealingId)}
                      onClick={() => setPendingRevoke(row)}
                      className="h-[29px] rounded-[9px] border-[#f0d8d8] px-[9px] text-[10px] text-[#bd4141] hover:bg-[#fff1f1] hover:text-[#a62d2d]"
                    >
                      <Ban className="size-[12px]" />
                      {t('employeeApiKey.actions.revoke')}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={Boolean(actingId || revealingId)}
                      onClick={() => setPendingDelete(row)}
                      className="h-[29px] rounded-[9px] border-[#f0d8d8] px-[9px] text-[10px] text-[#bd4141] hover:bg-[#fff1f1] hover:text-[#a62d2d]"
                    >
                      <Trash2 className="size-[12px]" />
                      {t('employeeApiKey.actions.delete')}
                    </Button>
                  </div>
                </div>
              )) : (
                <div className="flex h-[92px] flex-col items-center justify-center text-[#9098a9]">
                  <KeyRound className="size-[18px]" />
                  <span className="mt-[7px] text-[11px]">{t('employeeApiKey.empty')}</span>
                </div>
              )}
            </div>
          </section>
        </div>
      </DialogContent>
      <ConfirmDialog
        open={Boolean(pendingRevoke)}
        onOpenChange={(next) => {
          if (!next && !actingId) setPendingRevoke(null);
        }}
        title={t('employeeApiKey.confirm.revoke.title')}
        description={pendingRevoke
          ? t('employeeApiKey.confirm.revoke.description', { name: pendingRevoke.name })
          : undefined}
        confirmText={t('employeeApiKey.confirm.revokeConfirm')}
        destructive={false}
        loading={Boolean(actingId)}
        onConfirm={() => {
          if (pendingRevoke) void revokeCredential(pendingRevoke);
        }}
      />
      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onOpenChange={(next) => {
          if (!next && !actingId) setPendingDelete(null);
        }}
        title={t('employeeApiKey.confirm.delete.title')}
        description={pendingDelete
          ? t('employeeApiKey.confirm.delete.description', { name: pendingDelete.name })
          : undefined}
        confirmText={t('employeeApiKey.confirm.deleteConfirm')}
        loading={Boolean(actingId)}
        onConfirm={() => {
          if (pendingDelete) void deleteCredential(pendingDelete);
        }}
      />
    </Dialog>
  );
}
