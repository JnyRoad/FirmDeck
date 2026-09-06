import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui';
import { Button as UIButton } from '@/components/ui/button';
import { notify } from '@/components/ui/app-toast';
import { cn } from '@/lib/utils';
import { KeyRound } from 'lucide-react';

import IconChevronDown from '../assets/icons/chevron-down.svg?react';
import IconEdit from '../assets/icons/edit.svg?react';
import IconLogout from '../assets/icons/logout.svg?react';
import { createTenantClient } from '../api/tenant-client';
import {
  setEnterpriseAuthSession,
  type EnterpriseAuthSession,
  type EnterpriseAuthUser,
} from '../auth';
import { useTenantSession } from '../contexts/TenantSessionContext';
import LanguageSwitcher from './LanguageSwitcher';
import AccountApiKeyDialog from './AccountApiKeyDialog';
import { useAppIntl } from '../i18n/useAppIntl';

/** 只允许 http/https/data:image/blob 协议的图片地址,其余一律视为无效。 */
function safeImageUrl(value: string): string {
  const text = value.trim();
  if (!text) return '';
  try {
    const parsed = new URL(text, window.location.origin);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.href;
    if (parsed.protocol === 'blob:') return parsed.href;
    if (parsed.protocol === 'data:' && /^data:image\//i.test(text)) return text;
  } catch {
    // 非法 URL 视为无效
  }
  return '';
}

export type AppHeaderProps = {
  /**
   * Page-specific content rendered on the left side of the header. When
   * provided it takes precedence over the `title` / `description` fields.
   */
  left?: ReactNode;
  /** Convenience field for the left slot's title line. Ignored when `left` is set. */
  title?: ReactNode;
  /** Convenience field for the left slot's description line. Ignored when `left` is set. */
  description?: ReactNode;
  /**
   * Custom content for the right side of the header. When provided it fully
   * replaces the default user avatar / logout dropdown (used e.g. on the
   * signed-out login page which shows a theme toggle + login button instead).
   */
  right?: ReactNode;
  /** Called when the logout menu item is clicked. */
  onLogout?: () => void;
  /** Current user's display name, used for the avatar initial. */
  userName?: string;
  /** Complete verified tenant session; omitted pages use the tenant context. */
  session?: EnterpriseAuthSession | null;
  className?: string;
};

/**
 * Global page header. The right side shows a user avatar button whose dropdown
 * holds the logout action; the left side is provided per-page via the `left`
 * slot, or via the `title` / `description` convenience fields. When `left` is
 * passed it is rendered as-is and the convenience fields are ignored.
 * Pass `right` to override the default avatar with page-specific actions.
 */
export default function AppHeader({
  left,
  title,
  description,
  right,
  onLogout,
  userName,
  session: providedSession,
  className,
}: AppHeaderProps) {
  const { t } = useAppIntl();
  const tenantContext = useTenantSession();
  const tenantClient = useMemo(() => createTenantClient(tenantContext), [tenantContext]);
  const session = providedSession || tenantContext?.session || null;
  const [user, setUser] = useState<EnterpriseAuthUser | undefined>(() => session?.user);
  const [uploadPreviewUrl, setUploadPreviewUrl] = useState('');
  const uploadPreviewUrlRef = useRef('');
  const [avatarBlobUrl, setAvatarBlobUrl] = useState('');
  const avatarBlobUrlRef = useRef('');
  const [avatarSaving, setAvatarSaving] = useState(false);
  const [apiKeyOpen, setApiKeyOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const avatarRequestControllerRef = useRef<AbortController | null>(null);
  const avatarActionControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setUser(session?.user);
  }, [session?.user]);

  const displayName = user?.display_name || user?.username || '';
  const initial = (displayName || userName || '').trim()?.[0]?.toUpperCase();
  const isAdmin = user?.role === 'admin';
  // avatar_url 是资源指针(非图片地址):渲染只用预览/已拉取的 blob URL
  const avatarUrl = uploadPreviewUrl || avatarBlobUrl;
  // 仅放行 http/https/data:image/blob 协议,阻止 javascript: 等可执行协议注入
  const safeAvatarUrl = safeImageUrl(avatarUrl);

  // blob URL 由 ref 跟踪:替换/清除/组件卸载时都能 revoke 到最新值,不受闭包快照影响
  const replaceTrackedUrl = useCallback((ref: { current: string }, set: (v: string) => void, next: string) => {
    const prev = ref.current;
    if (prev && prev !== next) URL.revokeObjectURL(prev);
    ref.current = next;
    set(next);
  }, []);

  const replaceUploadPreview = useCallback((next: string) => {
    replaceTrackedUrl(uploadPreviewUrlRef, setUploadPreviewUrl, next);
  }, [replaceTrackedUrl]);

  const replaceAvatarBlob = useCallback((next: string) => {
    replaceTrackedUrl(avatarBlobUrlRef, setAvatarBlobUrl, next);
  }, [replaceTrackedUrl]);

  function clearUploadPreview() {
    replaceUploadPreview('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  // 头像二进制不随 login/me 内联:凭指针用已验证租户请求拉字节,转 blob URL 渲染
  const loadAvatar = useCallback(async () => {
    avatarRequestControllerRef.current?.abort();
    const controller = new AbortController();
    avatarRequestControllerRef.current = controller;
    const onTenantAbort = () => controller.abort();
    tenantContext?.signal.addEventListener('abort', onTenantAbort, { once: true });
    if (!tenantContext || !user?.avatar_url) {
      replaceAvatarBlob('');
      tenantContext?.signal.removeEventListener('abort', onTenantAbort);
      avatarRequestControllerRef.current = null;
      return;
    }
    try {
      const blob = await tenantClient.blob('/api/auth/me/avatar', { signal: controller.signal });
      if (!controller.signal.aborted) replaceAvatarBlob(URL.createObjectURL(blob));
    } catch {
      // 头像加载失败不阻断,回退为首字母
    } finally {
      tenantContext.signal.removeEventListener('abort', onTenantAbort);
      if (avatarRequestControllerRef.current === controller) {
        avatarRequestControllerRef.current = null;
      }
    }
  }, [replaceAvatarBlob, tenantClient, tenantContext, user?.avatar_url]);

  const avatarPointer = user?.avatar_url || '';
  const userId = user?.id || '';
  useEffect(() => {
    void loadAvatar();
    return () => avatarRequestControllerRef.current?.abort();
  }, [avatarPointer, loadAvatar, userId]);

  useEffect(
    () => () => {
      avatarRequestControllerRef.current?.abort();
      avatarActionControllerRef.current?.abort();
      if (uploadPreviewUrlRef.current) URL.revokeObjectURL(uploadPreviewUrlRef.current);
      if (avatarBlobUrlRef.current) URL.revokeObjectURL(avatarBlobUrlRef.current);
    },
    [],
  );

  const refreshSessionUser = useCallback(async (signal?: AbortSignal) => {
    if (!session) return;
    try {
      const fresh = await tenantClient.get<EnterpriseAuthUser>('/api/auth/me', { signal });
      if (signal?.aborted) return;
      const nextSession: EnterpriseAuthSession = { ...session, user: fresh };
      setEnterpriseAuthSession(nextSession);
      setUser(fresh);
    } catch {
      // 头像操作已成功时会话刷新失败不阻断,下次登录/刷新自然同步
    }
  }, [session, tenantClient]);

  /** 选图即传：本地预览乐观渲染，成功后刷新会话；失败保留服务端原始错误或使用本地兜底。 */
  async function pickAvatar(file: File | null) {
    if (!file || avatarSaving) return;
    clearUploadPreview();
    const objectUrl = URL.createObjectURL(file);
    replaceUploadPreview(objectUrl);
    setAvatarSaving(true);
    avatarActionControllerRef.current?.abort();
    const controller = new AbortController();
    avatarActionControllerRef.current = controller;
    const onTenantAbort = () => controller.abort();
    tenantContext?.signal.addEventListener('abort', onTenantAbort, { once: true });
    try {
      const form = new FormData();
      form.append('file', file);
      if (!tenantContext) throw new Error(t('shell.account.avatarUploadFailed'));
      await tenantClient.put('/api/auth/me/avatar', form, { signal: controller.signal });
      if (controller.signal.aborted) return;
      notify.successText(t('shell.account.avatarUpdated'));
      await refreshSessionUser(controller.signal);
      // 覆盖上传时指针字符串不变,effect 不会重触发,显式重拉头像字节
      await loadAvatar();
    } catch (error) {
      if (controller.signal.aborted) return;
      notify.error(error instanceof Error ? error.message : t('shell.account.avatarUploadFailed'));
    } finally {
      tenantContext?.signal.removeEventListener('abort', onTenantAbort);
      if (avatarActionControllerRef.current === controller) avatarActionControllerRef.current = null;
      setAvatarSaving(false);
      clearUploadPreview();
    }
  }

  /** 删除当前用户头像并刷新认证快照；服务端原始错误不做翻译。 */
  async function removeAvatar() {
    if (avatarSaving) return;
    setAvatarSaving(true);
    avatarActionControllerRef.current?.abort();
    const controller = new AbortController();
    avatarActionControllerRef.current = controller;
    const onTenantAbort = () => controller.abort();
    tenantContext?.signal.addEventListener('abort', onTenantAbort, { once: true });
    try {
      if (!tenantContext) throw new Error(t('shell.account.avatarRemoveFailed'));
      await tenantClient.delete('/api/auth/me/avatar', undefined, { signal: controller.signal });
      if (controller.signal.aborted) return;
      notify.successText(t('shell.account.avatarRemoved'));
      await refreshSessionUser(controller.signal);
      await loadAvatar();
    } catch (error) {
      if (controller.signal.aborted) return;
      notify.error(error instanceof Error ? error.message : t('shell.account.avatarRemoveFailed'));
    } finally {
      tenantContext?.signal.removeEventListener('abort', onTenantAbort);
      if (avatarActionControllerRef.current === controller) avatarActionControllerRef.current = null;
      setAvatarSaving(false);
    }
  }

  const leftContent = left ?? (
    (title !== undefined || description !== undefined) ? (
      <div className="flex min-h-[40px] flex-col justify-center gap-[4px]">
        {title !== undefined && (
          <p className="text-[16px] font-medium leading-[normal] text-[#464c5e]">{title}</p>
        )}
        {description !== undefined && (
          <p className="text-[14px] leading-[normal] text-[#757f9c]">{description}</p>
        )}
      </div>
    ) : null
  );

  return (
    <header className={cn('flex w-full items-start gap-[16px]', className)}>
      <div className="min-w-0 flex-1">{leftContent}</div>
      <div className="flex h-[32px] shrink-0 items-center gap-[8px]">
        <LanguageSwitcher />
        {right !== undefined ? right : (
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={t('shell.account.menu')}
              className="flex h-[32px] shrink-0 items-center gap-[8px] rounded-[10px] pl-[4px] pr-[8px] outline-none"
            >
              <span className="grid size-[32px] shrink-0 place-items-center overflow-hidden rounded-full bg-[#eef1fb] text-[14px] font-medium leading-none text-[#7e96dc]">
                {safeAvatarUrl ? (
                  <img src={safeAvatarUrl} alt="" className="size-full object-cover" />
                ) : (
                  (initial ?? '--')
                )}
              </span>
              <IconChevronDown className="size-[14px] shrink-0 text-[#757F9C]" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="w-fit min-w-0 rounded-[14px] border-0 bg-white p-[6px] shadow-[0px_16px_15px_rgba(0,0,0,0.1)] ring-0 [--accent:#F6F6F6] [--accent-foreground:#18181A]"
            >
              {user && (
                <>
                  <div className="flex max-w-[240px] flex-col gap-[10px] px-[12px] pt-[8px] pb-[12px]">
                    <div className="flex items-center gap-[10px]">
                      <div className="relative shrink-0">
                        <button
                          type="button"
                          title={t('shell.account.changeAvatar')}
                          aria-label={t('shell.account.changeAvatar')}
                          onClick={() => {
                            // 打开文件对话框前清空 input,确保重复选择同一文件也能触发 onChange
                            if (fileInputRef.current) fileInputRef.current.value = '';
                            fileInputRef.current?.click();
                          }}
                          className={cn(
                            'block size-[40px] overflow-hidden rounded-full transition-opacity',
                            avatarSaving && 'pointer-events-none opacity-60',
                          )}
                        >
                          {safeAvatarUrl ? (
                            <img
                              src={safeAvatarUrl}
                              alt=""
                              className="size-full object-cover"
                            />
                          ) : (
                            <span className="grid size-full place-items-center bg-[#eef1fb] text-[16px] font-medium leading-none text-[#7e96dc]">
                              {initial ?? '--'}
                            </span>
                          )}
                        </button>
                        {avatarSaving && (
                          <span className="pointer-events-none absolute inset-0 grid place-items-center">
                            <span className="size-[18px] animate-spin rounded-full border-2 border-white/40 border-t-white" />
                          </span>
                        )}
                        {!avatarSaving && (
                          <span className="pointer-events-none absolute -bottom-[2px] -right-[2px] grid size-[16px] place-items-center rounded-full bg-primary text-white">
                            <IconEdit className="size-[9px]" />
                          </span>
                        )}
                      </div>
                      <div className="flex min-w-0 flex-col gap-[2px]">
                        <span className="truncate text-[14px] font-medium text-[#18181a]">
                          {displayName}
                        </span>
                        {user.username && user.username !== displayName && (
                          <span className="truncate text-[12px] text-[#858b9c]">
                            @{user.username}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center justify-between gap-[12px]">
                      <div className="flex items-center gap-[10px]">
                        <span
                          className={cn(
                            'inline-flex items-center rounded-full px-[12px] py-[4px] text-[10px] leading-none whitespace-nowrap',
                            isAdmin
                              ? 'bg-[#e8f0ff] text-[#1a71ff]'
                              : 'bg-[#f2f3f7] text-[#858b9c]',
                          )}
                        >
                          {isAdmin ? t('shell.account.roleAdmin') : t('shell.account.roleMember')}
                        </span>
                        {user.avatar_url && (
                          <button
                            type="button"
                            onClick={() => void removeAvatar()}
                            disabled={avatarSaving}
                            className="text-[11px] text-[#a0a8bd] transition-colors hover:text-[#d20b0b] disabled:opacity-50"
                          >
                            {t('shell.account.removeAvatar')}
                          </button>
                        )}
                      </div>
                      {isAdmin && (
                        <span className="max-w-[150px] truncate text-[11px] text-[#a0a8bd]">
                          {user.tenant_id}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="mx-[6px] mb-[6px] h-px bg-[#eef0f4]" />
                </>
              )}
              {user && (
                <DropdownMenuItem
                  onSelect={() => setApiKeyOpen(true)}
                  className="h-[36px] cursor-pointer gap-2 rounded-[10px] px-[12px] text-[14px] text-[#464C5E]"
                >
                  <KeyRound className="size-[16px]" />
                  {t('shell.account.fullApiKey')}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onSelect={() => onLogout?.()}
                className="h-[36px] cursor-pointer gap-2 rounded-[10px] px-[12px] text-[14px] text-[#464C5E]"
              >
                <IconLogout className="size-[16px]" />
                {t('shell.account.logout')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {/* 文件 input 常驻在 header 根部(不在下拉菜单内),菜单关闭也不会被卸载;
          选图即传:本地预览乐观渲染,上传成功刷新会话,失败回滚 */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(event) => pickAvatar(event.target.files?.[0] || null)}
      />
      <AccountApiKeyDialog
        account={user ? { ...user, display_name: user.display_name ?? undefined } : null}
        open={apiKeyOpen}
        onClose={() => setApiKeyOpen(false)}
      />
    </header>
  );
}
