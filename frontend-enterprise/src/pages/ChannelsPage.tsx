import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { createToastNotifier } from '@/components/ui/app-toast';

import AppHeader from '@/components/AppHeader';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { DataTable, type DataTableColumn } from '@/components/DataTable';
import SearchableSelect from '@/components/SearchableSelect';
import {
  Checkbox,
  Dialog,
  DialogContent,
  DialogTitle,
  Input,
  RadioGroup,
  RadioGroupItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@/components/ui';
import { Button as UIButton } from '@/components/ui/button';

import { createTenantClient } from '../api/tenant-client';
import { useTenantSession } from '../contexts/TenantSessionContext';

import { createMessageDescriptor, type MessageDescriptor } from '@/i18n/descriptors';
import { RawContent, RawIdentifier } from '@/i18n/RawContent';
import { createFormatters } from '@/i18n/formatters';
import { useAppIntl } from '@/i18n/useAppIntl';
import type { MessageValues } from '@/i18n/imperative';
import type { MessageId } from '@/i18n/types';
import { backendErrorMessageDescriptor } from '@/lib/apiErrorMessages';
// 渠道转接通知运行时已支持飞书/企微私聊;钉钉/微信适配器只能回会话内消息,不在此列。
const HANDOFF_NOTIFY_CHANNELS = new Set(['feishu', 'wecom']);
import IconAdd from '../assets/icons/add.svg?react';
import IconAlignJustify from '../assets/icons/align-justify.svg?react';
import IconChat from '../assets/icons/chat.svg?react';
import IconChevronDown from '../assets/icons/chevron-down.svg?react';
import IconAccount from '../assets/icons/sys-accounts.svg?react';
import IconWarningFill from '../assets/icons/warning-fill.svg?react';
import type { EnterpriseAuthUser } from '../auth';
import { canManageEmployeeAgent, employeeDisplayName } from '../employee';
import { getClientTimeZone, parseBackendDateTime } from '@/lib/timezone';
import { cn } from '@/lib/utils';
import { copyTextToClipboard } from '@/lib/clipboard';
import type {
  AgentProfileRead,
  ChannelBindingRead,
  ChannelBindCodeRead,
  ChannelConversationMessageRead,
  ChannelConversationAttachment,
  ChannelConversationRead,
  ChannelDeliveryDay,
  ChannelDeliveryDayPage,
  ChannelDeliveryRead,
  ChannelIdentityBindingRead,
  ChannelMetaRead,
  PagedResponse,
  TeamRead,
} from '../types';
import { formatHandoffAssigneeValue, parseHandoffAssigneeValue } from '../lib/handoff-assignee';
import { feishuAppIdFromIdentityScope } from '../lib/identity-scope';
import WechatSetup from './channels/WechatSetup';
import WechatKfSetup from './channels/WechatKfSetup';
import WecomSetup from './channels/WecomSetup';
import FeishuSetup from './channels/FeishuSetup';
import DingTalkSetup from './channels/DingTalkSetup';
import BindingManagers from './channels/BindingManagers';
import {
  canDeleteBinding,
  canManageBinding,
} from './channelPresentation';
import { StatusBadge } from './scheduled-tasks/StatusBadge';
import { type BadgeTone } from './scheduled-tasks/shared';

const PRIMARY_BUTTON_CLASS =
  'h-8 gap-1 rounded-[10px] bg-[#18181a] px-5 text-[12px] font-normal text-white hover:bg-[#303030]';
const OUTLINE_BUTTON_CLASS =
  'h-8 gap-1 rounded-[10px] border-[#e3e7f1] px-5 text-[12px] font-normal text-[#464c5e] hover:bg-[#f6f6f6] hover:text-[#18181a]';

type LocalizedStatus = {
  tone: BadgeTone;
  messageId?: MessageId;
  raw?: string;
};

const BINDING_STATUS_BADGE: Record<string, LocalizedStatus> = {
  pending: { tone: 'blue', messageId: 'channels.status.pending' },
  active: { tone: 'green', messageId: 'channels.status.active' },
  expired: { tone: 'red', messageId: 'channels.status.expired' },
  disabled: { tone: 'gray', messageId: 'channels.status.disabled' },
};

const DELIVERY_STATUS_BADGE: Record<string, LocalizedStatus> = {
  delivered: { tone: 'green', messageId: 'channels.delivery.status.delivered' },
  failed: { tone: 'red', messageId: 'channels.delivery.status.failed' },
  pending: { tone: 'blue', messageId: 'channels.delivery.status.pending' },
  sending: { tone: 'orange', messageId: 'channels.delivery.status.sending' },
};

const CHANNEL_COMMANDS: Array<{ command: string; descriptionId: MessageId }> = [
  { command: '/员工', descriptionId: 'channels.commands.listEmployees' },
  { command: '/切换 <员工名> 或 /<员工名>', descriptionId: 'channels.commands.switchEmployee' },
  { command: '/当前', descriptionId: 'channels.commands.currentEmployee' },
  { command: '/帮助', descriptionId: 'channels.commands.help' },
];

const CREATE_TARGETS: Array<{ key: 'agent' | 'team'; labelId: MessageId }> = [
  { key: 'agent', labelId: 'channels.create.targetAgent' },
  { key: 'team', labelId: 'channels.create.targetTeam' },
];

const CHANNEL_PRESENTATION_MESSAGE_IDS: Record<string, {
  name: MessageId;
  identifierLabel: MessageId;
  userLabel: MessageId;
  blurb: MessageId;
  disconnectDescription: MessageId;
}> = {
  wechat: {
    name: 'channels.provider.wechat',
    identifierLabel: 'channels.provider.botIdLabel',
    userLabel: 'channels.provider.wechatUser',
    blurb: 'channels.provider.wechatBlurb',
    disconnectDescription: 'channels.provider.wechatDisconnect',
  },
  wechat_kf: {
    name: 'channels.provider.wechatKf',
    identifierLabel: 'channels.provider.wechatKfIdLabel',
    userLabel: 'channels.provider.wechatKfUser',
    blurb: 'channels.provider.wechatKfBlurb',
    disconnectDescription: 'channels.provider.wechatKfDisconnect',
  },
  wecom: {
    name: 'channels.provider.wecom',
    identifierLabel: 'channels.provider.botIdLabel',
    userLabel: 'channels.provider.wecomUser',
    blurb: 'channels.provider.wecomBlurb',
    disconnectDescription: 'channels.provider.wecomDisconnect',
  },
  feishu: {
    name: 'channels.provider.feishu',
    identifierLabel: 'channels.provider.appIdLabel',
    userLabel: 'channels.provider.feishuUser',
    blurb: 'channels.provider.feishuBlurb',
    disconnectDescription: 'channels.provider.feishuDisconnect',
  },
  dingtalk: {
    name: 'channels.provider.dingtalk',
    identifierLabel: 'channels.provider.clientIdLabel',
    userLabel: 'channels.provider.dingtalkUser',
    blurb: 'channels.provider.dingtalkBlurb',
    disconnectDescription: 'channels.provider.dingtalkDisconnect',
  },
};

const ROLE_LABEL_IDS: Record<string, MessageId> = {
  admin: 'channels.role.admin',
  owner: 'channels.role.owner',
  collaborator: 'channels.role.collaborator',
};

const BINDING_NAME_MAX_LENGTH = 50;

type Translate = (id: MessageId, values?: MessageValues) => string;
type ChannelsTenantContext = NonNullable<ReturnType<typeof useTenantSession>>;
type BindingRequestKind = 'deliveries' | 'conversations' | 'messages';
type BindingRequestFence = {
  kind: BindingRequestKind;
  snapshot: string;
  revision: number;
  context: ChannelsTenantContext;
  generation: number;
};

/** Prevent a stale tenant generation from publishing channel state or errors. */
function isCurrentTenantGeneration(
  context: ChannelsTenantContext | null,
  generation: number,
): context is ChannelsTenantContext {
  return Boolean(context && !context.signal.aborted && context.isCurrentGeneration(generation));
}

/** 将稳定后端错误投影为当前渠道页面可展示的 descriptor，拒绝 raw detail 透传。 */
function errorDescriptor(error: unknown, fallbackId: MessageId): MessageDescriptor {
  const descriptor = backendErrorMessageDescriptor(error);
  return descriptor
    ? { id: descriptor.messageId, values: descriptor.values }
    : createMessageDescriptor(fallbackId);
}

/** 将投递状态码显式投影为产品消息；未知 provider 状态保持 raw，禁止动态构造 message ID。 */
function deliveryStatusLabel(
  status: string | undefined,
  translate: Translate,
  fallback: string,
): ReactNode {
  switch (status) {
    case 'delivered':
      return translate('channels.delivery.status.delivered');
    case 'failed':
      return translate('channels.delivery.status.failed');
    case 'pending':
      return translate('channels.delivery.status.pending');
    case 'sending':
      return translate('channels.delivery.status.sending');
    default:
      return status ? <RawIdentifier value={status} /> : fallback;
  }
}

/** 将投递类型码显式投影为产品消息；未知类型作为 provider raw 标识展示。 */
function deliveryKindLabel(kind: string, translate: Translate): ReactNode {
  switch (kind) {
    case 'reply':
      return translate('channels.delivery.kind.reply');
    case 'error_notice':
      return translate('channels.delivery.kind.errorNotice');
    case 'reaction_add':
      return translate('channels.delivery.kind.reactionAdded');
    case 'reaction_remove':
      return translate('channels.delivery.kind.reactionRemoved');
    default:
      return <RawIdentifier value={kind} />;
  }
}

/** 按当前 UI locale 格式化渠道页面的日期时间，并显式使用客户端时区。 */
function formatChannelDateTime(value: string, locale: ReturnType<typeof createFormatters>, fallback: string): string {
  const date = parseBackendDateTime(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return locale.formatDate(date, {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: getClientTimeZone(),
  });
}

/** 为内置渠道生成当前 locale 的展示模型；自定义渠道名作为 raw 业务值保留。 */
function localizedChannelPresentation(
  channel: string,
  configuredName: string | undefined,
  translate: Translate,
) {
  const key = channel.trim().toLowerCase();
  const ids = CHANNEL_PRESENTATION_MESSAGE_IDS[key];
  if (ids) {
    return {
      name: translate(ids.name),
      identifierLabel: translate(ids.identifierLabel),
      userLabel: translate(ids.userLabel),
      blurb: translate(ids.blurb),
      disconnectDescription: translate(ids.disconnectDescription),
    };
  }
  const name = configuredName?.trim() || key || translate('channels.provider.unknown');
  return {
    name,
    identifierLabel: translate('channels.provider.identifierLabel'),
    userLabel: translate('channels.provider.userLabel', { channel: name }),
    blurb: translate('channels.provider.genericBlurb', { channel: name }),
    disconnectDescription: translate('channels.provider.genericDisconnect', { channel: name }),
  };
}

/** 生成由当前 locale 渠道名和本地时间戳组成的默认接入名；时间戳是技术标识而非翻译文本。 */
function defaultBindingName(channelLabel: string): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `${channelLabel}${stamp}`;
}

/** 区分渠道消息的 raw 内容与产品角色 fallback，绝不翻译用户或 Agent 原始正文。 */
function messageDisplay(
  msg: ChannelConversationMessageRead,
  conversation: ChannelConversationRead,
  userLabel: string,
  assistantLabel: string,
): { label: string; content: string; labelIsRaw: boolean } {
  if (msg.role === 'user') {
    if (conversation.is_group) {
      const match = msg.content.match(/^\[发送者:\s*([^\]]+)\]\n?/);
      if (match) return { label: match[1], content: msg.content.slice(match[0].length), labelIsRaw: true };
    }
    return { label: userLabel, content: msg.content, labelIsRaw: false };
  }
  if (msg.role === 'assistant') {
    return {
      label: conversation.agent_name || assistantLabel,
      content: msg.content,
      labelIsRaw: Boolean(conversation.agent_name),
    };
  }
  return { label: msg.role, content: msg.content, labelIsRaw: true };
}

/** 渲染附件原始文件名，并将图片加载状态通过当前 UI locale 本地化。 */
function ChannelAttachmentView({
  attachment,
  bindingId,
  sessionId,
  messageId,
}: {
  attachment: ChannelConversationAttachment;
  bindingId: string;
  sessionId: string;
  messageId: string;
}) {
  const { t } = useAppIntl();
  const tenantContext = useTenantSession();
  const tenantApi = useMemo(() => createTenantClient(tenantContext), [tenantContext]);
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const path = `/api/enterprise/channels/${bindingId}/conversations/${sessionId}/messages/${messageId}/attachments/${attachment.id}`;

  useEffect(() => {
    if (attachment.kind !== 'image') return;
    let disposed = false;
    let objectUrl: string | null = null;
    const context = tenantContext;
    if (!context) return undefined;
    const generation = context.generation;
    setLoading(true);
    void tenantApi.blob(path).then((blob) => {
      objectUrl = URL.createObjectURL(blob);
      if (!disposed && isCurrentTenantGeneration(context, generation)) setUrl(objectUrl);
      else URL.revokeObjectURL(objectUrl);
    }).catch(() => {
      if (!disposed && isCurrentTenantGeneration(context, generation)) setUrl(null);
    }).finally(() => {
      if (!disposed && isCurrentTenantGeneration(context, generation)) setLoading(false);
    });
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment.id, attachment.kind, path, tenantApi, tenantContext]);

  if (attachment.kind === 'image') {
    return url ? (
      <img src={url} alt={attachment.filename} className="max-h-[220px] max-w-[320px] rounded-[8px] object-contain" />
    ) : <span className="text-[12px] text-[#858b9c]">{loading ? t('channels.attachment.loading') : t('channels.attachment.unavailable')}</span>;
  }
  return (
    <button
      type="button"
      className="text-left text-[12px] text-[#3b63c8] underline"
      onClick={() => {
        const context = tenantContext;
        if (!context) return;
        const generation = context.generation;
        void tenantApi.blob(path).then((blob) => {
          if (!isCurrentTenantGeneration(context, generation)) return;
          const objectUrl = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = objectUrl;
          link.download = attachment.filename;
          link.style.display = 'none';
          document.body.appendChild(link);
          link.click();
          link.remove();
          window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
        }).catch(() => {
          // Attachment downloads are best-effort; tenant aborts are silent.
        });
      }}
    >
      <RawIdentifier value={attachment.filename} />
    </button>
  );
}

function isSessionRecovering(binding: ChannelBindingRead): boolean {
  return (
    !binding.connected &&
    binding.status !== 'expired' &&
    Boolean(binding.session_expired ?? binding.config_json?.session_expired)
  );
}

/** 将渠道连接状态映射为当前 locale 的安全产品提示，渠道状态本身仍由后端代码驱动。 */
function attentionText(item: ChannelBindingRead, translate: Translate): string {
  if (item.status === 'expired') {
    return item.channel === 'wechat'
      ? translate('channels.status.tokenExpired')
      : translate('channels.status.connectionUnavailable');
  }
  if (isSessionRecovering(item)) return translate('channels.status.recoveringDescription');
  return translate('channels.status.connectionUnavailable');
}

/** 将投递/会话日期按当前 locale 和客户端时区格式化，非法值使用本地化空值。 */
function formatDay(value: string, locale: ReturnType<typeof createFormatters>, fallback: string): string {
  const date = parseBackendDateTime(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return locale.formatDate(date, { dateStyle: 'medium', timeZone: getClientTimeZone() });
}

/** 按格式化后的本地日期聚合列表，保留每一项的 raw 业务对象不做转换。 */
function groupByDay<T>(
  items: T[],
  getTime: (item: T) => string,
  locale: ReturnType<typeof createFormatters>,
  fallback: string,
): Array<{ day: string; items: T[] }> {
  const groups: Array<{ day: string; items: T[] }> = [];
  items.forEach((item) => {
    const day = formatDay(getTime(item), locale, fallback);
    const last = groups[groups.length - 1];
    if (last && last.day === day) {
      last.items.push(item);
    } else {
      groups.push({ day, items: [item] });
    }
  });
  return groups;
}

/** 渲染渠道治理主页面；产品 chrome 跟随 UI locale，业务内容与 provider 标识保持 raw。 */
export default function ChannelsPage({
  currentUser,
  onLogout,
}: {
  currentUser?: EnterpriseAuthUser;
  onLogout?: () => void;
} = {}) {
  const { locale, t } = useAppIntl();
  const tenantContext = useTenantSession();
  const tenantApi = useMemo(() => createTenantClient(tenantContext), [tenantContext]);
  const toast = useMemo(() => createToastNotifier({ t }), [t]);
  const formatters = useMemo(() => createFormatters(locale), [locale]);
  const noValue = t('channels.placeholder.none');
  const [bindings, setBindings] = useState<ChannelBindingRead[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [deliveriesLoading, setDeliveriesLoading] = useState(false);
  const [deliveryDays, setDeliveryDays] = useState<ChannelDeliveryDay[]>([]);
  const [deliveryTotalDays, setDeliveryTotalDays] = useState(0);
  const [expandedDays, setExpandedDays] = useState<Set<string>>(new Set());
  const [conversations, setConversations] = useState<ChannelConversationRead[]>([]);
  const [conversationsTotal, setConversationsTotal] = useState(0);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const [activeConversation, setActiveConversation] = useState<ChannelConversationRead | null>(null);
  const [messages, setMessages] = useState<ChannelConversationMessageRead[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [channelMetas, setChannelMetas] = useState<ChannelMetaRead[]>([]);
  const [metasLoaded, setMetasLoaded] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createStep, setCreateStep] = useState<'channel' | 'name' | 'agent'>('channel');
  const [createChannel, setCreateChannel] = useState('wechat');
  const [createName, setCreateName] = useState('');
  const [createTarget, setCreateTarget] = useState<'agent' | 'team'>('agent');
  const [createAgentId, setCreateAgentId] = useState('');
  const [createTeamId, setCreateTeamId] = useState('');
  const [teams, setTeams] = useState<TeamRead[]>([]);
  const [teamsLoading, setTeamsLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameTargetId, setRenameTargetId] = useState('');
  const [renameValue, setRenameValue] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [unbindOpen, setUnbindOpen] = useState(false);
  const [unbinding, setUnbinding] = useState(false);
  const [togglingStatus, setTogglingStatus] = useState(false);
  const [agentEditing, setAgentEditing] = useState(false);
  const [agentCandidates, setAgentCandidates] = useState<AgentProfileRead[]>([]);
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(new Set());
  const [defaultAgentId, setDefaultAgentId] = useState('');
  const [savingAgents, setSavingAgents] = useState(false);
  const [autoRouteSaving, setAutoRouteSaving] = useState(false);
  const [tenantUsers, setTenantUsers] = useState<Array<{ id: string; username: string; display_name?: string; source?: string; channel_identities?: Array<{ channel: string; display_name?: string; external_user_id?: string; external_account_scope?: string }> }>>([]);
  const [handoffAssigneeSaving, setHandoffAssigneeSaving] = useState(false);
  const [bindCode, setBindCode] = useState<ChannelBindCodeRead | null>(null);
  const [bindCodeOpen, setBindCodeOpen] = useState(false);
  const [bindCodeLoading, setBindCodeLoading] = useState(false);
  const [bindCodeRemain, setBindCodeRemain] = useState(0);
  const [bindCodeTargetName, setBindCodeTargetName] = useState('');
  const [bindCodeTargetUserId, setBindCodeTargetUserId] = useState<string | undefined>();
  const [identityInviteUserId, setIdentityInviteUserId] = useState('');
  const [identityBindings, setIdentityBindings] = useState<ChannelIdentityBindingRead[]>([]);
  const [unbindIdentityTarget, setUnbindIdentityTarget] =
    useState<ChannelIdentityBindingRead | null>(null);
  const [unbindingIdentity, setUnbindingIdentity] = useState(false);

  const binding = bindings.find((item) => item.id === selectedId) || null;
  const navigate = useNavigate();
  // 身份绑定属于具体渠道账号 scope；同一用户可以分别绑定多个飞书应用。
  const channelIdentities = identityBindings.filter(
    (item) =>
      item.channel === binding?.channel &&
      (item.external_account_scope || '') === (binding?.identity_scope_key || ''),
  );
  const bindingScope = binding?.identity_scope_key || '';
  // 已绑定集合只统计内部成员:渠道懒建账号(外部客户)自带指向自己的身份,
  // 不应计入"邀请成员绑定"的绑定状态。展示与邀请下拉都排除当前用户——
  // 自己的绑定在上方"身份绑定"区有专门入口(绑定/解绑),避免同一人出现两次。
  const identityBoundInternalUserIds = new Set(
    tenantUsers
      .filter(
        (user) =>
          (!user.source || user.source === 'web') &&
          user.channel_identities?.some(
            (identity) =>
              identity.channel === binding?.channel &&
              (identity.external_account_scope || '') === bindingScope,
          ),
      )
      .map((user) => user.id),
  );
  const identityBoundUsers = tenantUsers.filter(
    (user) => identityBoundInternalUserIds.has(user.id) && user.id !== currentUser?.id,
  );
  const identityUnboundUsers = tenantUsers.filter(
    (user) =>
      (!user.source || user.source === 'web') &&
      user.id !== currentUser?.id &&
      !identityBoundInternalUserIds.has(user.id),
  );
  const bindCodeChannelName = binding
    ? channelName(binding.channel)
    : localizedChannelPresentation(createChannel, metaFor(createChannel)?.name, t).name;
  const selectedIdRef = useRef('');
  const bindingRequestRevisionRef = useRef<Record<BindingRequestKind, number>>({
    deliveries: 0,
    conversations: 0,
    messages: 0,
  });

  useEffect(() => {
    selectedIdRef.current = selectedId;
    (Object.keys(bindingRequestRevisionRef.current) as BindingRequestKind[]).forEach((kind) => {
      bindingRequestRevisionRef.current[kind] += 1;
    });
  }, [selectedId]);

  function beginBindingRequest(
    kind: BindingRequestKind,
    snapshot: string,
  ): BindingRequestFence | null {
    const context = tenantContext;
    if (!context) return null;
    const revision = bindingRequestRevisionRef.current[kind] + 1;
    bindingRequestRevisionRef.current[kind] = revision;
    return { kind, snapshot, revision, context, generation: context.generation };
  }

  function isCurrentBindingRequest(request: BindingRequestFence): boolean {
    return request.revision === bindingRequestRevisionRef.current[request.kind]
      && request.snapshot === selectedIdRef.current
      && isCurrentTenantGeneration(request.context, request.generation);
  }

  async function loadTenantUsers() {
    const context = tenantContext;
    if (!context) return;
    const generation = context.generation;
    try {
      const rows = await tenantApi.get<Array<{ id: string; username: string; display_name?: string; source?: string; channel_identities?: Array<{ channel: string; display_name?: string; external_user_id?: string; external_account_scope?: string }> }>>(
        '/api/auth/users?include_channel=true',
      );
      if (!isCurrentTenantGeneration(context, generation)) return;
      setTenantUsers(rows);
    } catch {
      if (!isCurrentTenantGeneration(context, generation)) return;
      setTenantUsers([]);
    }
  }

  useEffect(() => {
    if (!bindCodeOpen || !bindCode) return undefined;
    const update = () => {
      const remain = Math.max(
        0,
        Math.floor((parseBackendDateTime(bindCode.expires_at).getTime() - Date.now()) / 1000),
      );
      setBindCodeRemain(remain);
    };
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [bindCodeOpen, bindCode]);

  useEffect(() => {
    void load();
    void loadIdentityBindings();
    void loadChannelMetas();
    void loadTeams();
    void loadTenantUsers();
  }, [tenantContext?.generation]);

  useEffect(() => {
    // Invalidate every request tied to the previous binding before starting
    // the next pair of detail requests.
    (Object.keys(bindingRequestRevisionRef.current) as BindingRequestKind[]).forEach((kind) => {
      bindingRequestRevisionRef.current[kind] += 1;
    });
    setAgentEditing(false);
    setDeliveryDays([]);
    setDeliveryTotalDays(0);
    setExpandedDays(new Set());
    setConversations([]);
    setConversationsTotal(0);
    setActiveConversation(null);
    setMessages([]);
    if (selectedId) {
      void loadDeliveries(selectedId);
      void loadConversations(selectedId);
    }
  }, [selectedId]);

  /** 加载渠道绑定列表；失败时只展示稳定错误契约映射，不读取异常文本。 */
  async function load() {
    const context = tenantContext;
    if (!context) return;
    const generation = context.generation;
    setLoading(true);
    try {
      const rows = await tenantApi.get<ChannelBindingRead[]>(
        '/api/enterprise/channels',
      );
      if (!isCurrentTenantGeneration(context, generation)) return;
      setBindings(rows);
    } catch (error) {
      if (!isCurrentTenantGeneration(context, generation)) return;
      toast.error(errorDescriptor(error, 'channels.error.loadBindings'));
    } finally {
      if (isCurrentTenantGeneration(context, generation)) setLoading(false);
    }
  }

  /** 加载当前租户的渠道身份绑定；原始外部身份数据只进入业务状态。 */
  async function loadIdentityBindings() {
    const context = tenantContext;
    if (!context) return;
    const generation = context.generation;
    try {
      const rows = await tenantApi.get<ChannelIdentityBindingRead[]>(
        '/api/enterprise/channels/my-identity-bindings',
      );
      if (!isCurrentTenantGeneration(context, generation)) return;
      setIdentityBindings(rows);
    } catch {
      if (!isCurrentTenantGeneration(context, generation)) return;
      setIdentityBindings([]);
    }
  }

  /** 加载渠道能力元数据；provider 字段保持 raw，产品文案在渲染时本地化。 */
  async function loadChannelMetas() {
    const context = tenantContext;
    if (!context) return;
    const generation = context.generation;
    try {
      const rows = await tenantApi.get<ChannelMetaRead[]>(
        '/api/enterprise/channels/meta',
      );
      if (!isCurrentTenantGeneration(context, generation)) return;
      setChannelMetas(rows);
    } catch {
      if (!isCurrentTenantGeneration(context, generation)) return;
      setChannelMetas([]);
    } finally {
      if (isCurrentTenantGeneration(context, generation)) setMetasLoaded(true);
    }
  }

  /** 解除身份绑定并刷新快照，错误通过后端 code/params 安全投影。 */
  async function confirmUnbindIdentity() {
    if (!unbindIdentityTarget) return;
    const context = tenantContext;
    if (!context) return;
    const generation = context.generation;
    setUnbindingIdentity(true);
    try {
      await tenantApi.delete(
        `/api/enterprise/channels/my-identity-bindings/${unbindIdentityTarget.channel}?external_user_id=${encodeURIComponent(unbindIdentityTarget.external_user_id)}&external_account_scope=${encodeURIComponent(unbindIdentityTarget.external_account_scope || '')}`,
      );
      if (!isCurrentTenantGeneration(context, generation)) return;
      toast.success(createMessageDescriptor('channels.identity.unbound'));
      setUnbindIdentityTarget(null);
      await loadIdentityBindings();
    } catch (error) {
      if (!isCurrentTenantGeneration(context, generation)) return;
      toast.error(errorDescriptor(error, 'channels.identity.unbindFailed'));
    } finally {
      if (isCurrentTenantGeneration(context, generation)) setUnbindingIdentity(false);
    }
  }

  /** 将外部账号 scope 映射为本地化标签，scope/app ID 保持 raw 参数。 */
  function scopeLabel(identity: ChannelIdentityBindingRead): string {
    const scope = identity.external_account_scope || '';
    if (!scope) return channelName(identity.channel);
    if (binding?.corp_id && scope === binding.corp_id) {
      return t('channels.identity.scope.company', { scope });
    }
    // 飞书 scope 是"app:{长度}:{appId}:tenant:{长度}:{tenantKey}"技术键,
    // 解析出 appId 展示,避免把整段内部键暴露给用户。
    const feishuAppId = feishuAppIdFromIdentityScope(scope);
    if (feishuAppId) return t('channels.identity.scope.feishuApp', { appId: feishuAppId });
    return t('channels.identity.scope.bot', { scope });
  }

  /** 加载投递日志并按当前选中渠道丢弃过期请求，错误只展示稳定产品文案。 */
  async function loadDeliveries(bindingId: string, offset = 0) {
    const snapshot = selectedId;
    const request = beginBindingRequest('deliveries', snapshot);
    if (!request) return;
    setDeliveriesLoading(true);
    try {
      const page = await tenantApi.get<ChannelDeliveryDayPage>(
        `/api/enterprise/channels/${bindingId}/deliveries/days?offset=${offset}&limit=7`,
      );
      if (!isCurrentBindingRequest(request)) return;
      setDeliveryDays((current) => (offset === 0 ? page.days : [...current, ...page.days]));
      setDeliveryTotalDays(page.total_days);
      if (offset === 0 && page.days.length > 0) {
        setExpandedDays(new Set([page.days[0].date]));
      }
    } catch (error) {
      if (!isCurrentBindingRequest(request)) return;
      toast.error(errorDescriptor(error, 'channels.error.loadDeliveries'));
    } finally {
      if (isCurrentBindingRequest(request)) setDeliveriesLoading(false);
    }
  }

  /** 切换本地日期分组展开状态；date 是后端日期标识，不做语言转换。 */
  function toggleDeliveryDay(date: string) {
    setExpandedDays((current) => {
      const next = new Set(current);
      if (next.has(date)) {
        next.delete(date);
      } else {
        next.add(date);
      }
      return next;
    });
  }

  /** 加载渠道会话列表并保持当前 binding 快照，错误通过稳定契约本地化。 */
  async function loadConversations(bindingId: string, offset = 0) {
    const snapshot = selectedId;
    const request = beginBindingRequest('conversations', snapshot);
    if (!request) return;
    setConversationsLoading(true);
    try {
      const page = await tenantApi.get<PagedResponse<ChannelConversationRead>>(
        `/api/enterprise/channels/${bindingId}/conversations?offset=${offset}&limit=20`,
      );
      if (!isCurrentBindingRequest(request)) return;
      setConversations((current) => (offset === 0 ? page.items : [...current, ...page.items]));
      setConversationsTotal(page.total);
    } catch (error) {
      if (!isCurrentBindingRequest(request)) return;
      toast.error(errorDescriptor(error, 'channels.error.loadConversations'));
    } finally {
      if (isCurrentBindingRequest(request)) setConversationsLoading(false);
    }
  }

  /** 打开一条会话并原样装载消息/附件，raw 业务正文不参与翻译。 */
  async function openConversation(item: ChannelConversationRead) {
    if (!binding) return;
    const snapshot = selectedId;
    const request = beginBindingRequest('messages', snapshot);
    if (!request) return;
    setActiveConversation(item);
    setMessages([]);
    setMessagesLoading(true);
    try {
      const rows = await tenantApi.get<ChannelConversationMessageRead[]>(
        `/api/enterprise/channels/${binding.id}/conversations/${item.session_id}/messages`,
      );
      if (!isCurrentBindingRequest(request)) return;
      setMessages(rows);
    } catch (error) {
      if (!isCurrentBindingRequest(request)) return;
      toast.error(errorDescriptor(error, 'channels.error.loadMessages'));
    } finally {
      if (isCurrentBindingRequest(request)) setMessagesLoading(false);
    }
  }

  /** 加载团队绑定候选；团队名称与成员名称保持 raw。 */
  async function loadTeams() {
    const context = tenantContext;
    if (!context) return;
    const generation = context.generation;
    setTeamsLoading(true);
    try {
      const rows = await tenantApi.get<TeamRead[]>('/api/enterprise/teams');
      if (!isCurrentTenantGeneration(context, generation)) return;
      setTeams(rows);
    } catch {
      // 团队列表仅用于绑定对象选择与名称映射，失败不影响主流程
      if (!isCurrentTenantGeneration(context, generation)) return;
      setTeams([]);
    } finally {
      if (isCurrentTenantGeneration(context, generation)) setTeamsLoading(false);
    }
  }

  /** 返回绑定团队的 raw 显示名，空值使用本地化占位文案。 */
  function teamNameFor(item: ChannelBindingRead): string {
    if (!item.team_id) return '';
    return item.team_name || teams.find((team) => team.id === item.team_id)?.name || t('channels.placeholder.team');
  }

  /** 返回团队负责人 raw 名称；未设置时使用本地化占位文案。 */
  function teamLeaderName(teamId: string): string {
    const team = teams.find((item) => item.id === teamId);
    return team?.members.find((member) => member.role === 'leader')?.agent_name || t('channels.placeholder.unassigned');
  }

  /** 加载可挂载的员工候选并按权限过滤，错误通过稳定错误投影。 */
  async function loadAgentCandidates() {
    const context = tenantContext;
    if (!context) return;
    const generation = context.generation;
    setCandidatesLoading(true);
    try {
      const rows = await tenantApi.get<AgentProfileRead[]>(
        '/api/enterprise/agents',
      );
      if (!isCurrentTenantGeneration(context, generation)) return;
      setAgentCandidates(
        // 整体智能体(开放广场载体)是系统资源池,不是可对外服务的岗位员工,与其他页面一致排除
        rows.filter((item) => !item.is_overall && canManageEmployeeAgent(item, currentUser)),
      );
    } catch (error) {
      if (!isCurrentTenantGeneration(context, generation)) return;
      toast.error(errorDescriptor(error, 'channels.error.loadEmployees'));
    } finally {
      if (isCurrentTenantGeneration(context, generation)) setCandidatesLoading(false);
    }
  }

  /** 打开创建向导并重置选择状态；向导 chrome 始终跟随当前 UI locale。 */
  function openCreate() {
    setCreateStep('channel');
    setCreateChannel(channelMetas[0]?.channel || 'wechat');
    setCreateName('');
    setCreateTarget('agent');
    setCreateAgentId('');
    setCreateTeamId('');
    setCreateOpen(true);
    void loadAgentCandidates();
    void loadTeams();
  }

  /** 创建渠道绑定；员工/团队 ID 是 raw 业务标识，不进入消息键。 */
  async function createBinding() {
    const agentId = createTarget === 'agent' ? createAgentId : '';
    const teamId = createTarget === 'team' ? createTeamId : '';
    if ((!agentId && !teamId) || creating) return;
    const context = tenantContext;
    if (!context) return;
    const generation = context.generation;
    setCreating(true);
    try {
      const created = await tenantApi.post<ChannelBindingRead>('/api/enterprise/channels', {
        // agent_id 与 team_id 互斥，后端二选一
        ...(agentId ? { agent_id: agentId } : { team_id: teamId }),
        channel: createChannel,
        name: createName.trim(),
      });
      if (!isCurrentTenantGeneration(context, generation)) return;
      toast.success(createMessageDescriptor('channels.toast.bindingCreated'));
      setCreateOpen(false);
      setCreateAgentId('');
      setCreateTeamId('');
      setCreateName('');
      await load();
      if (!isCurrentTenantGeneration(context, generation)) return;
      setSelectedId(created.id);
    } catch (error) {
      if (!isCurrentTenantGeneration(context, generation)) return;
      toast.error(errorDescriptor(error, 'channels.error.createBinding'));
    } finally {
      if (isCurrentTenantGeneration(context, generation)) setCreating(false);
    }
  }

  /** 打开接入名称编辑器，用户自定义名称保持原样作为可编辑业务数据。 */
  function openRename(item: ChannelBindingRead) {
    setRenameTargetId(item.id);
    setRenameValue(item.name?.trim() || channelName(item.channel));
    setRenameOpen(true);
  }

  /** 保存用户自定义接入名称；名称值不翻译，仅使用稳定校验文案。 */
  async function confirmRename() {
    const target = bindings.find((item) => item.id === renameTargetId);
    if (!target || renaming) return;
    const name = renameValue.trim();
    if (!name) {
      toast.error(createMessageDescriptor('channels.validation.bindingNameRequired'));
      return;
    }
    const context = tenantContext;
    if (!context) return;
    const generation = context.generation;
    setRenaming(true);
    try {
      const updated = await tenantApi.put<ChannelBindingRead>(
        `/api/enterprise/channels/${target.id}`,
        { name },
      );
      if (!isCurrentTenantGeneration(context, generation)) return;
      setBindings((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
      setRenameOpen(false);
      toast.success(createMessageDescriptor('channels.toast.renamed'));
    } catch (error) {
      if (!isCurrentTenantGeneration(context, generation)) return;
      toast.error(errorDescriptor(error, 'channels.error.renameBinding'));
    } finally {
      if (isCurrentTenantGeneration(context, generation)) setRenaming(false);
    }
  }

  /** 生成本人或内部成员的渠道绑定码，目标名称作为 raw 参数保留。 */
  async function openBindCode(targetUserId?: string) {
    if (bindCodeLoading) return;
    const context = tenantContext;
    if (!context) return;
    const generation = context.generation;
    setBindCodeLoading(true);
    try {
      const target = targetUserId
        ? tenantUsers.find((user) => user.id === targetUserId)
        : currentUser;
      const result = targetUserId && binding
        ? await tenantApi.post<ChannelBindCodeRead>(
            `/api/enterprise/channels/${binding.id}/identity-bind-code`,
            { user_id: targetUserId },
          )
        : await tenantApi.post<ChannelBindCodeRead>(
            '/api/enterprise/channels/bind-code',
          );
      if (!isCurrentTenantGeneration(context, generation)) return;
      setBindCode(result);
      setBindCodeTargetName(target?.display_name || target?.username || t('channels.placeholder.currentUser'));
      setBindCodeTargetUserId(targetUserId);
      setBindCodeOpen(true);
    } catch (error) {
      if (!isCurrentTenantGeneration(context, generation)) return;
      toast.error(errorDescriptor(error, 'channels.error.generateBindCode'));
    } finally {
      if (isCurrentTenantGeneration(context, generation)) setBindCodeLoading(false);
    }
  }

  /** 复制绑定命令并用当前 locale 显示结果，命令本身保持 raw 协议文本。 */
  async function copyBindCommand() {
    if (!bindCode) return;
    try {
      await copyTextToClipboard(`/绑定 ${bindCode.code}`);
      toast.success(createMessageDescriptor('common.toast.copied'));
    } catch {
      toast.error(createMessageDescriptor('common.toast.copyFailed'));
    }
  }

  /** 断开渠道接入并刷新列表；历史数据保留策略由后端执行。 */
  async function confirmUnbind() {
    if (!binding) return;
    const context = tenantContext;
    if (!context) return;
    const generation = context.generation;
    setUnbinding(true);
    try {
      await tenantApi.delete(`/api/enterprise/channels/${binding.id}`);
      if (!isCurrentTenantGeneration(context, generation)) return;
      toast.success(createMessageDescriptor('channels.toast.unbound'));
      setUnbindOpen(false);
      setAgentEditing(false);
      setSelectedId('');
      await load();
    } catch (error) {
      if (!isCurrentTenantGeneration(context, generation)) return;
      toast.error(errorDescriptor(error, 'channels.error.unbindBinding'));
    } finally {
      if (isCurrentTenantGeneration(context, generation)) setUnbinding(false);
    }
  }

  /** 切换渠道启停状态并保留后端稳定状态码，错误使用安全 projector。 */
  async function toggleStatus() {
    if (!binding) return;
    const context = tenantContext;
    if (!context) return;
    const generation = context.generation;
    setTogglingStatus(true);
    try {
      const updated = await tenantApi.post<ChannelBindingRead>(
        `/api/enterprise/channels/${binding.id}/toggle-status`,
      );
      if (!isCurrentTenantGeneration(context, generation)) return;
      setBindings((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      toast.success(createMessageDescriptor(
        updated.status === 'active' ? 'channels.toast.enabled' : 'channels.toast.disabled',
      ));
    } catch (error) {
      if (!isCurrentTenantGeneration(context, generation)) return;
      toast.error(errorDescriptor(error, 'channels.error.toggleStatus'));
    } finally {
      if (isCurrentTenantGeneration(context, generation)) setTogglingStatus(false);
    }
  }

  /** 打开可调度员工编辑状态，并保留已有员工 ID 选择。 */
  function openAgentEdit() {
    const mounted = binding?.agents || [];
    setSelectedAgentIds(new Set(mounted.map((item) => item.agent_id)));
    setDefaultAgentId(
      mounted.find((item) => item.is_default)?.agent_id || mounted[0]?.agent_id || '',
    );
    setAgentEditing(true);
    void loadAgentCandidates();
  }

  /** 切换员工挂载选择并保证默认员工始终属于当前选择集合。 */
  function toggleAgentSelect(agentIdToToggle: string, checked: boolean) {
    const next = new Set(selectedAgentIds);
    if (checked) {
      next.add(agentIdToToggle);
    } else {
      next.delete(agentIdToToggle);
    }
    setSelectedAgentIds(next);
    if (!next.has(defaultAgentId)) {
      setDefaultAgentId(next.values().next().value || '');
    }
  }

  /** 保存可调度员工集合；员工名称与 ID 不进入翻译资源。 */
  async function saveAgents() {
    if (!binding || selectedAgentIds.size === 0 || savingAgents) return;
    const context = tenantContext;
    if (!context) return;
    const generation = context.generation;
    setSavingAgents(true);
    try {
      const updated = await tenantApi.put<ChannelBindingRead>(
        `/api/enterprise/channels/${binding.id}`,
        {
          agents: [...selectedAgentIds].map((id) => ({
            agent_id: id,
            is_default: id === defaultAgentId,
          })),
        },
      );
      if (!isCurrentTenantGeneration(context, generation)) return;
      setBindings((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
      setAgentEditing(false);
      toast.success(createMessageDescriptor('channels.toast.saved'));
    } catch (error) {
      if (!isCurrentTenantGeneration(context, generation)) return;
      toast.error(errorDescriptor(error, 'channels.error.saveEmployees'));
    } finally {
      if (isCurrentTenantGeneration(context, generation)) setSavingAgents(false);
    }
  }

  /** 保存智能分发开关，布尔值是结构化业务参数而非文案。 */
  async function toggleAutoRoute(next: boolean) {
    if (!binding || autoRouteSaving) return;
    const context = tenantContext;
    if (!context) return;
    const generation = context.generation;
    setAutoRouteSaving(true);
    try {
      const updated = await tenantApi.put<ChannelBindingRead>(
        `/api/enterprise/channels/${binding.id}`,
        { auto_route: next },
      );
      if (!isCurrentTenantGeneration(context, generation)) return;
      setBindings((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
      toast.success(createMessageDescriptor('channels.toast.saved'));
    } catch (error) {
      if (!isCurrentTenantGeneration(context, generation)) return;
      toast.error(errorDescriptor(error, 'channels.error.saveAutoRoute'));
    } finally {
      if (isCurrentTenantGeneration(context, generation)) setAutoRouteSaving(false);
    }
  }

  /** 保存默认人工处理人及渠道变体，用户 ID 和渠道 ID 保持 raw 协议值。 */
  async function saveHandoffAssignee(value: string) {
    if (!binding || handoffAssigneeSaving) return;
    const context = tenantContext;
    if (!context) return;
    const generation = context.generation;
    const { userId, channel } = parseHandoffAssigneeValue(value === '__none__' ? '' : value);
    setHandoffAssigneeSaving(true);
    try {
      const updated = await tenantApi.put<ChannelBindingRead>(
        `/api/enterprise/channels/${binding.id}`,
        {
          default_handoff_assignee_user_id: userId || null,
          default_handoff_assignee_channel: userId ? channel : null,
        },
      );
      if (!isCurrentTenantGeneration(context, generation)) return;
      setBindings((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
      toast.success(createMessageDescriptor('channels.toast.saved'));
    } catch (error) {
      if (!isCurrentTenantGeneration(context, generation)) return;
      toast.error(errorDescriptor(error, 'channels.error.saveHandoffAssignee'));
    } finally {
      if (isCurrentTenantGeneration(context, generation)) setHandoffAssigneeSaving(false);
    }
  }

  /** 查找后端渠道元数据；返回对象中的 provider 字段不做翻译。 */
  function metaFor(channel: string): ChannelMetaRead | undefined {
    return channelMetas.find((item) => item.channel === channel);
  }

  /** 返回当前 UI locale 的渠道类型名称；自定义渠道名称保持 raw。 */
  function channelName(channel: string): string {
    return localizedChannelPresentation(channel, metaFor(channel)?.name, t).name;
  }

  /** 返回接入卡片名称字符串，用户自定义名称保持 raw 供编辑/比较使用。 */
  function bindingDisplayName(item: ChannelBindingRead): string {
    return item.name?.trim() || channelName(item.channel);
  }

  /** 渲染接入名称；用户自定义名称是业务内容，内置渠道名称才走产品翻译。 */
  function bindingDisplayNameNode(item: ChannelBindingRead): ReactNode {
    const customName = item.name?.trim();
    return customName ? <RawContent value={customName} /> : channelName(item.channel);
  }

  /** 判断用户自定义名称是否需要同时展示渠道类型标签。 */
  function channelTypeTag(item: ChannelBindingRead): string | null {
    const name = item.name?.trim();
    // 未命名或改回渠道类型名时不重复展示
    if (!name || name === channelName(item.channel)) return null;
    return channelName(item.channel);
  }

  /** 将稳定状态描述投影为当前 locale 文案，未知后端状态仅显示其 raw 标识。 */
  function statusText(status: LocalizedStatus | undefined, fallback: string): string {
    return status?.messageId ? t(status.messageId) : status?.raw || fallback;
  }

  /** 为内置微信客服强制专用 setup，避免旧 metadata 或缺失 metadata 回退到扫码流程。 */
  function setupKindFor(channel: string): string {
    if (channel === 'wechat_kf') return 'wechat_kf';
    return metaFor(channel)?.setup || (channel === 'wechat' ? 'qrcode' : 'credentials');
  }

  /** 将后端 binding 状态映射为 message ID；未知状态保持 raw 标识符。 */
  function bindingStatusFor(item: ChannelBindingRead): LocalizedStatus {
    if (item.status === 'pending' && setupKindFor(item.channel) !== 'qrcode') {
      return { tone: 'blue', messageId: 'channels.status.configurationRequired' };
    }
    return BINDING_STATUS_BADGE[item.status] || {
      tone: 'gray',
      raw: item.status,
    };
  }

  const bindingStatus = binding ? bindingStatusFor(binding) : undefined;
  const attentionBindings = bindings.filter(
    (item) => item.status === 'expired' || (item.status === 'active' && !item.connected),
  );
  const activeChannel = binding
    ? localizedChannelPresentation(binding.channel, metaFor(binding.channel)?.name, t)
    : null;
  // bot_id / ilink_bot_id 是 DTO 顶层字段(后端不回传 config_json)
  const botId = binding?.ilink_bot_id || binding?.bot_id || binding?.app_id || '';
  const mountedAgents = binding?.agents || [];
  const conversationGroups = groupByDay(conversations, (item) => item.updated_at, formatters, noValue);

  const deliveryColumns: DataTableColumn<ChannelDeliveryRead>[] = [
    {
      key: 'time',
      title: t('channels.delivery.column.time'),
      width: 170,
      render: (row) => formatChannelDateTime(row.created_at, formatters, noValue),
    },
    {
      key: 'kind',
      title: t('channels.delivery.column.kind'),
      width: 110,
      render: (row) => {
        return deliveryKindLabel(row.kind, t);
      },
    },
    {
      key: 'status',
      title: t('channels.delivery.column.status'),
      width: 110,
      render: (row) => {
        const preset = DELIVERY_STATUS_BADGE[row.status] || {
          tone: 'gray' as BadgeTone,
          raw: row.status || undefined,
        };
        return <StatusBadge tone={preset.tone}>{deliveryStatusLabel(row.status, t, noValue)}</StatusBadge>;
      },
    },
    {
      key: 'attempts',
      title: t('channels.delivery.column.attempts'),
      width: 90,
      render: (row) => formatters.formatNumber(row.attempts || 0),
    },
    {
      key: 'error',
      title: t('channels.delivery.column.error'),
      className: 'whitespace-normal',
      render: (row) => (
        <span className="wrap-break-word">
          {row.last_error ? <RawContent value={row.last_error} /> : noValue}
        </span>
      ),
    },
  ];

  const listView = (
    <div className="mt-[20px] flex flex-col gap-[16px]">
      {attentionBindings.length > 0 && (
        <div className="flex flex-col gap-[6px] rounded-[12px] border border-[#f3d28b] bg-[#fff8e8] px-[18px] py-[12px] text-[#6f4500]">
          {attentionBindings.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setSelectedId(item.id)}
              className="flex items-center gap-[8px] text-left text-[13px] leading-[20px] transition-opacity hover:opacity-70"
            >
              <IconWarningFill className="size-[14px] shrink-0 text-[#f59e0b]" />
              <span>
                {bindingDisplayNameNode(item)}: {attentionText(item, t)}
              </span>
            </button>
          ))}
        </div>
      )}
      <div className="flex items-center justify-end gap-[8px]">
        <UIButton
          onClick={openCreate}
          className="h-[34px] gap-[4px] rounded-[10px] bg-[#18181a] px-[20px] text-[12px] font-normal text-white hover:bg-[#303030]"
        >
          <IconAdd className="size-[14px]" />
          {t('channels.action.connect')}
        </UIButton>
      </div>
      {bindings.length === 0 && !loading ? (
        <div className="flex min-h-[200px] flex-col items-center justify-center gap-[12px] rounded-[14px] bg-[#f6f6f6] text-[13px] text-[#858b9c]">
          <span>{t('channels.empty.bindings')}</span>
          <UIButton onClick={openCreate} className={PRIMARY_BUTTON_CLASS}>
            {t('channels.action.connect')}
          </UIButton>
        </div>
      ) : (
        <div className="grid gap-[12px]">
          {bindings.map((item) => {
            const status = bindingStatusFor(item);
            return (
              <article
                key={item.id}
                role="button"
                tabIndex={0}
                onClick={() => setSelectedId(item.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    setSelectedId(item.id);
                  }
                }}
                className="flex cursor-pointer flex-col gap-[10px] rounded-[14px] border border-[#eef0f4] bg-white p-[16px] transition-colors hover:border-[#cbd3e6]"
              >
                <div className="flex flex-wrap items-center gap-[10px]">
                  <IconChat className="size-[16px] shrink-0" />
                  <span className="text-[14px] font-semibold text-[#18181a]">
                    {bindingDisplayName(item)}
                  </span>
                  {channelTypeTag(item) && (
                    <span className="rounded-[6px] bg-[#f0f1f5] px-[6px] py-[2px] text-[11px] text-[#858b9c]">
                      {channelTypeTag(item)}
                    </span>
                  )}
                  <StatusBadge tone={status?.tone || 'gray'}>
                    {statusText(status, item.status)}
                  </StatusBadge>
                  {item.status === 'active' && (
                    <span className="text-[12px] text-[#858b9c]">
                      {item.connected
                        ? t('channels.connection.connected')
                        : isSessionRecovering(item)
                          ? t('channels.connection.recovering')
                          : t('channels.connection.disconnected')}
                    </span>
                  )}
                  {canManageBinding(item) && (
                    <UIButton
                      variant="outline"
                      onClick={(event) => {
                        event.stopPropagation();
                        openRename(item);
                      }}
                      onKeyDown={(event) => event.stopPropagation()}
                      className="ml-auto h-[26px] gap-1 rounded-[8px] border-[#e3e7f1] px-[12px] text-[11px] font-normal text-[#464c5e] hover:bg-[#f6f6f6] hover:text-[#18181a]"
                    >
                      {t('channels.action.rename')}
                    </UIButton>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-[10px] text-[12px] text-[#858b9c]">
                  <span>
                    {t('channels.metadata.createdBy')}: {item.created_by_name ? <RawContent value={item.created_by_name} /> : noValue}
                  </span>
                  <span>{formatChannelDateTime(item.created_at, formatters, noValue)}</span>
                </div>
                <div className="flex flex-wrap items-center gap-[6px]">
                  <span className="text-[12px] text-[#858b9c]">
                    {item.team_id ? t('channels.assignment.team') : t('channels.assignment.agents')}
                  </span>
                  {item.team_id ? (
                    <StatusBadge tone="blue">
                      {t('channels.assignment.teamValue', { name: teamNameFor(item) })}
                    </StatusBadge>
                  ) : (item.agents || []).length === 0 ? (
                    <span className="text-[12px] text-[#858b9c]">{t('channels.assignment.noAgents')}</span>
                  ) : (
                    (item.agents || []).map((agent) => (
                      <span
                        key={agent.agent_id}
                        className="inline-flex items-center gap-[6px] rounded-full bg-[#f2f3f7] px-[12px] py-[6px] text-[12px] text-[#18181a]"
                      >
                        <RawContent value={agent.name} />
                        {agent.is_default && <StatusBadge tone="blue">{t('channels.assignment.default')}</StatusBadge>}
                      </span>
                    ))
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );

  const detailView = !binding ? null : (
    <div className="mt-[20px] flex flex-col gap-[24px]">
      <div>
        <UIButton
          variant="outline"
          onClick={() => setSelectedId('')}
          className={OUTLINE_BUTTON_CLASS}
        >
          {t('common.action.back')}
        </UIButton>
      </div>

      <div className="flex flex-col gap-[16px] rounded-[14px] border border-[#eef0f4] p-[16px]">
        <div className="flex flex-wrap items-center justify-between gap-[12px]">
          <div className="flex min-w-0 items-center gap-[10px]">
            <IconChat className="size-[16px] shrink-0" />
            <span className="text-[14px] font-semibold text-[#18181a]">
              {bindingDisplayName(binding)}
            </span>
            {channelTypeTag(binding) && (
              <span className="rounded-[6px] bg-[#f0f1f5] px-[6px] py-[2px] text-[11px] text-[#858b9c]">
                {channelTypeTag(binding)}
              </span>
            )}
            <StatusBadge tone={bindingStatus?.tone || 'gray'}>
              {statusText(bindingStatus, binding.status)}
            </StatusBadge>
            {binding.status === 'active' && (
              <span className="text-[12px] text-[#858b9c]">
                {binding.connected
                  ? t('channels.connection.connected')
                  : isSessionRecovering(binding)
                    ? t('channels.connection.recovering')
                    : t('channels.connection.disconnected')}
              </span>
            )}
            {botId && (
              <span className="truncate text-[12px] text-[#858b9c]">
                {activeChannel?.identifierLabel}: <RawIdentifier value={botId} />
              </span>
            )}
            <span className="truncate text-[12px] text-[#858b9c]">
              {t('channels.metadata.createdBy')}: {binding.created_by_name ? <RawContent value={binding.created_by_name} /> : noValue}
            </span>
            {binding.my_role && (
              <span className="rounded-[6px] bg-[#f0f1f5] px-[6px] py-[2px] text-[11px] text-[#858b9c]">
                {ROLE_LABEL_IDS[binding.my_role]
                  ? t(ROLE_LABEL_IDS[binding.my_role])
                  : <RawIdentifier value={binding.my_role} />}
              </span>
            )}
          </div>
          <div className="flex items-center gap-[8px]">
            {canManageBinding(binding) && (
              <UIButton
                variant="outline"
                onClick={() => openRename(binding)}
                className={OUTLINE_BUTTON_CLASS}
              >
                {t('channels.action.rename')}
              </UIButton>
            )}
            {canManageBinding(binding) && (
              <UIButton
                variant="outline"
                onClick={() => void toggleStatus()}
                disabled={togglingStatus}
                className={OUTLINE_BUTTON_CLASS}
              >
                {binding.status === 'active'
                  ? t('channels.action.disable')
                  : t('channels.action.enable')}
              </UIButton>
            )}
            {canDeleteBinding(binding) && (
              <UIButton
                variant="outline"
                onClick={() => setUnbindOpen(true)}
                className={OUTLINE_BUTTON_CLASS}
              >
                {t('channels.action.disconnect')}
              </UIButton>
            )}
          </div>
        </div>
        {binding.status === 'expired' && setupKindFor(binding.channel) !== 'qrcode' && (
          <span className="text-[12px] text-[#d20b0b]">{t('channels.status.connectionUnavailable')}</span>
        )}
        {binding.channel === 'wechat_kf' ? (
          <WechatKfSetup
            key={binding.id}
            binding={binding}
            onChanged={(updated) =>
              setBindings((current) =>
                current.map((item) => (item.id === updated.id ? updated : item)),
              )
            }
          />
        ) : binding.channel === 'feishu' ? (
          <FeishuSetup
            key={binding.id}
            binding={binding}
            onChanged={(updated) =>
              setBindings((current) =>
                current.map((item) => (item.id === updated.id ? updated : item)),
              )
            }
          />
        ) : binding.channel === 'dingtalk' ? (
          <DingTalkSetup
            key={binding.id}
            binding={binding}
            onChanged={(updated) =>
              setBindings((current) => current.map((item) => (item.id === updated.id ? updated : item)))
            }
          />
        ) : setupKindFor(binding.channel) === 'credentials' ? (
          <WecomSetup
            key={binding.id}
            binding={binding}
            meta={metaFor(binding.channel)}
            onChanged={(updated) =>
              setBindings((current) =>
                current.map((item) => (item.id === updated.id ? updated : item)),
              )
            }
          />
        ) : (
          <WechatSetup binding={binding} onChanged={() => void load()} />
        )}
        <div className="flex items-center justify-between gap-[12px] border-t border-[#eef0f4] pt-[16px]">
          <div className="flex min-w-0 flex-col gap-[4px]">
            <span className="text-[13px] font-semibold text-[#18181a]">{t('channels.routing.title')}</span>
            <span className="text-[12px] leading-[1.6] text-[#858b9c]">
              {t('channels.routing.description')}
            </span>
          </div>
          <Switch
            checked={binding.auto_route ?? true}
            disabled={autoRouteSaving}
            onCheckedChange={(next) => void toggleAutoRoute(next)}
          />
        </div>
        <div className="flex items-center justify-between gap-[12px] border-t border-[#eef0f4] pt-[16px]">
          <div className="flex min-w-0 flex-col gap-[4px]">
            <span className="text-[13px] font-semibold text-[#18181a]">{t('channels.handoff.title')}</span>
            <span className="text-[12px] leading-[1.6] text-[#858b9c]">
              {t('channels.handoff.description')}
            </span>
          </div>
          <div className="flex items-center gap-[8px]">
            {binding.default_handoff_assignee_name && (
              <span className="text-[12px] text-[#858b9c]">
                {t('channels.handoff.current')}: <RawContent value={binding.default_handoff_assignee_name} />{' '}
                {binding.default_handoff_assignee_channel
                  ? t('channels.handoff.channelValue', { channel: channelName(binding.default_handoff_assignee_channel) })
                  : null}
              </span>
            )}
            <Select
              value={
                binding.default_handoff_assignee_user_id
                  ? formatHandoffAssigneeValue(
                    binding.default_handoff_assignee_user_id,
                    binding.default_handoff_assignee_channel,
                  )
                  : '__none__'
              }
              disabled={handoffAssigneeSaving}
              onValueChange={(value) => void saveHandoffAssignee(value)}
            >
              <SelectTrigger className="h-[32px] w-[160px] text-[12px]">
                <SelectValue placeholder={t('channels.handoff.selectAssignee')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">{t('channels.handoff.unconfigured')}</SelectItem>
                {tenantUsers.filter((user) => !user.source || user.source === 'web').flatMap((user) => {
                  const name = user.display_name || user.username || user.id;
                  // 渠道转接通知运行时已支持飞书/企微私聊,渠道标注选项对支持
                  // 私聊通知的绑定渠道生成(后端同样拒绝其他渠道)。
                  const channelVariantAvailable = HANDOFF_NOTIFY_CHANNELS.has(binding.channel);
                  const scope = binding.identity_scope_key || '';
                  const matchingIdentity = user.channel_identities?.find(
                    (ci) => ci.channel === binding.channel && (ci.external_account_scope || '') === scope,
                  );
                  const items = [
                    <SelectItem key={user.id} value={user.id}>
                      {t('channels.handoff.assigneeOption', { name, channel: t('channels.provider.web') })}
                    </SelectItem>,
                  ];
                  const channelVariantConfigured = (
                    binding.default_handoff_assignee_user_id === user.id
                    && binding.default_handoff_assignee_channel === binding.channel
                  );
                  if (channelVariantAvailable && (matchingIdentity || channelVariantConfigured)) {
                    const channelLabel = channelName(binding.channel);
                    items.push(
                      <SelectItem key={`${user.id}::${binding.channel}`} value={`${user.id}::${binding.channel}`}>
                        {t('channels.handoff.assigneeOption', { name, channel: channelLabel })}
                      </SelectItem>,
                    );
                  }
                  return items;
                })}
              </SelectContent>
            </Select>
          </div>
        </div>
        {canDeleteBinding(binding) && (
          <BindingManagers
            bindingId={binding.id}
            users={tenantUsers}
            creatorUserId={binding.created_by_user_id}
          />
        )}
      </div>

      <section aria-label={t('channels.identity.sectionAria')}>
        <div className="mb-[16px] flex items-center gap-[6px] px-[12px] text-[#757f9c]">
          <IconAccount className="size-[14px] shrink-0" />
          <span className="text-[14px] font-normal leading-none">
            {t('channels.identity.title')}
          </span>
        </div>
        <div className="flex flex-col gap-[10px] rounded-[14px] border border-[#eef0f4] p-[16px]">
          {channelIdentities.length > 0 ? (
            channelIdentities.map((identity) => (
              <div
                key={`${identity.channel}_${identity.external_user_id}_${identity.external_account_scope || ''}`}
                className="flex flex-wrap items-center gap-[10px]"
              >
                <StatusBadge tone="green">
                  {t('channels.identity.bound', {
                    name: identity.display_name || identity.external_user_id,
                  })}
                </StatusBadge>
                <span className="rounded-full bg-[#f2f3f7] px-[8px] py-[2px] text-[10px] text-[#858b9c]">
                  {scopeLabel(identity)}
                </span>
                <UIButton
                  variant="outline"
                  onClick={() => setUnbindIdentityTarget(identity)}
                  className={OUTLINE_BUTTON_CLASS}
                >
                  {t('channels.identity.unbind')}
                </UIButton>
              </div>
            ))
          ) : (
            <div className="flex flex-wrap items-center gap-[10px]">
              <UIButton
                variant="outline"
                onClick={() => void openBindCode()}
                disabled={bindCodeLoading}
                className={OUTLINE_BUTTON_CLASS}
              >
                {t('channels.identity.bindSelf', { channel: channelName(binding.channel) })}
              </UIButton>
            </div>
          )}
          {canManageBinding(binding) && binding.channel === 'feishu' && (
            <div className="mt-[4px] flex flex-col gap-[10px] border-t border-[#eef0f4] pt-[12px]">
              <div className="flex flex-col gap-[3px]">
                <span className="text-[12px] font-medium text-[#18181a]">{t('channels.identity.inviteTitle')}</span>
                <span className="text-[11px] leading-[1.6] text-[#858b9c]">
                  {t('channels.identity.inviteDescription')}
                </span>
              </div>
              {identityBoundUsers.length > 0 && (
                <div className="flex flex-wrap gap-[6px]">
                  {identityBoundUsers.map((user) => (
                    <StatusBadge key={user.id} tone="green">
                      {t('channels.identity.boundShort', {
                        name: user.display_name || user.username,
                      })}
                    </StatusBadge>
                  ))}
                </div>
              )}
              {identityUnboundUsers.length > 0 ? (
                <div className="flex flex-wrap items-center gap-[8px]">
                  <SearchableSelect
                    value={identityInviteUserId}
                    onValueChange={setIdentityInviteUserId}
                    options={identityUnboundUsers.map((user) => ({
                      value: user.id,
                      label: user.display_name || user.username || user.id,
                      keywords: [user.username],
                    }))}
                    placeholder={t('channels.identity.selectMember')}
                    searchPlaceholder={t('channels.identity.searchMember')}
                    emptyText={t('channels.identity.noMatchingMember')}
                  />
                  <UIButton
                    variant="outline"
                    disabled={!identityInviteUserId || bindCodeLoading}
                    onClick={() => void openBindCode(identityInviteUserId)}
                    className={OUTLINE_BUTTON_CLASS}
                  >
                    {t('channels.identity.generateCode')}
                  </UIButton>
                </div>
              ) : (
                <span className="text-[11px] text-[#858b9c]">{t('channels.identity.allMembersBound')}</span>
              )}
            </div>
          )}
        </div>
      </section>

      <section aria-label={t('channels.assignment.sectionAria')}>
        <div className="mb-[16px] flex items-center justify-between gap-[6px] px-[12px] text-[#757f9c]">
          <div className="flex items-center gap-[6px]">
            <IconAccount className="size-[14px] shrink-0" />
            <span className="text-[14px] font-normal leading-none">{t('channels.assignment.title')}</span>
          </div>
          {!agentEditing && !binding.team_id && (
            <UIButton variant="outline" onClick={openAgentEdit} className={OUTLINE_BUTTON_CLASS}>
              {t('common.action.edit')}
            </UIButton>
          )}
        </div>
        <p className="mb-[16px] px-[12px] text-[12px] text-[#858b9c]">
          {t('channels.assignment.description')}
        </p>
        {binding.team_id ? (
          <div className="flex flex-wrap items-center gap-[8px] rounded-[14px] border border-[#eef0f4] p-[16px]">
            <span className="text-[13px] text-[#18181a]">
              {t('channels.assignment.teamSummary', {
                team: teamNameFor(binding),
                leader: teamLeaderName(binding.team_id),
              })}
            </span>
          </div>
        ) : agentEditing ? (
          <div className="flex flex-col gap-[12px] rounded-[14px] border border-[#eef0f4] p-[16px]">
            {candidatesLoading ? (
              <span className="py-[12px] text-center text-[12px] text-[#858b9c]">{t('channels.state.loading')}</span>
            ) : agentCandidates.length === 0 ? (
              <span className="py-[12px] text-center text-[12px] text-[#858b9c]">{t('channels.assignment.noAvailableAgents')}</span>
            ) : (
              <RadioGroup
                value={defaultAgentId}
                onValueChange={setDefaultAgentId}
                className="grid gap-[10px]"
              >
                {agentCandidates.map((agent) => {
                  const checked = selectedAgentIds.has(agent.id);
                  return (
                    <div
                      key={agent.id}
                      className="flex items-center gap-[8px] text-[13px] text-[#18181a]"
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(value) => toggleAgentSelect(agent.id, value === true)}
                      />
                      <span className="min-w-0 flex-1 truncate">{employeeDisplayName(agent)}</span>
                      <span className="flex shrink-0 items-center gap-[6px] text-[12px] text-[#858b9c]">
                        <RadioGroupItem value={agent.id} disabled={!checked} />
                        {t('channels.assignment.default')}
                      </span>
                    </div>
                  );
                })}
              </RadioGroup>
            )}
            <div className="flex justify-end gap-[8px]">
              <UIButton
                variant="outline"
                onClick={() => setAgentEditing(false)}
                className={OUTLINE_BUTTON_CLASS}
              >
                {t('common.action.cancel')}
              </UIButton>
              <UIButton
                onClick={() => void saveAgents()}
                disabled={selectedAgentIds.size === 0 || savingAgents}
                className={PRIMARY_BUTTON_CLASS}
              >
                {t('common.action.save')}
              </UIButton>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-[8px] rounded-[14px] border border-[#eef0f4] p-[16px]">
            {mountedAgents.length === 0 ? (
              <span className="text-[12px] text-[#858b9c]">{t('channels.assignment.noAgents')}</span>
            ) : (
              mountedAgents.map((item) => (
                <span
                  key={item.agent_id}
                  className="inline-flex items-center gap-[6px] rounded-full bg-[#f2f3f7] px-[12px] py-[6px] text-[12px] text-[#18181a]"
                >
                  <RawContent value={item.name} />
                  {item.is_default && <StatusBadge tone="blue">{t('channels.assignment.default')}</StatusBadge>}
                </span>
              ))
            )}
          </div>
        )}
      </section>

      <section aria-label={t('channels.commands.sectionAria')}>
        <div className="mb-[16px] flex items-center gap-[6px] px-[12px] text-[#757f9c]">
          <IconChat className="size-[14px] shrink-0" />
          <span className="text-[14px] font-normal leading-none">
            {t('channels.commands.title')}
          </span>
        </div>
        <div className="flex flex-col gap-[8px] rounded-[14px] border border-[#eef0f4] p-[16px]">
          {CHANNEL_COMMANDS.map((item) => (
            <div key={item.command} className="flex flex-wrap items-baseline gap-[8px] text-[12px]">
              <code className="rounded-[6px] bg-[#f2f3f7] px-[8px] py-[3px] text-[#18181a]">
                <RawIdentifier value={item.command} />
              </code>
              <span className="text-[#858b9c]">{t(item.descriptionId)}</span>
            </div>
          ))}
        </div>
      </section>

      <section aria-label={t('channels.conversations.sectionAria')}>
        <div className="mb-[16px] flex items-center gap-[6px] px-[12px] text-[#757f9c]">
          <IconChat className="size-[14px] shrink-0" />
          <span className="text-[14px] font-normal leading-none">
            {t('channels.conversations.title')}
          </span>
        </div>
        {activeConversation ? (
          <div className="flex flex-col gap-[12px] rounded-[14px] border border-[#eef0f4] p-[16px]">
            <div className="flex items-center gap-[10px]">
              <UIButton
                variant="outline"
                onClick={() => setActiveConversation(null)}
                className={OUTLINE_BUTTON_CLASS}
              >
                {t('common.action.back')}
              </UIButton>
              <span className="truncate text-[14px] font-semibold text-[#18181a]">
                {activeConversation.display_name ? (
                  <RawContent value={activeConversation.display_name} />
                ) : (
                  <RawIdentifier value={activeConversation.external_conv_id} />
                )}
              </span>
              {activeConversation.is_group && <StatusBadge tone="blue">{t('channels.conversations.group')}</StatusBadge>}
            </div>
            {messagesLoading ? (
              <div className="py-[24px] text-center text-[12px] text-[#858b9c]">{t('channels.state.loading')}</div>
            ) : messages.length === 0 ? (
              <div className="py-[24px] text-center text-[12px] text-[#858b9c]">{t('channels.conversations.noMessages')}</div>
            ) : (
              <div className="flex max-h-[480px] flex-col gap-[10px] overflow-y-auto pr-[4px]">
                {messages.map((msg) => {
                  const shown = messageDisplay(
                    msg,
                    activeConversation,
                    activeChannel?.userLabel || t('channels.provider.userLabel', { channel: t('channels.provider.unknown') }),
                    t('channels.conversations.agent'),
                  );
                  return (
                    <div key={msg.id} className="flex flex-col gap-[4px]">
                      <span className="text-[11px] text-[#a0a6b8]">
                        {shown.labelIsRaw ? <RawContent value={shown.label} /> : shown.label}
                        {' · '}
                        {formatChannelDateTime(msg.created_at, formatters, noValue)}
                      </span>
                       <div className="wrap-break-word rounded-[10px] bg-[#f6f6f6] px-[12px] py-[8px] text-[13px] leading-[1.6] text-[#18181a]">
                         <RawContent value={shown.content} />
                         {msg.attachments?.length ? (
                           <span className="mt-[8px] flex flex-col gap-[6px]">
                             {msg.attachments.map((attachment) => (
                               <ChannelAttachmentView
                                 key={attachment.id}
                                 attachment={attachment}
                                 bindingId={binding?.id || ''}
                                 sessionId={activeConversation.session_id}
                                 messageId={msg.id}
                               />
                             ))}
                           </span>
                         ) : null}
                       </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : conversationsLoading && conversations.length === 0 ? (
          <div className="rounded-[14px] border border-[#eef0f4] py-[24px] text-center text-[12px] text-[#858b9c]">
            {t('channels.state.loading')}
          </div>
        ) : conversations.length === 0 ? (
          <div className="flex min-h-[120px] items-center justify-center rounded-[14px] bg-[#f6f6f6] text-[13px] text-[#858b9c]">
            {t('channels.conversations.empty')}
          </div>
        ) : (
          <div className="flex flex-col gap-[16px]">
            {conversationGroups.map((group) => (
              <div key={group.day} className="flex flex-col gap-[10px]">
                <span className="px-[4px] text-[12px] font-medium text-[#a0a6b8]">
                  {group.day}
                </span>
                {group.items.map((item) => (
                  <article
                    key={item.session_id}
                    role="button"
                    tabIndex={0}
                    onClick={() => void openConversation(item)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        void openConversation(item);
                      }
                    }}
                    className="flex cursor-pointer flex-col gap-[6px] rounded-[14px] border border-[#eef0f4] bg-white p-[16px] transition-colors hover:border-[#cbd3e6]"
                  >
                    <div className="flex items-center gap-[8px]">
                      <span className="truncate text-[13px] font-semibold text-[#18181a]">
                        {item.display_name ? (
                          <RawContent value={item.display_name} />
                        ) : (
                          <RawIdentifier value={item.external_conv_id} />
                        )}
                      </span>
                      {item.is_group && <StatusBadge tone="blue">{t('channels.conversations.group')}</StatusBadge>}
                      <span className="shrink-0 text-[12px] text-[#858b9c]"><RawContent value={item.agent_name} /></span>
                      <span className="ml-auto shrink-0 text-[12px] text-[#858b9c]">
                        {formatChannelDateTime(item.updated_at, formatters, noValue)}
                      </span>
                    </div>
                    <div className="flex items-center gap-[8px] text-[12px] text-[#858b9c]">
                      <span className="min-w-0 truncate">
                        {item.last_message_preview ? <RawContent value={item.last_message_preview} /> : t('channels.conversations.noMessages')}
                      </span>
                      <span className="ml-auto shrink-0">{t('channels.conversations.messageCount', { count: item.message_count })}</span>
                    </div>
                  </article>
                ))}
              </div>
            ))}
            {conversations.length < conversationsTotal && (
              <div className="flex justify-center">
                <UIButton
                  variant="outline"
                  disabled={conversationsLoading}
                  onClick={() =>
                    binding && void loadConversations(binding.id, conversations.length)
                  }
                  className={OUTLINE_BUTTON_CLASS}
                >
                  {t('channels.conversations.loadMore', {
                    shown: conversations.length,
                    total: conversationsTotal,
                  })}
                </UIButton>
              </div>
            )}
          </div>
        )}
      </section>

      <section aria-label={t('channels.delivery.sectionAria')}>
        <div className="mb-[16px] flex items-center gap-[6px] px-[12px] text-[#757f9c]">
          <IconAlignJustify className="size-[14px] shrink-0" />
          <span className="text-[14px] font-normal leading-none">
            {t('channels.delivery.title')}
          </span>
        </div>
        {deliveryDays.length === 0 ? (
          <DataTable
            aria-label={t('channels.delivery.tableAria')}
            columns={deliveryColumns}
            data={[]}
            rowKey={(row) => row.id}
            loading={deliveriesLoading}
            emptyText={t('channels.delivery.empty')}
            loadingText={t('channels.state.loading')}
            size="compact"
            striped
            bordered
          />
        ) : (
          <div className="flex flex-col gap-[10px]">
            {deliveryDays.map((day) => {
              const expanded = expandedDays.has(day.date);
              return (
                <div
                  key={day.date}
                  className="overflow-hidden rounded-[14px] border border-[#eef0f4]"
                >
                  <button
                    type="button"
                    onClick={() => toggleDeliveryDay(day.date)}
                    className="flex w-full items-center gap-[8px] px-[16px] py-[12px] text-left transition-colors hover:bg-[#fafbfc]"
                  >
                    <IconChevronDown
                      className={cn(
                        'size-[14px] shrink-0 text-[#858b9c] transition-transform',
                        !expanded && '-rotate-90',
                      )}
                    />
                    <span className="text-[13px] font-medium text-[#18181a]">
                      {formatDay(`${day.date}T12:00:00`, formatters, noValue)}
                    </span>
                    <span className="text-[12px] text-[#858b9c]">{t('channels.delivery.itemCount', { count: day.count })}</span>
                  </button>
                  {expanded && (
                    <div className="border-t border-[#eef0f4]">
                      <DataTable
                        aria-label={t('channels.delivery.tableAria')}
                        columns={deliveryColumns}
                        data={day.items}
                        rowKey={(row) => row.id}
                        size="compact"
                        striped
                        bordered
                      />
                    </div>
                  )}
                </div>
              );
            })}
            {deliveryDays.length < deliveryTotalDays && (
              <div className="flex justify-center">
                <UIButton
                  variant="outline"
                  disabled={deliveriesLoading}
                  onClick={() => binding && void loadDeliveries(binding.id, deliveryDays.length)}
                  className={OUTLINE_BUTTON_CLASS}
                >
                  {t('channels.delivery.loadMoreDays', {
                    shown: deliveryDays.length,
                    total: deliveryTotalDays,
                  })}
                </UIButton>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );

  return (
    <div className="min-h-full box-border px-[48px] pt-[32px] pb-[43px] max-[900px]:px-[16px]">
      <AppHeader onLogout={onLogout} userName={currentUser?.username} title={t('channels.title')} />
      {binding ? detailView : listView}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent
          aria-describedby={undefined}
          className="flex max-h-[calc(100dvh-4rem)] w-[calc(100%-2rem)] flex-col gap-[16px] overflow-hidden rounded-[14px] px-[20px] py-[16px] sm:max-w-[480px]"
        >
          <DialogTitle className="text-[14px] font-normal leading-none text-[#757f9c]">
            {createStep === 'channel'
              ? t('channels.create.selectChannel')
              : createStep === 'name'
                ? t('channels.create.nameStep')
                : t('channels.create.targetStep')}
          </DialogTitle>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {createStep === 'channel' ? (
              channelMetas.length === 0 ? (
                <div className="py-[24px] text-center text-[12px] text-[#858b9c]">
                  {metasLoaded ? t('channels.create.noChannels') : t('channels.state.loading')}
                </div>
              ) : (
                <div className="grid gap-[10px]">
                  {channelMetas.map((meta) => {
                    const presentation = localizedChannelPresentation(meta.channel, meta.name, t);
                    return (
                    <article
                      key={meta.channel}
                      role="button"
                      tabIndex={0}
                      onClick={() => {
                        setCreateChannel(meta.channel);
                        setCreateName(defaultBindingName(presentation.name));
                        setCreateStep('name');
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setCreateChannel(meta.channel);
                          setCreateName(defaultBindingName(presentation.name));
                          setCreateStep('name');
                        }
                      }}
                      className="flex cursor-pointer flex-col gap-[6px] rounded-[14px] border border-[#eef0f4] p-[16px] transition-colors hover:border-[#cbd3e6]"
                    >
                      <div className="flex items-center gap-[8px]">
                        <span className="text-[13px] font-semibold text-[#18181a]">
                          {presentation.name}
                        </span>
                      </div>
                      <span className="text-[12px] text-[#858b9c]">
                        {presentation.blurb}
                      </span>
                    </article>
                    );
                  })}
                </div>
              )
            ) : createStep === 'name' ? (
              <div className="flex flex-col gap-[12px]">
                <label className="flex flex-col gap-[6px] text-[12px] text-[#464c5e]">
                  {t('channels.create.nameLabel')}
                  <Input
                    type="text"
                    value={createName}
                    maxLength={BINDING_NAME_MAX_LENGTH}
                    autoComplete="off"
                    data-1p-ignore="true"
                    data-lpignore="true"
                    placeholder={t('channels.create.namePlaceholder')}
                    onChange={(event) => setCreateName(event.target.value)}
                    className="h-8 rounded-[10px] text-[12px]"
                  />
                </label>
                <span className="text-[11px] leading-[1.6] text-[#858b9c]">
                  {t('channels.create.nameHint')}
                </span>
              </div>
            ) : (
              <div className="flex flex-col gap-[12px]">
                <div className="flex rounded-[10px] bg-[#f2f3f7] p-[4px]">
                  {(
                    CREATE_TARGETS
                  ).map((option) => (
                    <button
                      key={option.key}
                      type="button"
                      onClick={() => setCreateTarget(option.key)}
                      className={cn(
                        'flex-1 rounded-[8px] py-[6px] text-[12px] transition-colors',
                        createTarget === option.key
                          ? 'bg-white font-medium text-[#18181a]'
                          : 'text-[#858b9c] hover:text-[#18181a]',
                      )}
                    >
                      {t(option.labelId)}
                    </button>
                  ))}
                </div>
                {createTarget === 'agent' ? (
                  candidatesLoading ? (
                    <div className="py-[24px] text-center text-[12px] text-[#858b9c]">{t('channels.state.loading')}</div>
                  ) : agentCandidates.length === 0 ? (
                    <div className="py-[24px] text-center text-[12px] text-[#858b9c]">
                      {t('channels.assignment.noAvailableAgents')}
                    </div>
                  ) : (
                    <RadioGroup
                      value={createAgentId}
                      onValueChange={setCreateAgentId}
                      className="grid gap-[10px]"
                    >
                      {agentCandidates.map((agent) => (
                        <div
                          key={agent.id}
                          className="flex items-center gap-[8px] text-[13px] text-[#18181a]"
                        >
                          <RadioGroupItem value={agent.id} />
                          <span className="min-w-0 flex-1 truncate">
                            {employeeDisplayName(agent)}
                          </span>
                        </div>
                      ))}
                    </RadioGroup>
                  )
                ) : teamsLoading ? (
                  <div className="py-[24px] text-center text-[12px] text-[#858b9c]">{t('channels.state.loading')}</div>
                ) : teams.length === 0 ? (
                  <div className="flex flex-col items-center gap-[12px] py-[24px] text-[12px] text-[#858b9c]">
                    <span>{t('channels.teams.noAvailable')}</span>
                    <UIButton
                      variant="outline"
                      onClick={() => {
                        setCreateOpen(false);
                        navigate('/enterprise/teams');
                      }}
                      className={OUTLINE_BUTTON_CLASS}
                    >
                      {t('channels.teams.create')}
                    </UIButton>
                  </div>
                ) : (
                  <RadioGroup
                    value={createTeamId}
                    onValueChange={setCreateTeamId}
                    className="grid gap-[10px]"
                  >
                    {teams.map((team) => (
                      <div
                        key={team.id}
                        className="flex items-center gap-[8px] text-[13px] text-[#18181a]"
                      >
                        <RadioGroupItem value={team.id} />
                        <span className="min-w-0 flex-1 truncate"><RawContent value={team.name} /></span>
                        <span className="shrink-0 text-[12px] text-[#858b9c]">
                          {t('channels.teams.leader', {
                            name: team.members.find((member) => member.role === 'leader')?.agent_name || t('channels.placeholder.unassigned'),
                          })}
                        </span>
                        <span className="shrink-0 text-[12px] text-[#858b9c]">
                          {t('channels.teams.memberCount', { count: team.members.length })}
                        </span>
                      </div>
                    ))}
                  </RadioGroup>
                )}
              </div>
            )}
          </div>
          <div className="flex justify-end gap-[8px]">
            {createStep !== 'channel' && (
              <UIButton
                variant="outline"
                onClick={() => setCreateStep(createStep === 'agent' ? 'name' : 'channel')}
                className={OUTLINE_BUTTON_CLASS}
              >
                {createStep === 'agent' ? t('channels.create.backToName') : t('channels.create.backToChannel')}
              </UIButton>
            )}
            <UIButton
              variant="outline"
              onClick={() => setCreateOpen(false)}
              className={OUTLINE_BUTTON_CLASS}
            >
              {t('common.action.cancel')}
            </UIButton>
            {createStep === 'name' && (
              <UIButton
                onClick={() => setCreateStep('agent')}
                disabled={!createName.trim()}
                className={PRIMARY_BUTTON_CLASS}
              >
                {t('channels.create.next')}
              </UIButton>
            )}
            {createStep === 'agent' && (
              <UIButton
                onClick={() => void createBinding()}
                disabled={
                  (createTarget === 'agent' ? !createAgentId : !createTeamId) || creating
                }
                className={PRIMARY_BUTTON_CLASS}
              >
                {t('channels.create.submit', {
                  channel: localizedChannelPresentation(createChannel, metaFor(createChannel)?.name, t).name,
                })}
              </UIButton>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent
          aria-describedby={undefined}
          className="flex w-[calc(100%-2rem)] flex-col gap-[16px] overflow-hidden rounded-[14px] px-[20px] py-[16px] sm:max-w-[420px]"
        >
          <DialogTitle className="text-[14px] font-normal leading-none text-[#757f9c]">
            {t('channels.rename.title')}
          </DialogTitle>
          <label className="flex flex-col gap-[6px] text-[12px] text-[#464c5e]">
            {t('channels.create.nameLabel')}
            <Input
              type="text"
              value={renameValue}
              maxLength={BINDING_NAME_MAX_LENGTH}
              autoComplete="off"
              data-1p-ignore="true"
              data-lpignore="true"
              placeholder={t('channels.create.namePlaceholder')}
              onChange={(event) => setRenameValue(event.target.value)}
              className="h-8 rounded-[10px] text-[12px]"
            />
          </label>
          <div className="flex justify-end gap-[8px]">
            <UIButton
              variant="outline"
              onClick={() => setRenameOpen(false)}
              className={OUTLINE_BUTTON_CLASS}
            >
              {t('common.action.cancel')}
            </UIButton>
            <UIButton
              onClick={() => void confirmRename()}
              disabled={!renameValue.trim() || renaming}
              className={PRIMARY_BUTTON_CLASS}
            >
              {t('common.action.save')}
            </UIButton>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={bindCodeOpen}
        onOpenChange={(open) => {
          setBindCodeOpen(open);
          if (!open) {
            void loadIdentityBindings();
            void loadTenantUsers();
            void load();
          }
        }}
      >
        <DialogContent
          aria-describedby={undefined}
          className="flex w-[calc(100%-2rem)] flex-col gap-[16px] overflow-hidden rounded-[14px] px-[20px] py-[16px] sm:max-w-[420px]"
        >
          <DialogTitle className="text-[14px] font-normal leading-none text-[#757f9c]">
            {t('channels.identity.bindCodeTitle', {
              target: bindCodeTargetName || t('channels.placeholder.member'),
              channel: bindCodeChannelName,
            })}
          </DialogTitle>
          {bindCode && (
            <div className="flex flex-col items-center gap-[12px]">
              <span className="text-[36px] font-semibold tracking-[8px] text-[#18181a]">
                {bindCode.code}
              </span>
              <span className="text-[12px] text-[#858b9c]">
                {bindCodeRemain > 0
                  ? t('channels.identity.bindCodeExpires', {
                    minutes: Math.floor(bindCodeRemain / 60),
                    seconds: bindCodeRemain % 60,
                  })
                  : t('channels.identity.bindCodeExpired')}
              </span>
              <div className="flex items-center gap-[8px] rounded-[10px] bg-[#f6f6f6] px-[12px] py-[8px]">
                <code className="text-[13px] text-[#18181a]">{`/绑定 ${bindCode.code}`}</code>
                <UIButton
                  variant="outline"
                  onClick={() => void copyBindCommand()}
                  className={OUTLINE_BUTTON_CLASS}
                >
                  {t('common.action.copy')}
                </UIButton>
              </div>
              <span className="text-center text-[12px] leading-[1.6] text-[#858b9c]">
                {t('channels.identity.bindCodeInstruction', {
                  target: bindCodeTargetName || t('channels.placeholder.member'),
                  channel: bindCodeChannelName,
                })}
              </span>
              {bindCodeRemain === 0 && (
                <UIButton
                  onClick={() => void openBindCode(bindCodeTargetUserId)}
                  disabled={bindCodeLoading}
                  className={PRIMARY_BUTTON_CLASS}
                >
                  {t('channels.identity.regenerateCode')}
                </UIButton>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={unbindOpen}
        onOpenChange={setUnbindOpen}
        loading={unbinding}
        title={activeChannel
          ? t('channels.confirm.disconnectTitle', { channel: activeChannel.name })
          : t('channels.confirm.disconnectGenericTitle')}
        description={activeChannel?.disconnectDescription || t('channels.confirm.disconnectDescription')}
        confirmText={t('channels.action.disconnect')}
        onConfirm={() => void confirmUnbind()}
      />

      <ConfirmDialog
        open={Boolean(unbindIdentityTarget)}
        onOpenChange={(open) => {
          if (!open) setUnbindIdentityTarget(null);
        }}
        loading={unbindingIdentity}
        title={t('channels.confirm.unbindIdentityTitle')}
        description={t('channels.confirm.unbindIdentityDescription')}
        confirmText={t('channels.identity.unbind')}
        onConfirm={() => void confirmUnbindIdentity()}
      />
    </div>
  );
}
