/**
 * 微信客服专用 setup：按顺序完成 callback 准备、Secret 保存、账号/头像管理与咨询链接生成。
 * 所有产品文案走语义 MessageId；provider ID、URL 和名称只通过精确 raw 边界展示。
 */

import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import QRCode from 'qrcode';

import { wechatKfApi } from '@/api/client';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Button, Input } from '@/components/ui';
import { createToastNotifier } from '@/components/ui/app-toast';
import { createMessageDescriptor, type MessageDescriptor } from '@/i18n/descriptors';
import { RawContent, RawIdentifier } from '@/i18n/RawContent';
import { useAppIntl } from '@/i18n/useAppIntl';
import type { MessageId } from '@/i18n/types';
import { backendErrorMessageDescriptor } from '@/lib/apiErrorMessages';
import { copyTextToClipboard } from '@/lib/clipboard';
import type {
  ChannelBindingRead,
  WeChatKfAccountRead,
  WeChatKfCallbackConfigRead,
  WeChatKfProviderAccountRead,
} from '@/types';

import { canManageBinding } from '../channelPresentation';

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const AVATAR_TYPES = new Set(['image/jpeg', 'image/png']);
const CONTACT_URL_HOSTS = new Set(['work.weixin.qq.com']);
const PRIMARY_BUTTON_CLASS =
  'h-8 rounded-[10px] bg-primary px-4 text-[12px] font-normal text-white hover:bg-primary/80';
const OUTLINE_BUTTON_CLASS =
  'h-8 rounded-[10px] border-[#e3e7f1] px-4 text-[12px] font-normal text-[#464c5e] hover:bg-[#f6f6f6]';

type Operation =
  | 'prepare'
  | 'save'
  | 'accounts'
  | 'select'
  | 'avatar'
  | 'create'
  | 'update'
  | 'delete'
  | 'contact'
  | null;

type AccountRefreshResult = {
  accepted: boolean;
  succeeded: boolean;
};

/** 将稳定后端错误映射为 descriptor；未知/provider 文本只触发安全语义 fallback。 */
function errorDescriptor(error: unknown, fallbackId: MessageId): MessageDescriptor {
  const descriptor = backendErrorMessageDescriptor(error);
  return descriptor
    ? { id: descriptor.messageId, values: descriptor.values }
    : createMessageDescriptor(fallbackId);
}

/** 读取 binding 中公开的 corp ID；不尝试读取或恢复任何 Secret。 */
function bindingCorpId(binding: ChannelBindingRead): string {
  if (typeof binding.corp_id === 'string' && binding.corp_id.trim()) return binding.corp_id;
  const configured = binding.config_json?.corp_id;
  return typeof configured === 'string' ? configured : '';
}

/** 返回当前 binding 已路由的微信客服账号，保留 provider 原始字段。 */
function bindingAccounts(binding: ChannelBindingRead): WeChatKfAccountRead[] {
  return Array.isArray(binding.wechat_kf_accounts) ? binding.wechat_kf_accounts : [];
}

/** 仅接受 Task 2 fixture 证明过的 provider HTTPS host，拒绝凭据、畸形值与其他 origin。 */
function isSafeWechatKfContactUrl(value: string): boolean {
  if (!value || value !== value.trim()) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:'
      && !parsed.username
      && !parsed.password
      && CONTACT_URL_HOSTS.has(parsed.host);
  } catch {
    return false;
  }
}

/** 渲染微信客服 setup，并将所有写操作限定到 Task 2 的受控 API。 */
export default function WechatKfSetup({
  binding,
  onChanged,
}: {
  binding: ChannelBindingRead;
  onChanged: (updated: ChannelBindingRead) => void;
}) {
  const { t } = useAppIntl();
  const toast = createToastNotifier({ t });
  const manageable = canManageBinding(binding);
  const [corpId, setCorpId] = useState(() => bindingCorpId(binding));
  const [secret, setSecret] = useState('');
  const [callbackConfig, setCallbackConfig] = useState<WeChatKfCallbackConfigRead | null>(null);
  const [preparedCorpId, setPreparedCorpId] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<WeChatKfProviderAccountRead[]>([]);
  const [boundAccounts, setBoundAccounts] = useState<WeChatKfAccountRead[]>(() => bindingAccounts(binding));
  const [operation, setOperation] = useState<Operation>(null);
  const [errorId, setErrorId] = useState<MessageId | null>(null);
  const [accountName, setAccountName] = useState('');
  const [editingOpenKfid, setEditingOpenKfid] = useState<string | null>(null);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarInputRevision, setAvatarInputRevision] = useState(0);
  const [avatarMediaId, setAvatarMediaId] = useState('');
  const [avatarStatusId, setAvatarStatusId] = useState<MessageId | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WeChatKfProviderAccountRead | null>(null);
  const [contactUrls, setContactUrls] = useState<Record<string, string>>({});
  const [contactQrImages, setContactQrImages] = useState<Record<string, string>>({});
  const [contactOperationOpenKfid, setContactOperationOpenKfid] = useState<string | null>(null);
  const bindingGenerationRef = useRef(0);
  const accountRequestGeneration = useRef(0);

  /** 清空账号编辑器和本地 File 引用；不删除服务端账号。 */
  function resetAccountEditor(): void {
    setEditingOpenKfid(null);
    setAccountName('');
    setAvatarFile(null);
    setAvatarInputRevision((revision) => revision + 1);
    setAvatarMediaId('');
    setAvatarStatusId(null);
  }

  /** binding 切换时清除所有一次性 Secret、callback 与文件状态，并重新读取公开投影。 */
  useEffect(() => {
    const generation = ++bindingGenerationRef.current;
    setCorpId(bindingCorpId(binding));
    setSecret('');
    setCallbackConfig(null);
    setPreparedCorpId(null);
    setBoundAccounts(bindingAccounts(binding));
    setAccounts([]);
    resetAccountEditor();
    setContactUrls({});
    setContactQrImages({});
    setErrorId(null);
    setOperation(null);
    accountRequestGeneration.current += 1;
    return () => {
      if (bindingGenerationRef.current === generation) bindingGenerationRef.current += 1;
    };
  }, [binding.id]);

  /** Captures the binding generation so an older request cannot publish state into a new binding. */
  function currentBindingRequest(): () => boolean {
    const generation = bindingGenerationRef.current;
    return () => bindingGenerationRef.current === generation;
  }

  /** callback 已就绪且用户可管理时读取 provider 清单；未授权状态不发请求。 */
  useEffect(() => {
    if (manageable && binding.callback_ready) void loadAccounts();
  }, [binding.id, binding.callback_ready, manageable]);

  /** 把写操作返回的无凭据 binding 投影同步到本地并通知父页面。 */
  function applyBinding(updated: ChannelBindingRead): void {
    const nextAccounts = bindingAccounts(updated);
    setBoundAccounts(nextAccounts);
    onChanged(updated);
  }

  /** 记录一个安全语义错误，同时用 descriptor-only toast 通知用户。 */
  function showError(error: unknown, fallbackId: MessageId): void {
    setErrorId(fallbackId);
    toast.error(errorDescriptor(error, fallbackId));
  }

  /** 将本组件有限的验证/操作错误 ID 显式映射为当前 locale 文案，避免动态构造消息键。 */
  function errorMessage(id: MessageId): string {
    switch (id) {
      case 'channels.wechatKf.corpId.required': return t('channels.wechatKf.corpId.required');
      case 'channels.wechatKf.credentials.secretRequired': return t('channels.wechatKf.credentials.secretRequired');
      case 'channels.wechatKf.account.nameRequired': return t('channels.wechatKf.account.nameRequired');
      case 'channels.wechatKf.avatar.invalidType': return t('channels.wechatKf.avatar.invalidType');
      case 'channels.wechatKf.avatar.invalidSize': return t('channels.wechatKf.avatar.invalidSize');
      case 'channels.wechatKf.avatar.required': return t('channels.wechatKf.avatar.required');
      case 'channels.wechatKf.error.callbackPrepare': return t('channels.wechatKf.error.callbackPrepare');
      case 'channels.wechatKf.error.credentialsSave': return t('channels.wechatKf.error.credentialsSave');
      case 'channels.wechatKf.error.accountsLoad': return t('channels.wechatKf.error.accountsLoad');
      case 'channels.wechatKf.error.accountSelect': return t('channels.wechatKf.error.accountSelect');
      case 'channels.wechatKf.error.avatarUpload': return t('channels.wechatKf.error.avatarUpload');
      case 'channels.wechatKf.error.accountCreate': return t('channels.wechatKf.error.accountCreate');
      case 'channels.wechatKf.error.accountUpdate': return t('channels.wechatKf.error.accountUpdate');
      case 'channels.wechatKf.error.accountDelete': return t('channels.wechatKf.error.accountDelete');
      case 'channels.wechatKf.error.mutationRefresh': return t('channels.wechatKf.error.mutationRefresh');
      case 'channels.wechatKf.contact.invalidUrl': return t('channels.wechatKf.contact.invalidUrl');
      case 'channels.wechatKf.error.contactWay': return t('channels.wechatKf.error.contactWay');
      case 'channels.wechatKf.error.copy': return t('channels.wechatKf.error.copy');
      default: return t('common.error.generic');
    }
  }

  /** 更新 corp ID 原始输入并失效此前 corp 的一次性 callback 值。 */
  function handleCorpIdChange(event: ChangeEvent<HTMLInputElement>): void {
    setCorpId(event.target.value);
    setCallbackConfig(null);
    setPreparedCorpId(null);
  }

  /** 更新 Secret 临时输入；值仅保存在组件内存直到保存或 binding 切换。 */
  function handleSecretChange(event: ChangeEvent<HTMLInputElement>): void {
    setSecret(event.target.value);
  }

  /** 更新 provider 账号名称原始输入。 */
  function handleAccountNameChange(event: ChangeEvent<HTMLInputElement>): void {
    setAccountName(event.target.value);
  }

  /** 准备当前 corp 的一次性 callback 配置；开始和失败都会清除旧 corp 的值。 */
  async function prepareCallback(): Promise<void> {
    const isCurrent = currentBindingRequest();
    const normalizedCorpId = corpId.trim();
    setCallbackConfig(null);
    setPreparedCorpId(null);
    if (!normalizedCorpId) {
      setErrorId(createMessageDescriptor('channels.wechatKf.corpId.required').id);
      return;
    }
    setOperation('prepare');
    setErrorId(null);
    try {
      const prepared = await wechatKfApi.prepareCallback(binding.id, {
        tenant_id: binding.tenant_id,
        corp_id: normalizedCorpId,
      });
      if (!isCurrent()) return;
      setCallbackConfig(prepared);
      setPreparedCorpId(normalizedCorpId);
      toast.success(createMessageDescriptor('channels.wechatKf.callback.prepared'));
    } catch (error) {
      if (!isCurrent()) return;
      showError(error, 'channels.wechatKf.error.callbackPrepare');
    } finally {
      if (isCurrent()) setOperation(null);
    }
  }

  /** 快照并立即清空 Secret，再校验并保存与当前 corp 匹配的 callback 凭据。 */
  async function saveCredentials(): Promise<void> {
    const isCurrent = currentBindingRequest();
    const submittedSecret = secret;
    setSecret('');
    const normalizedCorpId = corpId.trim();
    if (!normalizedCorpId) {
      setErrorId(createMessageDescriptor('channels.wechatKf.corpId.required').id);
      return;
    }
    if (!submittedSecret.trim()) {
      setErrorId(createMessageDescriptor('channels.wechatKf.credentials.secretRequired').id);
      return;
    }
    setOperation('save');
    setErrorId(null);
    try {
      const callbackCredentials = callbackConfig && preparedCorpId === normalizedCorpId ? {
        callback_token: callbackConfig.callback_token,
        encoding_aes_key: callbackConfig.encoding_aes_key,
      } : {};
      const updated = await wechatKfApi.saveCredentials(binding.id, {
        tenant_id: binding.tenant_id,
        corp_id: normalizedCorpId,
        secret: submittedSecret,
        ...callbackCredentials,
      });
      if (!isCurrent()) return;
      applyBinding(updated);
      toast.success(createMessageDescriptor('channels.wechatKf.credentials.saved'));
    } catch (error) {
      if (!isCurrent()) return;
      showError(error, 'channels.wechatKf.error.credentialsSave');
    } finally {
      if (isCurrent()) setOperation(null);
    }
  }

  /** 获取并全量替换 provider 账号；generation 防止旧 binding 响应覆盖新状态。 */
  async function refreshAccounts(errorFallbackId: MessageId): Promise<AccountRefreshResult> {
    const isCurrentBinding = currentBindingRequest();
    const generation = accountRequestGeneration.current + 1;
    accountRequestGeneration.current = generation;
    try {
      const result = await wechatKfApi.listAccounts(binding.id, binding.tenant_id);
      if (!isCurrentBinding() || accountRequestGeneration.current !== generation) {
        return { accepted: false, succeeded: false };
      }
      setAccounts(Array.isArray(result.accounts) ? result.accounts : []);
      return { accepted: true, succeeded: true };
    } catch (error) {
      if (!isCurrentBinding() || accountRequestGeneration.current !== generation) {
        return { accepted: false, succeeded: false };
      }
      showError(error, errorFallbackId);
      return { accepted: true, succeeded: false };
    }
  }

  /** 加载 provider 可管理账号；响应原值只进入账号卡片的 raw 边界。 */
  async function loadAccounts(): Promise<void> {
    setOperation('accounts');
    setErrorId(null);
    const result = await refreshAccounts('channels.wechatKf.error.accountsLoad');
    if (result.accepted) setOperation(null);
  }

  /** 选择一个未绑定 provider 账号并以 provider 刷新结果同步完整账号集合。 */
  async function selectAccount(account: WeChatKfProviderAccountRead): Promise<void> {
    if (!account.manage_privilege || account.bound) return;
    const isCurrent = currentBindingRequest();
    setOperation('select');
    setErrorId(null);
    try {
      const updated = await wechatKfApi.selectAccount(binding.id, {
        tenant_id: binding.tenant_id,
        open_kfid: account.open_kfid,
      });
      if (!isCurrent()) return;
      applyBinding(updated);
      const refreshed = await refreshAccounts('channels.wechatKf.error.mutationRefresh');
      if (!isCurrent()) return;
      if (refreshed.succeeded) toast.success(createMessageDescriptor('channels.wechatKf.account.selectedToast'));
    } catch (error) {
      if (!isCurrent()) return;
      showError(error, 'channels.wechatKf.error.accountSelect');
    } finally {
      if (isCurrent()) setOperation(null);
    }
  }

  /** 清空原生文件选择与 React input 实例，避免拒绝文件仍留在 FileList。 */
  function clearAvatarInput(input: HTMLInputElement): void {
    input.value = '';
    setAvatarInputRevision((revision) => revision + 1);
  }

  /** 校验本地头像的 MIME 与 2 MiB 上限；失败时立即清空 FileList 且不发请求。 */
  function handleAvatarChange(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0] || null;
    setAvatarFile(null);
    setAvatarMediaId('');
    setAvatarStatusId(null);
    if (!file) {
      clearAvatarInput(event.currentTarget);
      return;
    }
    if (!AVATAR_TYPES.has(file.type)) {
      clearAvatarInput(event.currentTarget);
      setErrorId(createMessageDescriptor('channels.wechatKf.avatar.invalidType').id);
      return;
    }
    if (file.size <= 0 || file.size > MAX_AVATAR_BYTES) {
      clearAvatarInput(event.currentTarget);
      setErrorId(createMessageDescriptor('channels.wechatKf.avatar.invalidSize').id);
      return;
    }
    setErrorId(null);
    setAvatarFile(file);
  }

  /** 上传已通过本地校验的头像；响应 media ID 只在当前编辑会话中使用。 */
  async function uploadAvatar(): Promise<void> {
    if (!avatarFile) {
      setErrorId(createMessageDescriptor('channels.wechatKf.avatar.required').id);
      return;
    }
    const isCurrent = currentBindingRequest();
    setOperation('avatar');
    setErrorId(null);
    try {
      const result = await wechatKfApi.uploadAvatar(binding.id, avatarFile, binding.tenant_id);
      if (!isCurrent()) return;
      setAvatarMediaId(result.media_id);
      setAvatarFile(null);
      setAvatarInputRevision((revision) => revision + 1);
      setAvatarStatusId(createMessageDescriptor('channels.wechatKf.avatar.uploaded').id);
    } catch (error) {
      if (!isCurrent()) return;
      showError(error, 'channels.wechatKf.error.avatarUpload');
    } finally {
      if (isCurrent()) setOperation(null);
    }
  }

  /** 创建新的 provider 客服账号；要求当前编辑会话已有名称和头像 media ID。 */
  async function createAccount(): Promise<void> {
    const name = accountName.trim();
    if (!name) {
      setErrorId(createMessageDescriptor('channels.wechatKf.account.nameRequired').id);
      return;
    }
    if (!avatarMediaId) {
      setErrorId(createMessageDescriptor('channels.wechatKf.avatar.required').id);
      return;
    }
    const isCurrent = currentBindingRequest();
    setOperation('create');
    setErrorId(null);
    try {
      const updated = await wechatKfApi.createAccount(binding.id, {
        tenant_id: binding.tenant_id,
        name,
        media_id: avatarMediaId,
      });
      if (!isCurrent()) return;
      applyBinding(updated);
      const refreshed = await refreshAccounts('channels.wechatKf.error.mutationRefresh');
      if (!isCurrent()) return;
      resetAccountEditor();
      if (refreshed.succeeded) toast.success(createMessageDescriptor('channels.wechatKf.account.createdToast'));
    } catch (error) {
      if (!isCurrent()) return;
      showError(error, 'channels.wechatKf.error.accountCreate');
    } finally {
      if (isCurrent()) setOperation(null);
    }
  }

  /** 打开已绑定账号编辑器；名称保持 provider 原值，头像文件必须重新选择。 */
  function editAccount(account: WeChatKfProviderAccountRead): void {
    setEditingOpenKfid(account.open_kfid);
    setAccountName(account.name);
    setAvatarFile(null);
    setAvatarMediaId('');
    setAvatarStatusId(null);
    setErrorId(null);
  }

  /** 更新已绑定 provider 账号；未上传新头像时按 Task 2 契约省略 media ID。 */
  async function updateAccount(): Promise<void> {
    const name = accountName.trim();
    if (!editingOpenKfid || !name) {
      setErrorId(createMessageDescriptor('channels.wechatKf.account.nameRequired').id);
      return;
    }
    const isCurrent = currentBindingRequest();
    setOperation('update');
    setErrorId(null);
    try {
      const updated = await wechatKfApi.updateAccount(binding.id, {
        tenant_id: binding.tenant_id,
        open_kfid: editingOpenKfid,
        name,
        ...(avatarMediaId ? { media_id: avatarMediaId } : {}),
      });
      if (!isCurrent()) return;
      applyBinding(updated);
      const refreshed = await refreshAccounts('channels.wechatKf.error.mutationRefresh');
      if (!isCurrent()) return;
      resetAccountEditor();
      if (refreshed.succeeded) toast.success(createMessageDescriptor('channels.wechatKf.account.updatedToast'));
    } catch (error) {
      if (!isCurrent()) return;
      showError(error, 'channels.wechatKf.error.accountUpdate');
    } finally {
      if (isCurrent()) setOperation(null);
    }
  }

  /** 打开账号删除确认框；此步骤不触发 provider 写操作。 */
  function requestDelete(account: WeChatKfProviderAccountRead): void {
    setDeleteTarget(account);
  }

  /** 关闭账号删除确认框；loading 期间由 ConfirmDialog 阻止关闭。 */
  function setDeleteDialogOpen(open: boolean): void {
    if (!open) setDeleteTarget(null);
  }

  /** 在用户确认后删除 provider 账号并同步本地 binding/清单状态。 */
  async function confirmDelete(): Promise<void> {
    if (!deleteTarget) return;
    const target = deleteTarget;
    const isCurrent = currentBindingRequest();
    setOperation('delete');
    setErrorId(null);
    try {
      const updated = await wechatKfApi.deleteAccount(binding.id, target.open_kfid, binding.tenant_id);
      if (!isCurrent()) return;
      applyBinding(updated);
      setDeleteTarget(null);
      const refreshed = await refreshAccounts('channels.wechatKf.error.mutationRefresh');
      if (!isCurrent()) return;
      if (refreshed.succeeded) toast.success(createMessageDescriptor('channels.wechatKf.account.deletedToast'));
    } catch (error) {
      if (!isCurrent()) return;
      showError(error, 'channels.wechatKf.error.accountDelete');
    } finally {
      if (isCurrent()) setOperation(null);
    }
  }

  /** 清除一个账号之前生成的咨询 URL/QR，避免失败请求保留陈旧输出。 */
  function clearContactWay(openKfid: string): void {
    setContactUrls((current) => {
      const next = { ...current };
      delete next[openKfid];
      return next;
    });
    setContactQrImages((current) => {
      const next = { ...current };
      delete next[openKfid];
      return next;
    });
  }

  /** 为已绑定账号生成经严格 URL allowlist 校验的咨询链接与 QR。 */
  async function createContactWay(account: WeChatKfProviderAccountRead): Promise<void> {
    const isCurrent = currentBindingRequest();
    setOperation('contact');
    setContactOperationOpenKfid(account.open_kfid);
    setErrorId(null);
    clearContactWay(account.open_kfid);
    try {
      // 1. 请求 provider 原始咨询 URL；2. 校验 scheme/host/凭据；3. 生成 QR 并保留 raw URL。
      const result = await wechatKfApi.createContactWay(
        binding.id,
        account.open_kfid,
        binding.tenant_id,
      );
      if (!isCurrent()) return;
      if (!isSafeWechatKfContactUrl(result.url)) {
        setErrorId(createMessageDescriptor('channels.wechatKf.contact.invalidUrl').id);
        toast.error(createMessageDescriptor('channels.wechatKf.contact.invalidUrl'));
        return;
      }
      const qrImageUrl = await QRCode.toDataURL(result.url, { width: 220, margin: 1 });
      if (!isCurrent()) return;
      setContactUrls((current) => ({ ...current, [account.open_kfid]: result.url }));
      setContactQrImages((current) => ({ ...current, [account.open_kfid]: qrImageUrl }));
    } catch (error) {
      if (!isCurrent()) return;
      showError(error, 'channels.wechatKf.error.contactWay');
    } finally {
      if (isCurrent()) {
        setContactOperationOpenKfid(null);
        setOperation(null);
      }
    }
  }

  /** 复制 callback 或咨询 URL 原值；失败只展示受控语义错误。 */
  async function copyValue(value: string): Promise<void> {
    try {
      await copyTextToClipboard(value);
      toast.success(createMessageDescriptor('common.toast.copied'));
    } catch (error) {
      showError(error, 'channels.wechatKf.error.copy');
    }
  }

  /** 仅按 provider 集合中的 bound 字段判断是否绑定到当前 binding。 */
  function isBoundHere(account: WeChatKfProviderAccountRead): boolean {
    return account.bound && account.bound_binding_id === binding.id;
  }

  /** 渲染一次性 callback 原值与键盘可操作复制按钮。 */
  function renderCallbackValue(
    label: string,
    value: string,
    copyLabel: string,
  ): ReactNode {
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-[8px] bg-white p-2">
        <span className="text-[11px] font-medium text-[#464c5e]">{label}</span>
        <RawIdentifier value={value} className="min-w-0 flex-1 break-all text-[11px] text-[#858b9c]" />
        <Button
          type="button"
          variant="outline"
          className={OUTLINE_BUTTON_CLASS}
          aria-label={copyLabel}
          onClick={copyValue.bind(null, value)}
        >
          {t('common.action.copy')}
        </Button>
      </div>
    );
  }

  /** 渲染一个 provider 账号卡片；账号原值与产品操作文案保持独立边界。 */
  function renderAccount(account: WeChatKfProviderAccountRead): ReactNode {
    const boundHere = isBoundHere(account);
    const boundElsewhere = account.bound && account.bound_binding_id !== binding.id;
    const contactUrl = contactUrls[account.open_kfid];
    const contactQrImage = contactQrImages[account.open_kfid];
    return (
      <article key={account.open_kfid} className="flex flex-col gap-3 rounded-[10px] border border-[#eef0f4] bg-white p-3">
        <div className="flex flex-wrap items-center gap-3">
          {account.avatar && (
            <img
              src={account.avatar}
              alt={t('channels.wechatKf.account.avatarAlt')}
              className="size-10 rounded-full border border-[#eef0f4] object-cover"
            />
          )}
          <div className="min-w-0 flex-1">
            <RawContent value={account.name} className="block truncate text-[12px] font-medium text-[#18181a]" />
            <RawIdentifier value={account.open_kfid} className="block break-all text-[11px] text-[#858b9c]" />
          </div>
          {!account.manage_privilege && (
            <span className="text-[11px] text-[#a0a6b8]">{t('channels.wechatKf.accounts.noPrivilege')}</span>
          )}
          {boundHere && (
            <span className="rounded-full bg-[#e9f7ef] px-2 py-1 text-[11px] text-[#018434]">
              {t('channels.wechatKf.accounts.boundHere')}
            </span>
          )}
          {boundElsewhere && (
            <span className="rounded-full bg-[#fff4e5] px-2 py-1 text-[11px] text-[#8a4b00]">
              {t('channels.wechatKf.accounts.boundElsewhere')}
            </span>
          )}
        </div>
        {account.manage_privilege && (
          <div className="flex flex-wrap gap-2">
            {!account.bound && (
              <Button
                type="button"
                className={PRIMARY_BUTTON_CLASS}
                disabled={operation !== null}
                aria-label={t('channels.wechatKf.accounts.selectAria', { openKfid: account.open_kfid })}
                onClick={selectAccount.bind(null, account)}
              >
                {t('channels.wechatKf.accounts.select')}
              </Button>
            )}
            {boundHere && (
              <>
                <Button
                  type="button"
                  variant="outline"
                  className={OUTLINE_BUTTON_CLASS}
                  disabled={operation !== null}
                  aria-label={t('channels.wechatKf.account.editAria', { openKfid: account.open_kfid })}
                  onClick={editAccount.bind(null, account)}
                >
                  {t('common.action.edit')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className={OUTLINE_BUTTON_CLASS}
                  disabled={operation !== null}
                  aria-label={t('channels.wechatKf.contact.generateAria', { openKfid: account.open_kfid })}
                  onClick={createContactWay.bind(null, account)}
                >
                  {operation === 'contact' && contactOperationOpenKfid === account.open_kfid
                    ? t('channels.wechatKf.contact.generating')
                    : t('channels.wechatKf.contact.generate')}
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={operation !== null}
                  aria-label={t('channels.wechatKf.account.deleteAria', { openKfid: account.open_kfid })}
                  onClick={requestDelete.bind(null, account)}
                >
                  {t('channels.wechatKf.account.delete')}
                </Button>
              </>
            )}
          </div>
        )}
        {contactUrl && (
          <div className="flex min-w-0 flex-col gap-2 rounded-[8px] bg-[#fafbfc] p-2 sm:flex-row sm:items-center">
            {contactQrImage && (
              <img
                src={contactQrImage}
                alt={t('channels.wechatKf.contact.qrAlt')}
                className="size-[110px] rounded-[8px] border border-[#eef0f4] bg-white p-1"
              />
            )}
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
              <a
                href={contactUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="min-w-0 flex-1 break-all text-[11px] text-[#858b9c] underline underline-offset-2"
              >
                <RawIdentifier value={contactUrl} />
              </a>
              <Button
                type="button"
                variant="outline"
                className={OUTLINE_BUTTON_CLASS}
                aria-label={t('channels.wechatKf.contact.copy')}
                onClick={copyValue.bind(null, contactUrl)}
              >
                {t('common.action.copy')}
              </Button>
            </div>
          </div>
        )}
      </article>
    );
  }

  /** 渲染无管理权限时的公开 binding 信息，不提供任何写操作控件。 */
  function renderReadOnlyState(): ReactNode {
    return (
      <div className="flex flex-col gap-3 rounded-[10px] bg-[#fafbfc] p-4">
        <div role="status" className="text-[12px] text-[#858b9c]">
          {t('channels.wechatKf.permission.readOnly')}
        </div>
        <span className="text-[12px] text-[#464c5e]">
          {t('channels.wechatKf.corpId.label')}: <RawIdentifier value={corpId} />
        </span>
        {boundAccounts.map((account) => (
          <div key={account.open_kfid} className="flex flex-wrap gap-2 text-[12px] text-[#464c5e]">
            <RawContent value={account.name} />
            <RawIdentifier value={account.open_kfid} />
          </div>
        ))}
      </div>
    );
  }

  return (
    <section aria-labelledby={`wechat-kf-setup-${binding.id}`} className="flex flex-col gap-4 rounded-[12px] bg-[#fafbfc] p-4">
      <div className="flex flex-col gap-1">
        <h2 id={`wechat-kf-setup-${binding.id}`} className="text-[14px] font-semibold text-[#18181a]">
          {t('channels.wechatKf.setup.title')}
        </h2>
        <p className="text-[12px] leading-5 text-[#858b9c]">{t('channels.wechatKf.setup.description')}</p>
      </div>

      {!manageable ? renderReadOnlyState() : (
        <>
          {errorId && (
            <div role="alert" className="rounded-[8px] border border-[#f38989] bg-[#fce7e7] px-3 py-2 text-[12px] text-[#d20b0b]">
              {errorMessage(errorId)}
            </div>
          )}

          <div className="flex flex-col gap-3 rounded-[10px] border border-[#eef0f4] bg-white p-4">
            <h3 className="text-[13px] font-semibold text-[#18181a]">{t('channels.wechatKf.callback.title')}</h3>
            <p className="text-[12px] leading-5 text-[#858b9c]">{t('channels.wechatKf.callback.description')}</p>
            <label htmlFor={`wechat-kf-corp-${binding.id}`} className="flex flex-col gap-1 text-[12px] text-[#464c5e]">
              {t('channels.wechatKf.corpId.label')}
              <Input
                id={`wechat-kf-corp-${binding.id}`}
                value={corpId}
                onChange={handleCorpIdChange}
                placeholder={createMessageDescriptor('channels.wechatKf.corpId.placeholder')}
                disabled={operation !== null || Boolean(bindingCorpId(binding))}
              />
            </label>
            <Button type="button" onClick={prepareCallback} disabled={operation !== null} className={PRIMARY_BUTTON_CLASS}>
              {operation === 'prepare'
                ? t('channels.wechatKf.callback.preparing')
                : t('channels.wechatKf.callback.prepare')}
            </Button>
            {callbackConfig && preparedCorpId === corpId.trim() && (
              <div className="flex flex-col gap-2">
                {renderCallbackValue(t('channels.wechatKf.callback.url'), callbackConfig.callback_url, t('channels.wechatKf.callback.copyUrl'))}
                {renderCallbackValue(t('channels.wechatKf.callback.token'), callbackConfig.callback_token, t('channels.wechatKf.callback.copyToken'))}
                {renderCallbackValue(t('channels.wechatKf.callback.aesKey'), callbackConfig.encoding_aes_key, t('channels.wechatKf.callback.copyAesKey'))}
              </div>
            )}
            <label htmlFor={`wechat-kf-secret-${binding.id}`} className="flex flex-col gap-1 text-[12px] text-[#464c5e]">
              {t('channels.wechatKf.credentials.secretLabel')}
              <Input
                id={`wechat-kf-secret-${binding.id}`}
                type="password"
                value={secret}
                onChange={handleSecretChange}
                placeholder={createMessageDescriptor('channels.wechatKf.credentials.secretPlaceholder')}
                autoComplete="new-password"
                disabled={operation !== null}
              />
            </label>
            <Button type="button" onClick={saveCredentials} disabled={operation !== null} className={PRIMARY_BUTTON_CLASS}>
              {operation === 'save'
                ? t('channels.wechatKf.credentials.saving')
                : t('channels.wechatKf.credentials.save')}
            </Button>
          </div>

          {binding.callback_ready && (
            <div className="flex flex-col gap-3 rounded-[10px] border border-[#eef0f4] bg-white p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-[13px] font-semibold text-[#18181a]">{t('channels.wechatKf.accounts.title')}</h3>
                  <p className="text-[12px] leading-5 text-[#858b9c]">{t('channels.wechatKf.accounts.description')}</p>
                </div>
                <Button type="button" variant="outline" className={OUTLINE_BUTTON_CLASS} onClick={loadAccounts} disabled={operation !== null}>
                  {t('channels.wechatKf.accounts.refresh')}
                </Button>
              </div>
              {operation === 'accounts' && (
                <div role="status" className="text-[12px] text-[#858b9c]">{t('channels.wechatKf.accounts.loading')}</div>
              )}
              {operation !== 'accounts' && accounts.length === 0 && (
                <div className="text-[12px] text-[#858b9c]">{t('channels.wechatKf.accounts.empty')}</div>
              )}
              <div className="grid gap-3 md:grid-cols-2">{accounts.map(renderAccount)}</div>

              <div className="flex flex-col gap-3 border-t border-[#eef0f4] pt-3">
                <h4 className="text-[12px] font-semibold text-[#18181a]">
                  {editingOpenKfid ? t('channels.wechatKf.account.editTitle') : t('channels.wechatKf.account.createTitle')}
                </h4>
                <label htmlFor={`wechat-kf-account-name-${binding.id}`} className="flex flex-col gap-1 text-[12px] text-[#464c5e]">
                  {t('channels.wechatKf.account.nameLabel')}
                  <Input id={`wechat-kf-account-name-${binding.id}`} value={accountName} onChange={handleAccountNameChange} placeholder={createMessageDescriptor('channels.wechatKf.account.namePlaceholder')} />
                </label>
                <label htmlFor={`wechat-kf-avatar-${binding.id}`} className="flex flex-col gap-1 text-[12px] text-[#464c5e]">
                  {t('channels.wechatKf.avatar.label')}
                  <input
                    key={avatarInputRevision}
                    id={`wechat-kf-avatar-${binding.id}`}
                    type="file"
                    accept="image/jpeg,image/png"
                    aria-label={t('channels.wechatKf.avatar.label')}
                    onChange={handleAvatarChange}
                    disabled={operation !== null}
                    className="block w-full rounded-[8px] border border-[#e3e7f1] p-2 text-[12px]"
                  />
                  <span className="text-[11px] text-[#858b9c]">{t('channels.wechatKf.avatar.help')}</span>
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="button" variant="outline" className={OUTLINE_BUTTON_CLASS} onClick={uploadAvatar} disabled={operation !== null || !avatarFile}>
                    {operation === 'avatar' ? t('channels.wechatKf.avatar.uploading') : t('channels.wechatKf.avatar.upload')}
                  </Button>
                  {avatarStatusId === 'channels.wechatKf.avatar.uploaded' && (
                    <span className="text-[11px] text-[#018434]">{t('channels.wechatKf.avatar.uploaded')}</span>
                  )}
                  <Button type="button" className={PRIMARY_BUTTON_CLASS} onClick={editingOpenKfid ? updateAccount : createAccount} disabled={operation !== null}>
                    {editingOpenKfid
                      ? operation === 'update' ? t('channels.wechatKf.account.updating') : t('channels.wechatKf.account.update')
                      : operation === 'create' ? t('channels.wechatKf.account.creating') : t('channels.wechatKf.account.create')}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={setDeleteDialogOpen}
        title={t('channels.wechatKf.delete.title')}
        description={deleteTarget ? (
          <span className="flex flex-col gap-1">
            <span>{t('channels.wechatKf.delete.description')}</span>
            <RawContent value={deleteTarget.name} />
            <RawIdentifier value={deleteTarget.open_kfid} />
          </span>
        ) : undefined}
        confirmText={operation === 'delete' ? t('channels.wechatKf.delete.deleting') : t('channels.wechatKf.delete.confirm')}
        cancelText={t('common.action.cancel')}
        onConfirm={confirmDelete}
        loading={operation === 'delete'}
      />
    </section>
  );
}
