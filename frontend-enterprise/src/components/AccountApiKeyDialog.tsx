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
  ShieldCheck,
  Trash2,
  UsersRound,
} from 'lucide-react';

import { api } from '../api/client';
import { copyTextToClipboard } from '../lib/clipboard';
import { ConfirmDialog } from './ConfirmDialog';

export type AccountApiKeySubject = {
  id: string;
  username: string;
  display_name?: string;
  role: 'admin' | 'member';
};

type AccountApiCredential = {
  id: string;
  user_id: string;
  name: string;
  access: 'user_full_access';
  key_prefix: string;
  can_reveal: boolean;
  scopes: string[];
  status: string;
  expires_at?: string | null;
  last_used_at?: string | null;
  created_at: string;
  revoked_at?: string | null;
};

type AccountApiCredentialCreated = AccountApiCredential & { api_key: string };
type AccountApiCredentialReveal = { api_key: string };

/** 为账户密钥对话框解析语义 i18n；缺少 Provider 时回退到当前持久化 locale。 */
function useAccountApiKeyIntl() {
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

/** 展示并管理当前账户 API 密钥的创建、复制、轮换、禁用和删除操作。 */
export default function AccountApiKeyDialog({
  account,
  open,
  onClose,
}: {
  account: AccountApiKeySubject | null;
  open: boolean;
  onClose: () => void;
}) {
  const { locale, t } = useAccountApiKeyIntl();
  const [credentials, setCredentials] = useState<AccountApiCredential[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [actingId, setActingId] = useState<string | null>(null);
  const [revealingId, setRevealingId] = useState<string | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<AccountApiCredential | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AccountApiCredential | null>(null);
  const [revealed, setRevealed] = useState<AccountApiCredentialCreated | null>(null);
  const [copied, setCopied] = useState(false);
  const revealedKeyRef = useRef<HTMLInputElement | null>(null);
  const displayName = useMemo(
    () => account?.display_name || account?.username || '账号',
    [account],
  );
  const closeBlocked = creating || actingId || revealingId || pendingRevoke || pendingDelete;

  /** 读取当前账户可见的 API 密钥列表；失败时仅显示安全文案或既有错误消息。 */
  async function load() {
    if (!account) return;
    setLoading(true);
    try {
      const rows = await api.get<AccountApiCredential[]>('/api/auth/me/api-credentials');
      setCredentials(rows);
    } catch (error) {
      notify.error(error instanceof Error ? error.message : t('accountApiKey.toast.loadFailed'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!open || !account) return;
    setRevealed(null);
    setCopied(false);
    void load();
  }, [account, open]);

  /** 为当前账户创建一把新的全量密钥，并仅在受控状态中短暂展示完整值。 */
  async function createCredential() {
    if (!account) return;
    setCreating(true);
    try {
      const created = await api.post<AccountApiCredentialCreated>('/api/auth/me/api-credentials', {
        name: t('accountApiKey.nameTemplate', { name: displayName }),
      });
      setRevealed(created);
      setCopied(false);
      await load();
      notify.success(t('accountApiKey.toast.createSuccess'));
    } catch (error) {
      notify.error(error instanceof Error ? error.message : t('accountApiKey.toast.createFailed'));
    } finally {
      setCreating(false);
    }
  }

  /** 轮换已有账户密钥，并让旧密钥立即失效。 */
  async function rotateCredential(row: AccountApiCredential) {
    if (!account) return;
    setActingId(row.id);
    try {
      const rotated = await api.post<AccountApiCredentialCreated>(
        `/api/auth/me/api-credentials/${encodeURIComponent(row.id)}/rotate`,
        {},
      );
      setRevealed(rotated);
      setCopied(false);
      await load();
      notify.success(t('accountApiKey.toast.rotateSuccess'));
    } catch (error) {
      notify.error(error instanceof Error ? error.message : t('accountApiKey.toast.rotateFailed'));
    } finally {
      setActingId(null);
    }
  }

  /** 通过单把密钥的受授权读取操作复制完整值，不把完整密钥写回列表状态。 */
  async function revealAndCopyCredential(row: AccountApiCredential) {
    setRevealingId(row.id);
    try {
      const revealedKey = await api.post<AccountApiCredentialReveal>(
        `/api/auth/me/api-credentials/${encodeURIComponent(row.id)}/reveal`,
        {},
      );
      await copyTextToClipboard(revealedKey.api_key);
      notify.success(t('accountApiKey.toast.copyFullSuccess'));
    } catch (error) {
      notify.error(error instanceof Error ? error.message : t('accountApiKey.toast.copyFullFailed'));
    } finally {
      setRevealingId(null);
    }
  }

  /** 在明确确认后禁用指定账户密钥，并刷新列表中的持久化状态。 */
  async function revokeCredential(row: AccountApiCredential) {
    if (!account) return;
    setActingId(row.id);
    try {
      await api.post(`/api/auth/me/api-credentials/${encodeURIComponent(row.id)}/revoke`, {});
      if (revealed?.id === row.id) setRevealed(null);
      await load();
      notify.success(t('accountApiKey.toast.revokeSuccess'));
    } catch (error) {
      notify.error(error instanceof Error ? error.message : t('accountApiKey.toast.revokeFailed'));
    } finally {
      setActingId(null);
      setPendingRevoke(null);
    }
  }

  /** 在明确确认后永久删除指定账户密钥，并移除可能展示的明文。 */
  async function deleteCredential(row: AccountApiCredential) {
    if (!account) return;
    setActingId(row.id);
    try {
      await api.delete(`/api/auth/me/api-credentials/${encodeURIComponent(row.id)}`);
      if (revealed?.id === row.id) setRevealed(null);
      await load();
      notify.success(t('accountApiKey.toast.deleteSuccess'));
    } catch (error) {
      notify.error(error instanceof Error ? error.message : t('accountApiKey.toast.deleteFailed'));
    } finally {
      setActingId(null);
      setPendingDelete(null);
    }
  }

  /** 复制新创建或轮换后返回的完整密钥；浏览器拒绝时回退到选中文本。 */
  async function copyKey() {
    if (!revealed?.api_key) return;
    try {
      await copyTextToClipboard(revealed.api_key);
      setCopied(true);
      notify.success(t('accountApiKey.toast.copySuccess'));
    } catch {
      revealedKeyRef.current?.focus();
      revealedKeyRef.current?.select();
      setCopied(false);
      notify.error(t('accountApiKey.toast.copyFallback'));
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
        aria-describedby="account-api-key-description"
        className="flex max-h-[calc(100dvh-3rem)] w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden rounded-[18px] border-0 bg-[#f7f8fa] p-0 shadow-[0_28px_80px_rgba(24,31,46,0.20)] sm:max-w-[780px]"
      >
        <DialogHeader className="border-b border-[#e9ecf2] bg-white px-[26px] py-[22px]">
          <div className="flex items-center gap-[12px]">
            <span className="grid size-[38px] place-items-center rounded-[12px] bg-[#18181a] text-white">
              <KeyRound className="size-[18px]" />
            </span>
            <div>
              <DialogTitle className="text-[16px] font-semibold text-[#18181a]">
                {t('accountApiKey.title', { name: displayName })}
              </DialogTitle>
              <DialogDescription
                id="account-api-key-description"
                className="mt-[5px] text-[12px] text-[#757f9c]"
              >
                {t('accountApiKey.description')}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-[18px] overflow-y-auto px-[26px] py-[22px]">
          <section className="relative overflow-hidden rounded-[16px] border border-[#cfe7dc] bg-[#eef8f3] p-[18px]">
            <span className="absolute right-[14px] top-[14px] rounded-full bg-[#d8efe4] px-[8px] py-[3px] text-[10px] font-semibold text-[#207451]">
              {t('accountApiKey.card.scopeBadge')}
            </span>
            <ShieldCheck className="size-[20px] text-[#207451]" />
            <h3 className="mt-[13px] text-[14px] font-semibold text-[#18181a]">
              {t('accountApiKey.card.accountFull')}
            </h3>
            <p className="mt-[4px] text-[12px] font-medium text-[#464c5e]">
              {t('accountApiKey.card.description')}
            </p>
            <div className="mt-[10px] grid gap-[7px] text-[11px] leading-[17px] text-[#647064] sm:grid-cols-2">
              <span className="flex gap-[6px]">
                <UsersRound className="mt-[1px] size-[14px] shrink-0" />
                {t('accountApiKey.card.capabilityBrowse')}
              </span>
              <span className="flex gap-[6px]">
                <RefreshCw className="mt-[1px] size-[14px] shrink-0" />
                {t('accountApiKey.card.capabilityManage')}
              </span>
            </div>
            <p className="mt-[10px] text-[10px] leading-[16px] text-[#7f897f]">
              {t('accountApiKey.card.limitations')}
            </p>
            <Button
              type="button"
              disabled={creating || Boolean(actingId || revealingId)}
              onClick={() => void createCredential()}
              className="mt-[14px] h-[32px] w-full rounded-[10px] bg-[#207451] text-[12px] text-white hover:bg-[#185d40]"
            >
              {creating && <LoaderCircle className="size-[14px] animate-spin" />}
              {t('accountApiKey.actions.create')}
            </Button>
          </section>

          {revealed && (
            <section className="rounded-[16px] border border-[#f0d28e] bg-[#fff9e9] p-[18px]" aria-live="polite">
              <div className="flex items-start justify-between gap-[14px]">
                <div>
                  <strong className="text-[13px] text-[#6b4d12]">
                    {t('accountApiKey.revealed.banner')}
                  </strong>
                  <p className="mt-[4px] text-[11px] text-[#96732f]">
                    {t('accountApiKey.card.accountFull')} · <RawIdentifier value={revealed.name} />
                  </p>
                </div>
                <span className="rounded-full bg-[#f7e8bc] px-[8px] py-[3px] text-[10px] text-[#7b5c19]">
                  {t('accountApiKey.copy.available')}
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
                  {copied ? t('accountApiKey.copy.copied') : t('accountApiKey.copy.copy')}
                </Button>
              </div>
            </section>
          )}

          <section>
            <div className="mb-[10px] flex items-center justify-between">
              <div>
                <h3 className="text-[13px] font-semibold text-[#18181a]">
                  {t('accountApiKey.list.title')}
                </h3>
                <p className="mt-[3px] text-[11px] text-[#8a92a3]">
                  {t('accountApiKey.list.description')}
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
                {t('accountApiKey.actions.refresh')}
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
                      <span className="rounded-full bg-[#e5f4ec] px-[7px] py-[2px] text-[9px] font-medium text-[#207451]">
                        {t('accountApiKey.card.accountFull')}
                      </span>
                      <span
                        className={row.status === 'active'
                          ? 'rounded-full bg-[#e8f7ec] px-[7px] py-[2px] text-[9px] text-[#218546]'
                          : 'rounded-full bg-[#f1f2f5] px-[7px] py-[2px] text-[9px] text-[#8a92a2]'}
                      >
                        {row.status === 'active'
                          ? t('accountApiKey.status.active')
                          : t('accountApiKey.status.revoked')}
                      </span>
                    </div>
                    <div className="mt-[6px] flex flex-wrap gap-x-[14px] gap-y-[3px] text-[10px] text-[#8a92a3]">
                      <RawIdentifier value={row.key_prefix} className="font-mono" />
                      <span>{t('accountApiKey.createdAt', { value: formatCredentialDate(row.created_at, locale) })}</span>
                      <span>
                        {row.last_used_at
                          ? t('accountApiKey.lastUsedAt', {
                            value: formatCredentialDate(row.last_used_at, locale),
                          })
                          : t('accountApiKey.neverUsed')}
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
                        {t('accountApiKey.actions.copyFull')}
                      </Button>
                    ) : row.status === 'active' ? (
                      <span className="text-[10px] text-[#8a92a3]">{t('accountApiKey.legacyHint')}</span>
                    ) : null}
                    <Button
                      type="button"
                      variant="outline"
                      disabled={Boolean(actingId || revealingId)}
                      onClick={() => void rotateCredential(row)}
                      className="h-[29px] rounded-[9px] border-[#e2e6ed] px-[9px] text-[10px] text-[#5e687c] hover:bg-[#f4f6f9]"
                    >
                      <RefreshCw className={actingId === row.id ? 'size-[12px] animate-spin' : 'size-[12px]'} />
                      {t('accountApiKey.actions.rotate')}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={row.status !== 'active' || Boolean(actingId || revealingId)}
                      onClick={() => setPendingRevoke(row)}
                      className="h-[29px] rounded-[9px] border-[#f0d8d8] px-[9px] text-[10px] text-[#bd4141] hover:bg-[#fff1f1] hover:text-[#a62d2d]"
                    >
                      <Ban className="size-[12px]" />
                      {t('accountApiKey.actions.revoke')}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={Boolean(actingId || revealingId)}
                      onClick={() => setPendingDelete(row)}
                      className="h-[29px] rounded-[9px] border-[#f0d8d8] px-[9px] text-[10px] text-[#bd4141] hover:bg-[#fff1f1] hover:text-[#a62d2d]"
                    >
                      <Trash2 className="size-[12px]" />
                      {t('accountApiKey.actions.delete')}
                    </Button>
                  </div>
                </div>
              )) : (
                <div className="flex h-[92px] flex-col items-center justify-center text-[#9098a9]">
                  <KeyRound className="size-[18px]" />
                  <span className="mt-[7px] text-[11px]">{t('accountApiKey.empty')}</span>
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
        title={t('accountApiKey.confirm.revoke.title')}
        description={pendingRevoke
          ? t('accountApiKey.confirm.revoke.description', { name: pendingRevoke.name })
          : undefined}
        confirmText={t('accountApiKey.confirm.revokeConfirm')}
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
        title={t('accountApiKey.confirm.delete.title')}
        description={pendingDelete
          ? t('accountApiKey.confirm.delete.description', { name: pendingDelete.name })
          : undefined}
        confirmText={t('accountApiKey.confirm.deleteConfirm')}
        loading={Boolean(actingId)}
        onConfirm={() => {
          if (pendingDelete) void deleteCredential(pendingDelete);
        }}
      />
    </Dialog>
  );
}
