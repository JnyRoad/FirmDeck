import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
} from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import {
  ApiError,
  SHOW_DEBUG,
  isAuthError,
  streamChatTurn,
  uploadChatAttachments,
  type StreamEvent,
} from '@/api/client';
import { createTenantClient } from '@/api/tenant-client';
import { clearEnterpriseAuthSession } from '@/auth';
import { useTenantSession } from '@/contexts/TenantSessionContext';
import {
  emitAgentScopeChange,
  isTeamScope,
  persistSharedAgentScope,
  readEmployeeScope,
  teamIdFromScope,
  toTeamScope,
} from '@/lib/agent-scope-storage';
import { getClientTimeZone } from '@/lib/timezone';
import {
  agentResourceCount,
  employeeDisplayName,
  employeeProfile,
  visibleChatEmployees,
} from '@/employee';
import { notify } from '@/components/ui/app-toast';
import {
  readAgentReplyLocalePreference,
  resolveLanguageContextSnapshot,
  writeAgentReplyLocalePreference,
} from '@/i18n/languagePreferences';
import { canonicalizeAppLocale, type AppLocale } from '@/i18n/locales';
import type { MessageValues } from '@/i18n/imperative';
import type { MessageId } from '@/i18n/types';
import { useAppIntl } from '@/i18n/useAppIntl';
import { backendEventMessage } from '@/lib/backendEventMessages';
import type {
  AgentProfileRead,
  ChatAttachmentRead,
  ChatSlashCommand,
  ChatMessage,
  ChatSession,
  ChatSessionEventRead,
  ChatTurnResponse,
  HumanHandoffRead,
  KnowledgeCitation,
  ModelConfigRead,
  ScheduledTaskDraftRead,
  ScheduledTaskRead,
  TeamRead,
  TraceLineRead,
  TurnTraceRead,
  UIConfigRead,
} from '@/types';

import {
  CHAT_STREAM_IDLE_TIMEOUT_MS,
  CHAT_STREAM_IDLE_CHECK_INTERVAL_MS,
  CHAT_STREAM_HEARTBEAT_GRACE_MS,
  HIDDEN_GENERAL_SKILL_TRACE_PHASES,
  RUNNING_EVENT_RECOVERY_WINDOW_MS,
  STREAM_TERMINAL_EVENTS,
  attachTurnIdsToServerMessages,
  buildTurnAliasMap,
  canonicalMessageTurnId,
  canonicalTurnIdForValue,
  clipboardContainsComposerImage,
  computeMergedMessages,
  draftConversationKey,
  effectiveMessageTurnId,
  eventTraceTurnId,
  explicitStreamTurnId,
  extractPastedComposerFiles,
  generalSkillTraceDetail,
  generalSkillTraceOutput,
  harnessEventTraceLine,
  hasAssistantCarrierForTurn,
  hasAssistantMessageForTurn,
  hasRenderableStreamingText,
  formatTracePayload,
  hasRecoverableEventProgress,
  hasServerMessageForTurn,
  isDraftConversationKey,
  isKnowledgeTracePhase,
  isMissingChatSessionError,
  isPlainRecord,
  isRecoverableRunningTrace,
  isScheduledSession,
  isStreamingMessageId,
  isTerminalSessionEvent,
  knowledgeResultTraceDetail,
  knowledgeTraceDetail,
  knowledgeTraceLineId,
  knowledgeTraceText,
  latestUserMessageForTurn,
  loadSessionReadTimes,
  mergeTraceLine,
  mergeTurnTraceSnapshot,
  modelStorageKey,
  normalizeMessageText,
  normalizeSessionEventForStream,
  normalizeTraceSkill,
  normalizeTraceTool,
  parseMessageTime,
  persistSessionReadTimes,
  publicStreamPhase,
  reflectionTraceDetail,
  routerDecisionTraceLine,
  sameRoleTurn,
  scheduledDraftForMessage,
  sessionFilterStorageKey,
  shouldDeferPersistedEventToLiveStream,
  shouldKeepRealtimeMessage,
  stepResultTraceLine,
  streamErrorTraceLine,
  streamSkillLabel,
  streamingMessageId,
  timestampAfterMessage,
  toolTraceDetail,
  toRequestAttachment,
  upsertStreamingTracePlaceholder,
  upsertTraceStatusPlaceholder,
} from './chatHelpers';
import {
  createEmptySlot,
  createStreamSlot,
  createTurnTrace,
  type ComposerAttachment,
  type ComposerInteractionMode,
  type SessionSlot,
  type StreamSlot,
  type TraceLine,
  type TurnTrace,
} from './chatTypes';
import {
  chatQueueStorageKey,
  readQueuedChatTurns,
  writeQueuedChatTurns,
  type PreparedChatTurn,
} from './chatQueueStorage';
import { buildSessionFilterOptions } from './sessionFilterOptions';

const CHAT_BASE_PATH = '/workspace/chat';
const STREAM_TEXT_EVENTS = new Set(['stream_replace', 'stream_delta', 'token']);
const STREAM_RELAY_RECOVERY_POLL_INTERVAL_MS = 5 * 1000;
const SCHEDULE_WEEKDAY_IDS = [
  'chat.draft.weekday.monday',
  'chat.draft.weekday.tuesday',
  'chat.draft.weekday.wednesday',
  'chat.draft.weekday.thursday',
  'chat.draft.weekday.friday',
  'chat.draft.weekday.saturday',
  'chat.draft.weekday.sunday',
] as const satisfies readonly MessageId[];
// Shared with the management shell (App.tsx `ENTERPRISE_SIDEBAR_STORAGE_KEY`) so
// the collapse state is preserved when switching between 管理端 and 对话端.
// Stored as '1' (expanded) / '0' (collapsed); unset defaults to expanded.
const ENTERPRISE_SIDEBAR_STORAGE_KEY = 'ultrarag_enterprise_sidebar_expanded';
const MISSING_MODEL_CONFIG_PATTERN = /missing_model_config|missing model config|没有默认模型配置|没有可用模型|模型配置不存在|模型未配置/i;
const MODEL_CONFIGS_UPDATED_EVENT = 'ultrarag-enterprise-model-configs-updated';
const ONBOARDING_SEEN_KEY = 'firmdeck_onboarding_guide_seen';
const QUICK_START_SEEN_KEY = 'firmdeck_quick_start_guide_seen';

function isMissingModelConfigurationError(value: unknown): boolean {
  if (value instanceof ApiError) {
    return MISSING_MODEL_CONFIG_PATTERN.test(`${value.message}\n${value.body}`);
  }
  if (typeof value === 'string') {
    return MISSING_MODEL_CONFIG_PATTERN.test(value);
  }
  if (!value || typeof value !== 'object') return false;
  try {
    return MISSING_MODEL_CONFIG_PATTERN.test(JSON.stringify(value));
  } catch {
    return false;
  }
}

function chatSessionPath(id: string): string {
  return `${CHAT_BASE_PATH}/${id}`;
}

function queuedTurnPreview(turn: PreparedChatTurn): ChatMessage {
  return {
    id: `queued_${turn.turnId}`,
    turnId: turn.turnId,
    role: 'user',
    content: turn.text,
    metadata: {
      queued: true,
      ...(turn.attachments.length ? { attachments: turn.attachments } : {}),
      ...(turn.interactionMode === 'scheduled_task' ? { interaction_mode: 'scheduled_task' } : {}),
    },
    created_at: turn.createdAt,
  };
}

type DraftScheduleType = 'once' | 'daily' | 'weekly' | 'monthly';

const DRAFT_SCHEDULE_TYPES = new Set<DraftScheduleType>(['once', 'daily', 'weekly', 'monthly']);

/** 从定时任务数据中提取稳定的客户端时间值；缺省值属于产品状态而非业务输入。 */
function scheduleTime(schedule: Record<string, unknown>, translate: TranslateMessage): string {
  return typeof schedule.time === 'string' ? schedule.time : translate('chat.draft.defaultTime');
}

/** 将后端计划类型归一化为受支持的产品枚举，未知值安全落到 daily。 */
function normalizeDraftScheduleType(value: unknown): DraftScheduleType {
  if (typeof value !== 'string') return 'daily';
  return DRAFT_SCHEDULE_TYPES.has(value as DraftScheduleType) ? (value as DraftScheduleType) : 'daily';
}

type TranslateMessage = (id: MessageId, values?: MessageValues) => string;

/** 将 canonical status 的 code/params 投影为当前 UI locale；未知或损坏事件安全显示通用状态。 */
function canonicalStatusMessage(
  data: Record<string, unknown>,
  translate: TranslateMessage,
): string | null {
  const hasCode = Object.prototype.hasOwnProperty.call(data, 'code');
  const hasStructuredEnvelope = (
    Object.prototype.hasOwnProperty.call(data, 'event_type')
    && Object.prototype.hasOwnProperty.call(data, 'params')
  );
  if (!hasCode && !hasStructuredEnvelope) return null;

  return backendEventMessage(data.code, data.params, translate, 'chat.trace.thinking');
}

/** 使用当前界面 locale 格式化每周计划，避免在业务代码中固定中文星期或连接符。 */
function formatScheduleWeekdays(value: unknown, locale: AppLocale, translate: TranslateMessage): string {
  if (!Array.isArray(value)) return translate(SCHEDULE_WEEKDAY_IDS[0]);
  const labels = value
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item >= 0 && item < SCHEDULE_WEEKDAY_IDS.length)
    .map((item) => translate(SCHEDULE_WEEKDAY_IDS[item]));
  return labels.length ? new Intl.ListFormat(locale, { type: 'conjunction' }).format(labels) : translate(SCHEDULE_WEEKDAY_IDS[0]);
}

/** 将计划数据转换为本地化产品摘要；计划中的时间、日期和值保持原始业务语义。 */
function formatScheduledTaskDraftSchedule(
  draft: Partial<ScheduledTaskDraftRead> | Record<string, unknown> | undefined,
  locale: AppLocale,
  translate: TranslateMessage,
): string {
  const schedule = draft?.schedule && typeof draft.schedule === 'object' && !Array.isArray(draft.schedule)
    ? draft.schedule as Record<string, unknown>
    : {};
  const scheduleType = normalizeDraftScheduleType(draft?.schedule_type);
  if (scheduleType === 'once') {
    return translate('chat.draft.onceSchedule', {
      runAt: typeof schedule.run_at === 'string' ? schedule.run_at : translate('chat.draft.pendingTime'),
    });
  }
  if (scheduleType === 'weekly') {
    return translate('chat.draft.weeklySchedule', {
      weekdays: formatScheduleWeekdays(schedule.weekdays, locale, translate),
      time: scheduleTime(schedule, translate),
    });
  }
  if (scheduleType === 'monthly') {
    const day = typeof schedule.day_of_month === 'number' || typeof schedule.day_of_month === 'string'
      ? schedule.day_of_month
      : 1;
    return translate('chat.draft.monthlySchedule', { day, time: scheduleTime(schedule, translate) });
  }
  return translate('chat.draft.dailySchedule', { time: scheduleTime(schedule, translate) });
}

/** 生成定时任务 trace 详情，标题作为原始业务值仅通过具名参数插入消息。 */
function scheduledTaskDraftTraceDetail(
  draft: Partial<ScheduledTaskDraftRead> | Record<string, unknown> | undefined,
  locale: AppLocale,
  translate: TranslateMessage,
): string | undefined {
  const title = typeof draft?.title === 'string' ? draft.title.trim() : '';
  return translate('chat.draft.traceDetail', {
    title: title || translate('chat.draft.untitled'),
    schedule: formatScheduledTaskDraftSchedule(draft, locale, translate),
    status: translate('chat.draft.waitingConfirmation'),
  });
}

/** 构造定时任务的可展开 trace，产品 chrome 使用语义消息，业务标题/时间保持 raw。 */
function scheduledTaskTraceLines(
  draft: Partial<ScheduledTaskDraftRead> | Record<string, unknown> | undefined,
  locale: AppLocale,
  translate: TranslateMessage,
): TraceLine[] {
  return [
    {
      id: 'scheduled_task_intent',
      kind: 'decision',
      text: translate('chat.draft.traceIntent'),
      detail: translate('chat.draft.traceIntentDetail'),
      state: 'completed',
      icon: 'judge',
    },
    {
      id: 'scheduled_task_parse',
      kind: 'decision',
      text: translate('chat.draft.traceParse'),
      detail: translate('chat.draft.tracePlan', {
        schedule: formatScheduledTaskDraftSchedule(draft, locale, translate),
      }),
      state: 'completed',
      icon: 'advance',
    },
    {
      id: 'scheduled_task_draft',
      kind: 'decision',
      text: translate('chat.draft.traceDraft'),
      detail: scheduledTaskDraftTraceDetail(draft, locale, translate),
      state: 'completed',
      icon: 'advance',
    },
  ];
}

/** 为流式定时任务阶段返回当前 locale 的 trace 行，未知阶段不改变既有协议行为。 */
function scheduledTaskStatusTraceLine(
  phase: string,
  data: Record<string, unknown>,
  locale: AppLocale,
  translate: TranslateMessage,
): TraceLine | null {
  if (phase === 'scheduled_task_intent') {
    return {
      id: 'scheduled_task_intent',
      kind: 'decision',
      text: translate('chat.draft.traceIntent'),
      detail: translate('chat.draft.traceIntentDetail'),
      state: 'running',
      icon: 'judge',
    };
  }
  if (phase === 'scheduled_task_parse') {
    return {
      id: 'scheduled_task_parse',
      kind: 'decision',
      text: translate('chat.draft.traceParse'),
      state: 'running',
      icon: 'advance',
    };
  }
  if (phase === 'scheduled_task_draft') {
    return {
      id: 'scheduled_task_draft',
      kind: 'decision',
      text: translate('chat.draft.traceDraft'),
      detail: scheduledTaskDraftTraceDetail(data, locale, translate),
      state: 'completed',
      icon: 'advance',
    };
  }
  return null;
}

const LEGACY_SCHEDULED_TRACE_CODES = {
  scheduled_task_intent: 'chat.scheduled.intent',
  scheduled_task_parse: 'chat.scheduled.plan',
  scheduled_task_draft: 'chat.scheduled.draft',
} as const;

/** 将持久化计划任务轨迹按当前 UI locale 投影；后端旧 text/detail 不再作为产品文案来源。 */
function localizedPersistedTraceLine(
  line: TraceLineRead,
  locale: AppLocale,
  translate: TranslateMessage,
): { text: string; detail?: string } {
  const legacyCode = LEGACY_SCHEDULED_TRACE_CODES[
    line.id as keyof typeof LEGACY_SCHEDULED_TRACE_CODES
  ];
  const eventCode = typeof line.event_code === 'string' ? line.event_code : legacyCode;
  if (!eventCode) {
    return {
      text: line.text || translate('chat.trace.thinking'),
      ...(line.detail ? { detail: line.detail } : {}),
    };
  }

  const scheduledEvent = Object.values(LEGACY_SCHEDULED_TRACE_CODES).includes(
    eventCode as (typeof LEGACY_SCHEDULED_TRACE_CODES)[keyof typeof LEGACY_SCHEDULED_TRACE_CODES],
  );
  if (!scheduledEvent) {
    return {
      text: backendEventMessage(eventCode, line.params || {}, translate, 'chat.trace.thinking'),
    };
  }

  const data = line.event_data && typeof line.event_data === 'object' && !Array.isArray(line.event_data)
    ? line.event_data
    : {};
  let detail: string | undefined;
  if (eventCode === 'chat.scheduled.intent') {
    detail = translate('chat.draft.traceIntentDetail');
  } else if (eventCode === 'chat.scheduled.plan') {
    detail = translate('chat.draft.tracePlan', {
      schedule: formatScheduledTaskDraftSchedule(data, locale, translate),
    });
  } else {
    detail = scheduledTaskDraftTraceDetail(data, locale, translate);
  }
  return {
    text: backendEventMessage(eventCode, line.params || {}, translate, 'chat.trace.thinking'),
    ...(detail ? { detail } : {}),
  };
}

export type UseChatSession = ReturnType<typeof useChatSession>;

export type UseChatSessionOptions = {
  /**
   * Anonymous mode for the public site embed: never redirect to login on a
   * missing/expired session (auth-only data simply stays empty). Without this
   * the hook bounces unauthenticated visitors off the page via
   * `window.location.href = '/'`.
   */
  anonymous?: boolean;
  /** Use a concrete session outside the workspace chat route (for example a team room). */
  sessionId?: string;
  /** Keep navigation and shared employee scope owned by the embedding page. */
  embedded?: boolean;
};

/** 管理聊天会话状态、流式事件和界面消息；所有产品文案均通过语义消息 ID 解析。 */
export function useChatSession(options: UseChatSessionOptions = {}) {
  const { anonymous = false, embedded = false } = options;
  const { locale, t } = useAppIntl();
  const { sessionId: routeSessionId, draftAgentId } = useParams<{ sessionId?: string; draftAgentId?: string }>();
  const sessionId = options.sessionId || routeSessionId;
  const navigate = useNavigate();
  const tenantContext = useTenantSession();
  const tenantClient = useMemo(() => createTenantClient(tenantContext), [tenantContext]);
  const auth = tenantContext?.session || null;
  const tenantId = tenantContext?.tenantId || '';
  const userId = tenantContext?.userId || '';
  const [agentReplyLocalePreference, setAgentReplyLocalePreference] = useState<AppLocale>(() => (
    readAgentReplyLocalePreference(window.localStorage, `${tenantId}:${userId}`)
  ));
  const queueStorageKey = tenantId && userId ? chatQueueStorageKey(tenantId, userId) : '';
  const [restoredQueuedTurns] = useState(() => (
    queueStorageKey ? readQueuedChatTurns(window.sessionStorage, queueStorageKey) : []
  ));
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionReadTimes, setSessionReadTimes] = useState<Record<string, string>>(() => (
    tenantId && userId ? loadSessionReadTimes(tenantId, userId) : {}
  ));
  const [agents, setAgents] = useState<AgentProfileRead[]>([]);
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  const [teams, setTeams] = useState<TeamRead[]>([]);
  const [teamEmptyStats, setTeamEmptyStats] = useState<{ tasks: number; blackboard: number }>({ tasks: 0, blackboard: 0 });
  const [selectedAgentId, setSelectedAgentId] = useState(() => (
    tenantId && userId ? readEmployeeScope(tenantId, userId) : ''
  ));
  const [sessionAgentFilter, setSessionAgentFilter] = useState(() => (
    tenantId && userId
      ? window.localStorage.getItem(sessionFilterStorageKey(tenantId, userId))
        || readEmployeeScope(tenantId, userId)
        || 'all'
      : 'all'
  ));
  const [modelConfigs, setModelConfigs] = useState<ModelConfigRead[]>([]);
  const [selectedModelConfigId, setSelectedModelConfigId] = useState(
    () => tenantId && userId ? window.localStorage.getItem(modelStorageKey(tenantId, userId)) || '' : '',
  );
  const [modelConfigsLoading, setModelConfigsLoading] = useState(Boolean(auth));
  const [modelConfigsLoadError, setModelConfigsLoadError] = useState('');
  const [modelSetupOpen, setModelSetupOpen] = useState(false);
  const [input, setInput] = useState('');
  const [slashCommands, setSlashCommands] = useState<ChatSlashCommand[]>([]);
  const [composerAttachments, setComposerAttachments] = useState<ComposerAttachment[]>([]);
  const [composerDragActive, setComposerDragActive] = useState(false);
  const [composerPlusOpen, setComposerPlusOpen] = useState(false);
  const [composerIntent, setComposerIntent] = useState<Exclude<ComposerInteractionMode, 'normal'> | null>(null);
  const [lastTurn, setLastTurn] = useState<ChatTurnResponse | null>(null);
  const [renameSession, setRenameSession] = useState<ChatSession | null>(null);
  const [renameTitle, setRenameTitle] = useState('');
  const [pendingDelete, setPendingDelete] = useState<ChatSession | null>(null);
  const [storeTick, setStoreTick] = useState(0);
  const [streamTick, setStreamTick] = useState(0);
  const [traceTick, setTraceTick] = useState(0);
  const [feedbackTick, setFeedbackTick] = useState(0);
  const [queuedTurnsTick, setQueuedTurnsTick] = useState(0);
  const [expandedTraceIds, setExpandedTraceIds] = useState<string[]>([]);
  const [collapsedTraceIds, setCollapsedTraceIds] = useState<string[]>([]);
  const [scheduledDrafts, setScheduledDrafts] = useState<Record<string, ScheduledTaskDraftRead>>({});
  const [createdScheduledTasks, setCreatedScheduledTasks] = useState<Record<string, ScheduledTaskRead>>({});
  const [dismissedDraftMessageIds, setDismissedDraftMessageIds] = useState<string[]>([]);
  const persistChatSessionAgentFilter = useCallback((value: string) => {
    const next = value || 'all';
    setSessionAgentFilter(next);
    if (tenantId && userId) {
      window.localStorage.setItem(sessionFilterStorageKey(tenantId, userId), next);
    }
  }, [tenantId, userId]);
  /** 更新当前用户的新会话回复语言偏好；既有 session 的权威快照不会被此操作改写。 */
  const setAgentReplyLocale = useCallback((nextLocale: AppLocale) => {
    setAgentReplyLocalePreference(nextLocale);
    if (userId) writeAgentReplyLocalePreference(window.localStorage, `${tenantId}:${userId}`, nextLocale);
  }, [tenantId, userId]);
  const [activeCitation, setActiveCitation] = useState<KnowledgeCitation | null>(null);
  const [handoffs, setHandoffs] = useState<HumanHandoffRead[]>([]);
  const [handoffsLoading, setHandoffsLoading] = useState(false);
  const [showHandoffInbox, setShowHandoffInbox] = useState(false);
  const [handoffReplies, setHandoffReplies] = useState<Record<string, string>>({});
  const [isComposing, setIsComposing] = useState(false);
  const [runningTurn, setRunningTurn] = useState<{ sessionId: string; turnId: string } | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => (
    window.localStorage.getItem(ENTERPRISE_SIDEBAR_STORAGE_KEY) === '0'
  ));
  const [uiConfig, setUiConfig] = useState<UIConfigRead>({
    tenant_id: tenantId,
    show_thinking_trace: true,
    show_skill_trace: true,
    show_tool_trace: true,
    reflection_max_rounds: 1,
    agent_loop_max_actions: 32,
    context_token_budget: 32_000,
    context_compaction_trigger_ratio: 0.7,
    context_recent_round_limit: 6,
    context_long_summary_token_budget: 4_000,
    context_medium_summary_token_budget: 4_000,
    context_allowed_roles: ['user', 'assistant'],
    context_long_summary_prefix: '历史的信息可以被总结为：',
    context_medium_summary_prefix: '近期的历史信息总结为：',
    sandbox_enabled: false,
    harness_storage_path: '',
    effective_harness_storage_path: '',
    sandbox_network_mode: 'all',
    sandbox_allowed_domains: [],
    updated_at: '',
  });
  const chatMessagesRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isChatProgrammaticScrollRef = useRef(false);
  const isChatStickyToBottomRef = useRef(true);
  const lastActiveConversationIdRef = useRef<string | null>(null);
  const lastDisplayedMessageCountRef = useRef(0);
  const terminalTurnSyncRef = useRef(new Map<string, { startedAt: number; timer: number | null }>());
  const storeRef = useRef(new Map<string, SessionSlot>());
  const streamRef = useRef(new Map<string, StreamSlot>());
  const turnTraceRef = useRef(new Map<string, TurnTrace>());
  const locallyCancelledSessionIdsRef = useRef(new Set<string>());
  const scheduledEventIdsRef = useRef(new Set<string>());
  const scheduledEventPollsRef = useRef(new Map<string, Promise<void>>());
  const knownSessionIdsRef = useRef(new Set<string>());
  const optimisticSessionIdsRef = useRef(new Set<string>());
  const pendingPromotedSessionIdRef = useRef<string | null>(null);
  const queuedTurnsRef = useRef<PreparedChatTurn[]>(restoredQueuedTurns);
  const queuedTurnProcessingRef = useRef(false);
  const queuedTurnPreviewsRestoredRef = useRef(false);
  const sessionsInitializedRef = useRef(false);
  const autoOpenedSessionIdsRef = useRef(new Set<string>());
  const loadErrorNoticeRef = useRef<Record<string, number>>({});
  const uploadControllersRef = useRef(new Map<string, AbortController>());
  const workspaceControllerRef = useRef<AbortController | null>(null);
  const workspaceGenerationRef = useRef(0);

  const notifyStore = useCallback(() => setStoreTick((value) => value + 1), []);
  const notifyStream = useCallback(() => setStreamTick((value) => value + 1), []);
  const notifyTrace = useCallback(() => setTraceTick((value) => value + 1), []);
  const notifyFeedback = useCallback(() => setFeedbackTick((value) => value + 1), []);
  const notifyQueue = useCallback(() => setQueuedTurnsTick((value) => value + 1), []);
  const persistQueuedTurns = useCallback(() => (
    writeQueuedChatTurns(window.sessionStorage, queueStorageKey, queuedTurnsRef.current)
  ), [queueStorageKey]);

  /**
   * Own one abort fence for the mounted workspace. The provider's signal
   * handles tenant replacement; this local controller also handles a chat
   * subtree being removed while the surrounding tenant shell remains mounted.
   */
  useEffect(() => {
    const previousController = workspaceControllerRef.current;
    previousController?.abort();
    const controller = new AbortController();
    const generation = tenantContext?.generation ?? 0;
    workspaceControllerRef.current = controller;
    workspaceGenerationRef.current = generation;
    const onTenantAbort = () => controller.abort();
    tenantContext?.signal.addEventListener('abort', onTenantAbort, { once: true });

    // A new verified tenant generation starts with no in-memory state from the
    // previous tenant, even when the hook instance itself is retained by an
    // embedding page.
    setSessions([]);
    setSessionsLoading(Boolean(tenantContext));
    setAgents([]);
    setAgentsLoaded(false);
    setTeams([]);
    setTeamEmptyStats({ tasks: 0, blackboard: 0 });
    setHandoffs([]);
    setHandoffsLoading(Boolean(tenantContext));
    setScheduledDrafts({});
    setCreatedScheduledTasks({});
    setDismissedDraftMessageIds([]);
    setHandoffReplies({});
    setSessionReadTimes(
      tenantId && userId ? loadSessionReadTimes(tenantId, userId) : {},
    );
    setAgentReplyLocalePreference(
      readAgentReplyLocalePreference(window.localStorage, `${tenantId}:${userId}`),
    );
    setSelectedAgentId(tenantId && userId ? readEmployeeScope(tenantId, userId) : '');
    setSessionAgentFilter(
      tenantId && userId
        ? window.localStorage.getItem(sessionFilterStorageKey(tenantId, userId))
          || readEmployeeScope(tenantId, userId)
          || 'all'
        : 'all',
    );
    setSelectedModelConfigId(
      tenantId && userId ? window.localStorage.getItem(modelStorageKey(tenantId, userId)) || '' : '',
    );
    setModelConfigs([]);
    setModelConfigsLoadError('');
    setModelConfigsLoading(Boolean(tenantContext));
    setSlashCommands([]);
    setComposerAttachments([]);
    setInput('');
    setComposerIntent(null);
    setLastTurn(null);
    setRenameSession(null);
    setPendingDelete(null);
    setActiveCitation(null);
    setRunningTurn(null);
    setUiConfig((current) => ({ ...current, tenant_id: tenantId }));
    storeRef.current.clear();
    streamRef.current.clear();
    turnTraceRef.current.clear();
    knownSessionIdsRef.current.clear();
    optimisticSessionIdsRef.current.clear();
    locallyCancelledSessionIdsRef.current.clear();
    scheduledEventIdsRef.current.clear();
    scheduledEventPollsRef.current.clear();
    autoOpenedSessionIdsRef.current.clear();
    pendingPromotedSessionIdRef.current = null;
    queuedTurnsRef.current = tenantId && userId
      ? readQueuedChatTurns(window.sessionStorage, chatQueueStorageKey(tenantId, userId))
      : [];
    queuedTurnProcessingRef.current = false;
    queuedTurnPreviewsRestoredRef.current = false;
    sessionsInitializedRef.current = false;

    return () => {
      tenantContext?.signal.removeEventListener('abort', onTenantAbort);
      controller.abort();
      if (workspaceControllerRef.current === controller) workspaceControllerRef.current = null;
      uploadControllersRef.current.forEach((item) => item.abort());
      uploadControllersRef.current.clear();
      streamRef.current.forEach((item) => {
        item.abortController?.abort();
        if (item.timer) window.clearTimeout(item.timer);
        item.abortController = null;
        item.timer = null;
      });
      terminalTurnSyncRef.current.forEach((item) => {
        if (item.timer) window.clearTimeout(item.timer);
      });
      terminalTurnSyncRef.current.clear();
      scheduledEventPollsRef.current.clear();
      storeRef.current.clear();
      streamRef.current.clear();
      turnTraceRef.current.clear();
      queuedTurnsRef.current = [];
      queuedTurnProcessingRef.current = false;
      pendingPromotedSessionIdRef.current = null;
    };
  }, [tenantContext?.generation, tenantContext?.signal, tenantId, userId]);

  const redirectToLogin = useCallback(() => {
    if (anonymous) return;
    clearEnterpriseAuthSession();
    window.location.href = '/';
  }, [anonymous]);

  const workspaceSignal = useCallback(
    () => workspaceControllerRef.current?.signal || tenantContext?.signal,
    [tenantContext],
  );
  const isWorkspaceCurrent = useCallback(() => {
    const controller = workspaceControllerRef.current;
    const generation = tenantContext?.generation ?? 0;
    return Boolean(
      controller
      && !controller.signal.aborted
      && workspaceGenerationRef.current === generation
      && (!tenantContext || tenantContext.isCurrentGeneration(generation)),
    );
  }, [tenantContext]);

  const updateChatStickiness = useCallback(() => {
    const element = chatMessagesRef.current;
    if (!element) return;
    const remainingScroll = element.scrollHeight - element.clientHeight - element.scrollTop;
    isChatStickyToBottomRef.current = remainingScroll <= 96;
  }, []);

  const finishProgrammaticChatScroll = useCallback(() => {
    window.requestAnimationFrame(() => {
      updateChatStickiness();
      isChatProgrammaticScrollRef.current = false;
    });
  }, [updateChatStickiness]);

  const handleChatMessagesScroll = useCallback(() => {
    if (isChatProgrammaticScrollRef.current) return;
    updateChatStickiness();
  }, [updateChatStickiness]);

  /** 将请求异常收敛为稳定的界面错误消息；原始异常只进入诊断日志，不直出用户界面。 */
  const notifyRequestError = useCallback((scope: string, error: unknown, fallbackId: MessageId) => {
    if (!isWorkspaceCurrent()) return false;
    if (isAuthError(error)) {
      redirectToLogin();
      return true;
    }
    console.error('[chat] request failed', { scope, error });
    const isNetworkError = error instanceof TypeError;
    const noticeKey = isNetworkError ? 'chat-network-error' : `chat-${scope}-error`;
    const now = Date.now();
    const lastShownAt = loadErrorNoticeRef.current[noticeKey] || 0;
    if (now - lastShownAt < 12000) return false;
    loadErrorNoticeRef.current[noticeKey] = now;
    let localizedMessage = t('common.error.generic');
    if (isNetworkError) {
      localizedMessage = t('chat.error.network');
    } else {
      switch (fallbackId) {
        case 'chat.error.sessionsLoad':
          localizedMessage = t('chat.error.sessionsLoad');
          break;
        case 'chat.error.messagesLoad':
          localizedMessage = t('chat.error.messagesLoad');
          break;
        case 'chat.error.traceLoad':
          localizedMessage = t('chat.error.traceLoad');
          break;
        case 'chat.error.handoffsLoad':
          localizedMessage = t('chat.error.handoffsLoad');
          break;
        default:
          break;
      }
    }
    notify.error(localizedMessage, {
      id: noticeKey,
      duration: 3000,
    });
    return false;
  }, [isWorkspaceCurrent, redirectToLogin, t]);

  const scrollChatToBottom = useCallback((options?: { preserveShortContentTop?: boolean; force?: boolean }) => {
    const element = chatMessagesRef.current;
    if (!element) return;
    if (!options?.force && !isChatStickyToBottomRef.current) return;
    const targetScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    const shortContentGuard = Math.min(520, element.clientHeight * 0.72);
    isChatProgrammaticScrollRef.current = true;
    if (options?.preserveShortContentTop && targetScrollTop <= shortContentGuard) {
      element.scrollTop = 0;
      finishProgrammaticChatScroll();
      return;
    }
    window.requestAnimationFrame(() => {
      element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
      window.requestAnimationFrame(() => {
        element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
        finishProgrammaticChatScroll();
      });
    });
  }, [finishProgrammaticChatScroll]);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((current) => {
      const next = !current;
      window.localStorage.setItem(ENTERPRISE_SIDEBAR_STORAGE_KEY, next ? '0' : '1');
      return next;
    });
  }, []);

  const markSessionRead = useCallback((id: string, timestamp?: string) => {
    if (!id) return;
    const value = timestamp || new Date().toISOString();
    setSessionReadTimes((current) => {
      const currentTime = Date.parse(current[id] || '');
      const nextTime = Date.parse(value);
      if (Number.isFinite(currentTime) && Number.isFinite(nextTime) && currentTime >= nextTime) {
        return current;
      }
      const next = { ...current, [id]: value };
      persistSessionReadTimes(tenantId, userId, next);
      return next;
    });
  }, [tenantId, userId]);

  const currentSession = sessionId ? sessions.find((item) => item.id === sessionId) || null : null;
  const sessionAgentReplyLocale = canonicalizeAppLocale(currentSession?.agent_reply_locale);
  const agentReplyLocale = sessionAgentReplyLocale ?? agentReplyLocalePreference;
  const agentReplyLocaleLocked = Boolean(sessionAgentReplyLocale);
  const availableAgents = visibleChatEmployees(agents, auth?.user);
  const explicitDraftAgentId = draftAgentId || '';
  const routeDraftAgent = explicitDraftAgentId
    ? availableAgents.find((agent) => agent.id === explicitDraftAgentId) || null
    : null;
  const draftAgentLoading = Boolean(explicitDraftAgentId && !agentsLoaded);
  const invalidDraftAgentId = Boolean(explicitDraftAgentId && agentsLoaded && !routeDraftAgent);
  const defaultAgent = availableAgents.find((agent) => agent.id === selectedAgentId) || availableAgents[0] || null;
  // While a freshly created draft is being promoted to a real session, `navigate`
  // has not yet updated the `sessionId` route param. During that transition frame
  // we point the active conversation at the promoted (real) session id so we don't
  // resolve to the already-deleted draft slot and flash the empty state.
  const promotedSessionId = !sessionId ? pendingPromotedSessionIdRef.current : null;
  const activeDraftAgentId = invalidDraftAgentId || draftAgentLoading
    ? ''
    : explicitDraftAgentId || (!sessionId && !promotedSessionId ? (defaultAgent?.id || '') : '');
  const activeConversationId = sessionId || promotedSessionId || (
    activeDraftAgentId && tenantId && userId
      ? draftConversationKey(tenantId, userId, activeDraftAgentId)
      : ''
  );
  const isDraftConversation = Boolean(activeDraftAgentId && !sessionId && !promotedSessionId);
  const draftAgent = activeDraftAgentId
    ? availableAgents.find((agent) => agent.id === activeDraftAgentId) || null
    : null;
  const sessionAgent = currentSession?.agent_id
    ? agents.find((agent) => agent.id === currentSession.agent_id) || null
    : null;
  // 团队会话（team_id 非空）时，ChatEmptyState 改渲染团队名片
  const displayedTeam = currentSession?.team_id
    ? teams.find((team) => team.id === currentSession.team_id) || null
    : null;
  const displayedAgent = invalidDraftAgentId || draftAgentLoading ? null : (sessionAgent || draftAgent || defaultAgent);
  const displayedProfile = displayedAgent ? employeeProfile(displayedAgent) : null;
  const emptyProfileTags = displayedProfile?.workStyles.length
    ? displayedProfile.workStyles.slice(0, 3)
    : [t('chat.empty.defaultTagStructure'), t('chat.empty.defaultTagTraceable')];
  const emptyRoleSummary = displayedProfile
    ? t('chat.empty.roleSummary', {
      role: displayedProfile.roleName,
      name: displayedAgent ? employeeDisplayName(displayedAgent) : t('chat.empty.unset'),
    })
    : t('chat.empty.noEmployee');
  const emptyStats = displayedAgent
    ? [
      { label: t('chat.empty.resourceCount'), value: agentResourceCount(displayedAgent, 'knowledge_base') },
      { label: t('chat.empty.skillCount'), value: agentResourceCount(displayedAgent, 'general_skill') },
      { label: t('chat.empty.sopCount'), value: agentResourceCount(displayedAgent, 'skill') },
    ]
    : [
      { label: t('chat.empty.resourceCount'), value: 0 },
      { label: t('chat.empty.skillCount'), value: 0 },
      { label: t('chat.empty.sopCount'), value: 0 },
    ];
  const sessionFilterOptions = useMemo(() => {
    return buildSessionFilterOptions(availableAgents, sessions, {
      locale,
      allConversationsLabel: t('sidebar.allConversations'),
      teamFallbackLabel: t('sidebar.team'),
      activeDraftAgentId,
    });
  }, [activeDraftAgentId, availableAgents, locale, sessions, t]);
  const visibleSidebarSessions = useMemo(() => {
    const filterTeamId = teamIdFromScope(sessionAgentFilter);
    if (filterTeamId) {
      return sessions.filter((session) => session.team_id === filterTeamId);
    }
    return sessionAgentFilter === 'all'
      ? sessions
      : sessions.filter((session) => !session.team_id && session.agent_id === sessionAgentFilter);
  }, [sessionAgentFilter, sessions]);
  const enabledModelConfigs = useMemo(() => modelConfigs.filter((item) => item.enabled), [modelConfigs]);
  const selectedModelConfig = (
    enabledModelConfigs.find((item) => item.id === selectedModelConfigId)
    || enabledModelConfigs.find((item) => item.is_default)
    || enabledModelConfigs[0]
    || null
  );
  const canConfigureModels = auth?.user.role === 'admin';
  const showModelSetupNotice = !modelConfigsLoading && !modelConfigsLoadError && !selectedModelConfig;
  const modelSetupNoticeText = canConfigureModels
    ? t('chat.model.noConfigAdmin')
    : t('chat.model.noConfigMember');

  useEffect(() => {
    if (!auth || !displayedAgent?.id) {
      setSlashCommands([]);
      return;
    }
    let cancelled = false;
    tenantClient
      .get<ChatSlashCommand[]>(
        `/api/chat/slash-commands?agent_id=${encodeURIComponent(displayedAgent.id)}`,
      )
      .then((rows) => {
        if (!cancelled) setSlashCommands(rows);
      })
      .catch(() => {
        if (!cancelled) setSlashCommands([]);
      });
    return () => {
      cancelled = true;
    };
  }, [auth, displayedAgent?.id, tenantClient, tenantId]);

  const changeModelConfig = useCallback((value: string) => {
    setSelectedModelConfigId(value);
    if (value) {
      window.localStorage.setItem(modelStorageKey(tenantId, userId), value);
    } else {
      window.localStorage.removeItem(modelStorageKey(tenantId, userId));
    }
  }, [tenantId, userId]);

  const completeModelSetup = useCallback((model: ModelConfigRead) => {
    const next = [...modelConfigs.filter((item) => item.id !== model.id), model];
    setModelConfigs(next);
    window.dispatchEvent(new CustomEvent(MODEL_CONFIGS_UPDATED_EVENT, { detail: { models: next } }));
    setModelConfigsLoadError('');
    changeModelConfig(model.id);
  }, [changeModelConfig, modelConfigs]);

  const invalidateModelSelection = useCallback((modelId?: string) => {
    if (modelId) {
      setModelConfigs((current) => current.filter((item) => item.id !== modelId));
    } else {
      setModelConfigs([]);
    }
    changeModelConfig('');
    setModelSetupOpen(true);
  }, [changeModelConfig]);

  const ensureModelAvailable = useCallback(() => {
    if (modelConfigsLoading) {
      notify.warning(t('chat.model.loading'));
      return false;
    }
    if (modelConfigsLoadError) {
      notify.error(t('chat.model.loadFailed'));
      return false;
    }
    if (!selectedModelConfig) {
      if (canConfigureModels) {
        setModelSetupOpen(true);
      } else {
        notify.warning(t('chat.model.noConfigMember'));
      }
      return false;
    }
    return true;
  }, [canConfigureModels, modelConfigsLoadError, modelConfigsLoading, selectedModelConfig, t]);

  const loadAgents = useCallback(async (preferredAgentId?: string) => {
    setAgentsLoaded(false);
    try {
      const rows = await tenantClient.get<AgentProfileRead[]>('/api/chat/agents');
      if (!isWorkspaceCurrent()) return;
      setAgents(rows);
      setSelectedAgentId((current) => {
        // A team scope is not part of the employee roster; keep it untouched.
        if (isTeamScope(current)) return current;
        const employeeRows = visibleChatEmployees(rows, auth?.user);
        if (preferredAgentId && employeeRows.some((item) => item.id === preferredAgentId)) return preferredAgentId;
        if (current && employeeRows.some((item) => item.id === current)) return current;
        const next = employeeRows[0]?.id || '';
        return next;
      });
    } catch {
      if (!isWorkspaceCurrent()) return;
      setAgents([]);
    } finally {
      if (isWorkspaceCurrent()) setAgentsLoaded(true);
    }
  }, [auth?.user, isWorkspaceCurrent, tenantClient, tenantId]);

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  // 团队花名册：用于侧栏团队会话行标明 TL 身份
  useEffect(() => {
    let cancelled = false;
    tenantClient
      .get<TeamRead[]>('/api/enterprise/teams')
      .then((rows) => {
        if (!cancelled && isWorkspaceCurrent()) setTeams(rows);
      })
      .catch(() => {
        if (!cancelled && isWorkspaceCurrent()) setTeams([]);
      });
    return () => {
      cancelled = true;
    };
  }, [isWorkspaceCurrent, tenantClient, tenantId]);

  // 团队名片统计：任务数 + 黑板条目数，随当前会话 team_id 加载；失败静默为 0
  const displayedTeamId = currentSession?.team_id || '';
  useEffect(() => {
    if (!displayedTeamId) {
      setTeamEmptyStats({ tasks: 0, blackboard: 0 });
      return;
    }
    let cancelled = false;
    const fetchCount = async (path: string) => {
      try {
        const rows = await tenantClient.get<unknown[]>(path);
        return Array.isArray(rows) ? rows.length : 0;
      } catch {
        return 0;
      }
    };
    void Promise.all([
      fetchCount(`/api/enterprise/teams/${displayedTeamId}/tasks`),
      fetchCount(`/api/enterprise/teams/${displayedTeamId}/blackboard`),
    ]).then(([taskCount, blackboardCount]) => {
      if (!cancelled && isWorkspaceCurrent()) setTeamEmptyStats({ tasks: taskCount, blackboard: blackboardCount });
    });
    return () => {
      cancelled = true;
    };
  }, [displayedTeamId, isWorkspaceCurrent, tenantClient, tenantId]);

  useEffect(() => {
    const onAgentRefresh = () => {
      void loadAgents();
    };
    window.addEventListener('ultrarag-enterprise-agent-scope-refresh', onAgentRefresh);
    return () => window.removeEventListener('ultrarag-enterprise-agent-scope-refresh', onAgentRefresh);
  }, [loadAgents]);

  useEffect(() => {
    if (!invalidDraftAgentId) return;
    notify.error(t('chat.error.agentAccess'), {
      id: `chat-invalid-draft-agent-${explicitDraftAgentId}`,
      duration: 3000,
    });
    navigate('/workspace/gallery', { replace: true });
  }, [explicitDraftAgentId, invalidDraftAgentId, navigate, t]);

  useEffect(() => {
    if (!activeDraftAgentId) return;
    setSelectedAgentId(activeDraftAgentId);
    if (draftAgentId) {
      persistChatSessionAgentFilter(activeDraftAgentId);
      persistSharedAgentScope(activeDraftAgentId, tenantId, userId);
      emitAgentScopeChange(activeDraftAgentId);
    }
  }, [activeDraftAgentId, draftAgentId, persistChatSessionAgentFilter, tenantId, userId]);

  useEffect(() => {
    const onScopeChange = (event: Event) => {
      const nextAgentId = (
        (event as CustomEvent<{ agentId?: string }>).detail?.agentId
        || readEmployeeScope(tenantId, userId)
        || ''
      );
      if (!nextAgentId) return;
      setSelectedAgentId(nextAgentId);
      setSessionAgentFilter((current) => {
        if (current === 'all') return current;
        window.localStorage.setItem(sessionFilterStorageKey(tenantId, userId), nextAgentId);
        return nextAgentId;
      });
    };
    window.addEventListener('ultrarag-enterprise-agent-scope-change', onScopeChange);
    return () => window.removeEventListener('ultrarag-enterprise-agent-scope-change', onScopeChange);
  }, [tenantId, userId]);

  // 会话作用域以服务端会话归属为准：团队群聊跟随 team:{team_id}，员工私聊回到 agent_id。
  // 这样从团队切换到员工时不会把上一团队的共享作用域遗留在私聊界面。
  useEffect(() => {
    if (embedded) return;
    const scope = currentSession?.team_id
      ? toTeamScope(currentSession.team_id)
      : currentSession?.agent_id;
    if (!scope) return;
    if (selectedAgentId === scope) return;
    setSelectedAgentId(scope);
    persistSharedAgentScope(scope, tenantId, userId);
    emitAgentScopeChange(scope);
  }, [
    currentSession?.agent_id,
    currentSession?.team_id,
    embedded,
    selectedAgentId,
    tenantId,
    userId,
  ]);

  // 只有稳定机器类型明确为 team_tl 才留在聊天；缺失类型的旧响应保守跳回团队详情。
  useEffect(() => {
    if (
      embedded
      || !currentSession?.team_id
      || currentSession.session_kind === 'team_tl'
    ) return;
    navigate(`/enterprise/teams/${currentSession.team_id}`, { replace: true });
  }, [currentSession?.session_kind, currentSession?.team_id, embedded, navigate]);

  useEffect(() => {
    if (!auth) {
      setModelConfigsLoading(false);
      return;
    }
    setModelConfigsLoading(true);
    setModelConfigsLoadError('');
    tenantClient
      .get<ModelConfigRead[]>('/api/enterprise/model-configs')
      .then((rows) => {
        if (!isWorkspaceCurrent()) return;
        setModelConfigs(rows);
        setSelectedModelConfigId((current) => {
          const enabledRows = rows.filter((item) => item.enabled);
          const stored = window.localStorage.getItem(modelStorageKey(tenantId, userId)) || '';
          if (current && enabledRows.some((item) => item.id === current)) return current;
          if (stored && enabledRows.some((item) => item.id === stored)) return stored;
          const next = enabledRows.find((item) => item.is_default)?.id || enabledRows[0]?.id || '';
          if (next) {
            window.localStorage.setItem(modelStorageKey(tenantId, userId), next);
          }
          return next;
        });
      })
      .catch((error) => {
        if (!isWorkspaceCurrent()) return;
        if (isAuthError(error)) {
          redirectToLogin();
          return;
        }
        console.error('[chat] model configuration load failed', error);
        setModelConfigsLoadError('failed');
      })
      .finally(() => {
        if (isWorkspaceCurrent()) setModelConfigsLoading(false);
      });
  }, [auth, isWorkspaceCurrent, redirectToLogin, tenantClient, tenantId, userId]);

  useEffect(() => {
    const onModelConfigsUpdated = (event: Event) => {
      const rows = (event as CustomEvent<{ models?: ModelConfigRead[] }>).detail?.models;
      if (!rows) return;
      setModelConfigs(rows);
      setModelConfigsLoadError('');
      setModelConfigsLoading(false);
      setSelectedModelConfigId((current) => {
        const enabledRows = rows.filter((item) => item.enabled);
        if (current && enabledRows.some((item) => item.id === current)) return current;
        const next = enabledRows.find((item) => item.is_default)?.id || enabledRows[0]?.id || '';
        if (next) {
          window.localStorage.setItem(modelStorageKey(tenantId, userId), next);
        } else {
          window.localStorage.removeItem(modelStorageKey(tenantId, userId));
        }
        return next;
      });
    };
    window.addEventListener(MODEL_CONFIGS_UPDATED_EVENT, onModelConfigsUpdated);
    return () => window.removeEventListener(MODEL_CONFIGS_UPDATED_EVENT, onModelConfigsUpdated);
  }, [tenantId, userId]);

  useEffect(() => {
    if (!auth || modelConfigsLoading || modelConfigsLoadError || selectedModelConfig) return;
    const onboardingSeen = window.localStorage.getItem(ONBOARDING_SEEN_KEY);
    const quickStartSeen = window.localStorage.getItem(QUICK_START_SEEN_KEY);
    if (!onboardingSeen || !quickStartSeen) return;
    setModelSetupOpen(true);
  }, [auth, modelConfigsLoadError, modelConfigsLoading, selectedModelConfig]);

  const toggleTrace = useCallback((turnId: string, isExpanded = false) => {
    if (isExpanded) {
      setCollapsedTraceIds((current) => (current.includes(turnId) ? current : [...current, turnId]));
      setExpandedTraceIds((current) => current.filter((item) => item !== turnId));
      return;
    }
    setCollapsedTraceIds((current) => current.filter((item) => item !== turnId));
    setExpandedTraceIds((current) => (
      current.includes(turnId) ? current : [...current, turnId]
    ));
  }, []);

  const getSlot = useCallback((id: string): SessionSlot => {
    const store = storeRef.current;
    if (!store.has(id)) store.set(id, createEmptySlot());
    return store.get(id)!;
  }, []);

  const getStreamSlot = useCallback((id: string): StreamSlot => {
    const store = streamRef.current;
    if (!store.has(id)) store.set(id, createStreamSlot());
    return store.get(id)!;
  }, []);

  const getTurnTrace = useCallback((id: string): TurnTrace => {
    const store = turnTraceRef.current;
    if (!store.has(id)) store.set(id, createTurnTrace());
    return store.get(id)!;
  }, []);

  const forgetMissingSession = useCallback((id: string) => {
    knownSessionIdsRef.current.delete(id);
    optimisticSessionIdsRef.current.delete(id);
    if (queuedTurnsRef.current.some((item) => item.conversationId === id)) {
      queuedTurnsRef.current = queuedTurnsRef.current.filter((item) => item.conversationId !== id);
      persistQueuedTurns();
      notifyQueue();
    }
    storeRef.current.delete(id);
    streamRef.current.delete(id);
    locallyCancelledSessionIdsRef.current.delete(id);
    setSessions((current) => current.filter((item) => item.id !== id));
    setScheduledDrafts((current) => {
      if (!current[id]) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
    setCreatedScheduledTasks((current) => {
      const key = `session:${id}`;
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
    notifyStore();
    notifyStream();
  }, [notifyQueue, notifyStore, notifyStream, persistQueuedTurns]);

  const upsertOptimisticSession = useCallback((session: ChatSession) => {
    optimisticSessionIdsRef.current.add(session.id);
    knownSessionIdsRef.current.add(session.id);
    setSessions((current) => {
      const existing = current.find((item) => item.id === session.id);
      const nextSession = existing
        ? { ...existing, ...session, updated_at: session.updated_at || existing.updated_at }
        : session;
      return [nextSession, ...current.filter((item) => item.id !== session.id)];
    });
  }, []);

  const applySessionTitleSummary = useCallback((targetSessionId: string, rawTitle: unknown) => {
    const title = typeof rawTitle === 'string' ? rawTitle.trim() : '';
    if (!targetSessionId || !title) return;
    setSessions((current) => current.map((item) => (item.id === targetSessionId ? { ...item, title } : item)));
  }, []);

  const upsertTraceLine = useCallback((turnId: string, line: TraceLine) => {
    const trace = getTurnTrace(turnId);
    const nextLine = trace.completedAt && line.state === 'running'
      ? { ...line, state: 'completed' as const }
      : line;
    const index = trace.lines.findIndex((item) => item.id === line.id);
    if (index >= 0) {
      trace.lines = [...trace.lines];
      trace.lines[index] = mergeTraceLine(trace.lines[index], nextLine);
    } else {
      trace.lines = [...trace.lines, nextLine].slice(-80);
    }
    notifyTrace();
  }, [getTurnTrace, notifyTrace]);

  const finishTrace = useCallback((turnId: string, failed = false) => {
    const trace = getTurnTrace(turnId);
    trace.completedAt = Date.now();
    trace.lines = trace.lines.map((line) => ({
      ...line,
      state: failed && line.state === 'running' ? 'failed' : line.state === 'running' ? 'completed' : line.state,
    }));
    notifyTrace();
  }, [getTurnTrace, notifyTrace]);

  const pruneRealtime = useCallback((id: string) => {
    const slot = getSlot(id);
    const stream = getStreamSlot(id);
    const latestServerTime = Math.max(0, ...slot.serverMessages.map((item) => parseMessageTime(item.created_at)));
    slot.realtimeMessages = slot.realtimeMessages.filter((item) => {
      if (slot.serverMessages.some((serverMessage) => serverMessage.id === item.id)) return false;
      return shouldKeepRealtimeMessage(item, slot.serverMessages, latestServerTime, stream.turnId);
    });
  }, [getSlot, getStreamSlot]);

  const clearStreamSlot = useCallback((id: string, removeStreamingMessage = false) => {
    const stream = getStreamSlot(id);
    const clearingTurnId = stream.turnId || stream.cancelledTurnId || undefined;
    const streamChanged = Boolean(
      stream.timer
      || stream.loading
      || stream.phase
      || stream.accumulated
      || stream.turnId
      || stream.abortController
      || stream.relayRecoveryStartedAt
      || stream.relayRecoveryTurnId
    );
    if (stream.timer) {
      window.clearTimeout(stream.timer);
      stream.timer = null;
    }
    stream.loading = false;
    stream.phase = '';
    stream.accumulated = '';
    stream.turnId = null;
    stream.abortController = null;
    stream.relayRecoveryStartedAt = null;
    stream.relayRecoveryTurnId = null;
    if (removeStreamingMessage) {
      const slot = getSlot(id);
      const aliasMap = buildTurnAliasMap([...slot.serverMessages, ...slot.realtimeMessages]);
      const canonicalClearingTurnId = canonicalTurnIdForValue(clearingTurnId, aliasMap);
      const nextRealtime = slot.realtimeMessages.filter((item) => {
        if (!isStreamingMessageId(item.id, id)) return true;
        if (!clearingTurnId) return false;
        const itemTurnId = canonicalMessageTurnId(item, aliasMap);
        return itemTurnId !== canonicalClearingTurnId;
      });
      if (nextRealtime.length !== slot.realtimeMessages.length) {
        slot.realtimeMessages = nextRealtime;
        notifyStore();
      }
    }
    if (streamChanged) notifyStream();
  }, [getSlot, getStreamSlot, notifyStore, notifyStream]);

  const rekeyTurnTrace = useCallback((fromTurnId: string, toTurnId: string) => {
    if (!fromTurnId || !toTurnId || fromTurnId === toTurnId) return;
    const source = turnTraceRef.current.get(fromTurnId);
    if (!source) return;
    const target = turnTraceRef.current.get(toTurnId);
    if (!target) {
      turnTraceRef.current.set(toTurnId, source);
    } else {
      const nextLines = [...target.lines];
      source.lines.forEach((line) => {
        const index = nextLines.findIndex((item) => item.id === line.id);
        if (index >= 0) {
          nextLines[index] = mergeTraceLine(nextLines[index], line);
        } else {
          nextLines.push(line);
        }
      });
      target.lines = nextLines.slice(-80);
      target.startedAt = Math.min(target.startedAt, source.startedAt);
      target.completedAt = target.completedAt || source.completedAt;
    }
    turnTraceRef.current.delete(fromTurnId);
    setExpandedTraceIds((current) => {
      if (!current.includes(fromTurnId)) return current;
      const next = current.filter((item) => item !== fromTurnId);
      return next.includes(toTurnId) ? next : [...next, toTurnId];
    });
    setCollapsedTraceIds((current) => (
      current.includes(fromTurnId) ? current.map((item) => (item === fromTurnId ? toTurnId : item)) : current
    ));
    notifyTrace();
  }, [notifyTrace]);

  const bindRealtimeUserToServerMessage = useCallback((id: string, turnId: string, serverMessageId: string) => {
    if (!turnId || !serverMessageId) return;
    const slot = getSlot(id);
    const stream = getStreamSlot(id);
    let changed = false;
    slot.realtimeMessages = slot.realtimeMessages.map((item) => {
      if (item.turnId !== turnId) return item;
      changed = true;
      return {
        ...item,
        id: item.role === 'user' ? serverMessageId : item.id,
        serverMessageId: item.role === 'user' ? serverMessageId : item.serverMessageId,
        turnId: serverMessageId,
      };
    });
    slot.serverMessages = slot.serverMessages.map((item) => {
      if (item.id !== serverMessageId) return item;
      changed = true;
      return { ...item, turnId: serverMessageId };
    });
    if (stream.turnId === turnId) {
      stream.turnId = serverMessageId;
      changed = true;
    }
    if (stream.cancelledTurnId === turnId) {
      stream.cancelledTurnId = serverMessageId;
      changed = true;
    }
    setRunningTurn((current) => (
      current?.sessionId === id && current.turnId === turnId
        ? { sessionId: id, turnId: serverMessageId }
        : current
    ));
    rekeyTurnTrace(turnId, serverMessageId);
    if (changed) notifyStore();
  }, [getSlot, getStreamSlot, notifyStore, rekeyTurnTrace]);

  const displayedMessages = useMemo(() => {
    if (!activeConversationId) return [];
    void feedbackTick;
    void storeTick;
    void streamTick;
    void traceTick;
    void queuedTurnsTick;
    const merged = computeMergedMessages(
      getSlot(activeConversationId),
      getStreamSlot(activeConversationId).turnId,
    ).filter((item) => (
      item.metadata?.queued !== true
      && item.metadata?.message_visibility !== 'internal'
    ));
    const queued = queuedTurnsRef.current
      .filter((turn) => turn.conversationId === activeConversationId)
      .map(queuedTurnPreview);
    return [...merged, ...queued];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConversationId, feedbackTick, getSlot, getStreamSlot, queuedTurnsTick, storeTick, streamTick, traceTick]);

  const currentStream = useMemo(() => {
    void streamTick;
    return activeConversationId ? getStreamSlot(activeConversationId) : createStreamSlot();
  }, [activeConversationId, getStreamSlot, streamTick]);
  const currentTraceRunning = Boolean(
    currentStream.loading
    || (activeConversationId && runningTurn?.sessionId === activeConversationId),
  );
  const activeSessionReportsRunning = Boolean(
    activeConversationId
    && sessions.some((item) => (
      item.id === activeConversationId
      && (item.status === 'running' || item.status === 'executing')
    )),
  );
  const activeRunningTraceId = currentTraceRunning
    ? (currentStream.turnId || (runningTurn?.sessionId === activeConversationId ? runningTurn.turnId : '') || '')
    : '';
  const hasRunningDisplayedTrace = useMemo(() => {
    void traceTick;
    return displayedMessages.some((item) => {
      if (item.role !== 'assistant' || !item.isStreaming) return false;
      const trace = turnTraceRef.current.get(item.turnId || item.id);
      return Boolean(trace?.lines.some((line) => line.state === 'running'));
    });
  }, [displayedMessages, traceTick]);
  const currentSessionRunning = Boolean(
    currentStream.loading
    || (activeConversationId && runningTurn?.sessionId === activeConversationId)
    || hasRunningDisplayedTrace
    || activeSessionReportsRunning,
  );
  const readyComposerAttachments = useMemo(
    () => composerAttachments.filter((item) => item.uploadStatus === 'ready'),
    [composerAttachments],
  );
  const uploadingComposerAttachment = composerAttachments.some((item) => item.uploadStatus === 'uploading');
  const composerActive = Boolean(
    input.trim()
    || composerAttachments.length > 0
    || displayedMessages.length > 0
    || currentSessionRunning,
  );
  const showComposerAvatar = Boolean(activeConversationId && displayedProfile);
  const isCurrentStreamingTrace = useCallback((traceTurnId: string, item?: ChatMessage) => Boolean(
    currentTraceRunning
    && traceTurnId
    && (
      traceTurnId === activeRunningTraceId
      || traceTurnId === currentStream.turnId
      || (item?.role === 'assistant' && item.isStreaming)
    )
  ), [activeRunningTraceId, currentStream.turnId, currentTraceRunning]);

  useEffect(() => {
    if (!agentsLoaded || sessionsLoading || !sessionsInitializedRef.current) return;
    // 团队作用域不在员工过滤项里，但它是合法的会话过滤值，不能重置。
    if (isTeamScope(sessionAgentFilter)) return;
    if (!sessionFilterOptions.some((item) => item.value === sessionAgentFilter)) {
      persistChatSessionAgentFilter('all');
    }
  }, [
    agentsLoaded,
    persistChatSessionAgentFilter,
    sessionAgentFilter,
    sessionFilterOptions,
    sessionsLoading,
  ]);
  const currentScheduledDraft = activeConversationId ? scheduledDrafts[activeConversationId] : undefined;
  const hasVisibleMessageScheduledDraft = displayedMessages.some((item) => (
    item.role === 'assistant'
    && !dismissedDraftMessageIds.includes(item.id)
    && Boolean(scheduledDraftForMessage(item))
  ));

  const loadSessions = useCallback(() => {
    const listed = tenantClient.get<ChatSession[]>('/api/chat/sessions');
    const selected = sessionId
      ? tenantClient
        .get<ChatSession>(`/api/chat/sessions/${sessionId}`)
        .catch(() => null)
      : Promise.resolve(null);
    Promise.all([listed, selected])
      .then(([listedRows, selectedRow]) => {
        if (!isWorkspaceCurrent()) return;
        const rows = selectedRow && !listedRows.some((row) => row.id === selectedRow.id)
          ? [...listedRows, selectedRow]
          : listedRows;
        const previousIds = new Set(knownSessionIdsRef.current);
        const initialized = sessionsInitializedRef.current;
        if (!initialized) {
          const initialReads = loadSessionReadTimes(tenantId, userId);
          const nextReads = { ...initialReads };
          if (Object.keys(initialReads).length === 0) {
            rows.forEach((row) => {
              nextReads[row.id] = row.updated_at || new Date().toISOString();
            });
          }
          setSessionReadTimes(nextReads);
          persistSessionReadTimes(tenantId, userId, nextReads);
          sessionsInitializedRef.current = true;
        }
        rows.forEach((row) => {
          knownSessionIdsRef.current.add(row.id);
          optimisticSessionIdsRef.current.delete(row.id);
        });
        const persistedIds = new Set(rows.map((row) => row.id));
        setSessions((current) => [
          ...current.filter((row) => optimisticSessionIdsRef.current.has(row.id) && !persistedIds.has(row.id)),
          ...rows,
        ]);
        if (!initialized) return;
        const newScheduledSession = rows.find((row) => (
          !previousIds.has(row.id)
          && isScheduledSession(row)
          && !autoOpenedSessionIdsRef.current.has(row.id)
        ));
        if (!newScheduledSession || embedded) return;
        autoOpenedSessionIdsRef.current.add(newScheduledSession.id);
        if (!input.trim()) {
          getSlot(newScheduledSession.id);
          navigate(chatSessionPath(newScheduledSession.id));
        }
      })
      .catch((error) => {
        if (isWorkspaceCurrent()) notifyRequestError('sessions', error, 'chat.error.sessionsLoad');
      })
      .finally(() => {
        if (isWorkspaceCurrent()) setSessionsLoading(false);
      });
  }, [embedded, getSlot, input, isWorkspaceCurrent, navigate, notifyRequestError, sessionId, tenantClient, tenantId, userId]);

  const handleMissingSession = useCallback((id: string) => {
    forgetMissingSession(id);
    loadSessions();
    if (sessionId === id && !embedded) {
      pendingPromotedSessionIdRef.current = null;
      navigate('/workspace/gallery', { replace: true });
    }
  }, [embedded, forgetMissingSession, loadSessions, navigate, sessionId]);

  const loadMessages = useCallback((id: string) => {
    return tenantClient
      .get<ChatMessage[]>(`/api/chat/sessions/${id}/messages`)
      .then((rows) => {
        if (!isWorkspaceCurrent()) return [];
        const slot = getSlot(id);
        slot.serverMessages = attachTurnIdsToServerMessages(rows, slot.realtimeMessages);
        const stream = getStreamSlot(id);
        if (stream.loading) {
          const hasCompletedAssistant = stream.turnId ? hasAssistantMessageForTurn(slot, stream.turnId) : false;
          if (hasCompletedAssistant) {
            clearStreamSlot(id, true);
          }
        }
        pruneRealtime(id);
        notifyStore();
        return rows;
      })
      .catch((error) => {
        if (!isWorkspaceCurrent()) return [];
        if (isMissingChatSessionError(error)) {
          handleMissingSession(id);
          return [];
        }
        notifyRequestError('messages', error, 'chat.error.messagesLoad');
        return [];
      });
  }, [clearStreamSlot, getSlot, getStreamSlot, handleMissingSession, isWorkspaceCurrent, notifyRequestError, notifyStore, pruneRealtime, tenantClient, tenantId]);

  const loadTraces = useCallback((id: string) => {
    return tenantClient
      .get<TurnTraceRead[]>(`/api/chat/sessions/${id}/trace`)
      .then((rows) => {
        if (!isWorkspaceCurrent()) return;
        const slot = getSlot(id);
        const stream = getStreamSlot(id);
        const locallyCancelled = locallyCancelledSessionIdsRef.current.has(id);
        let recoveredRunningTurnId = '';
        let storeChanged = false;
        let streamChanged = false;
        rows.forEach((row) => {
          const hasFinalAssistant = hasAssistantMessageForTurn(slot, row.turn_id);
          const hasAssistantCarrier = hasAssistantCarrierForTurn(slot, row.turn_id);
          const traceLines = row.lines.map((line) => {
            const localized = localizedPersistedTraceLine(line, locale, t);
            return {
              id: line.id,
              kind: line.kind,
              text: localized.text,
              detail: localized.detail,
              code: line.code || undefined,
              language: line.language || undefined,
              output: line.output || undefined,
              outputLanguage: line.outputLanguage || undefined,
              outputTitle: line.outputTitle || undefined,
              state: line.state,
              depth: typeof line.depth === 'number' ? line.depth : undefined,
              collapsible: Boolean(line.collapsible || line.code || line.output),
            };
          });
          let mergedTrace = mergeTurnTraceSnapshot(turnTraceRef.current.get(row.turn_id), {
            lines: traceLines,
            startedAt: parseMessageTime(row.started_at) || Date.now(),
            completedAt: row.completed_at ? parseMessageTime(row.completed_at) : undefined,
          });
          const activeStreamTurn = stream.loading && stream.turnId === row.turn_id;
          const recoverableRunningTrace = (
            !locallyCancelled
            && !hasFinalAssistant
            && !mergedTrace.completedAt
            && (
              activeStreamTurn
              || isRecoverableRunningTrace({
                completed_at: row.completed_at,
                lines: mergedTrace.lines,
                started_at: row.started_at,
              })
            )
          );
          const staleOpenTrace = (
            !mergedTrace.completedAt
            && mergedTrace.lines.length > 0
            && !recoverableRunningTrace
            && !hasAssistantCarrier
          );
          if (staleOpenTrace) {
            mergedTrace = {
              ...mergedTrace,
              lines: mergedTrace.lines.map((line) => (
                line.state === 'running' ? { ...line, state: 'completed' as const } : line
              )),
              completedAt: parseMessageTime(row.started_at) || Date.now(),
            };
          }
          turnTraceRef.current.set(row.turn_id, mergedTrace);
          if (recoverableRunningTrace) {
            recoveredRunningTurnId = row.turn_id;
          } else if ((row.completed_at || staleOpenTrace) && mergedTrace.lines.length > 0 && !hasAssistantCarrier) {
            storeChanged = upsertTraceStatusPlaceholder(slot, id, row.turn_id) || storeChanged;
            if (staleOpenTrace) {
              setExpandedTraceIds((expanded) => (expanded.includes(row.turn_id) ? expanded : [...expanded, row.turn_id]));
            }
          }
        });
        if (
          !recoveredRunningTurnId
          && !locallyCancelled
          && stream.loading
          && stream.turnId
          && !hasAssistantMessageForTurn(slot, stream.turnId)
        ) {
          const activeTrace = turnTraceRef.current.get(stream.turnId);
          const hasVisibleActiveTrace = Boolean(activeTrace?.lines.some((line) => (
            !line.provisional && !line.placeholder && Boolean(normalizeMessageText(line.text))
          )));
          recoveredRunningTurnId = stream.turnId;
          if (hasVisibleActiveTrace) {
            storeChanged = upsertStreamingTracePlaceholder(slot, id, stream.turnId) || storeChanged;
          }
        }
        if (recoveredRunningTurnId) {
          streamChanged = streamChanged || stream.turnId !== recoveredRunningTurnId || !stream.loading || !stream.phase;
          stream.turnId = recoveredRunningTurnId;
          stream.loading = true;
          stream.phase = stream.phase || t('chat.trace.thinking');
          const recoveredTrace = turnTraceRef.current.get(recoveredRunningTurnId);
          const hasVisibleTrace = Boolean(recoveredTrace?.lines.some((line) => (
            !line.provisional && !line.placeholder && Boolean(normalizeMessageText(line.text))
          )));
          if (hasVisibleTrace) {
            storeChanged = upsertStreamingTracePlaceholder(slot, id, recoveredRunningTurnId) || storeChanged;
          }
          setExpandedTraceIds((expanded) => (expanded.includes(recoveredRunningTurnId) ? expanded : [...expanded, recoveredRunningTurnId]));
        } else if (stream.turnId && !stream.loading) {
          streamChanged = true;
          stream.turnId = null;
          stream.phase = '';
        }
        setRunningTurn((current) => {
          if (recoveredRunningTurnId) {
            const next = { sessionId: id, turnId: recoveredRunningTurnId };
            return current?.sessionId === next.sessionId && current.turnId === next.turnId ? current : next;
          }
          return current?.sessionId === id ? null : current;
        });
        if (storeChanged) notifyStore();
        if (storeChanged || streamChanged) notifyStream();
        notifyTrace();
      })
      .catch((error) => {
        if (!isWorkspaceCurrent()) return;
        if (isMissingChatSessionError(error)) {
          handleMissingSession(id);
          return;
        }
        notifyRequestError('trace', error, 'chat.error.traceLoad');
      });
  }, [getSlot, getStreamSlot, handleMissingSession, isWorkspaceCurrent, locale, notifyRequestError, notifyStore, notifyStream, notifyTrace, t, tenantClient, tenantId]);

  const stopTerminalTurnSync = useCallback((sessionIdToStop: string, turnIdToStop: string) => {
    const key = `${sessionIdToStop}:${turnIdToStop}`;
    const existing = terminalTurnSyncRef.current.get(key);
    if (existing?.timer) {
      window.clearTimeout(existing.timer);
    }
    terminalTurnSyncRef.current.delete(key);
  }, []);

  const syncTurnUntilAssistant = useCallback((targetSessionId: string, targetTurnId: string) => {
    if (!isWorkspaceCurrent() || !targetSessionId || !targetTurnId || isDraftConversationKey(targetSessionId)) return;
    const key = `${targetSessionId}:${targetTurnId}`;
    const existing = terminalTurnSyncRef.current.get(key);
    const startedAt = existing?.startedAt || Date.now();
    if (existing?.timer) {
      window.clearTimeout(existing.timer);
    }
    const run = () => {
      Promise.all([
        loadMessages(targetSessionId),
        loadTraces(targetSessionId),
        loadSessions(),
      ]).finally(() => {
        if (!isWorkspaceCurrent()) {
          stopTerminalTurnSync(targetSessionId, targetTurnId);
          return;
        }
        const slot = getSlot(targetSessionId);
        if (hasAssistantMessageForTurn(slot, targetTurnId)) {
          stopTerminalTurnSync(targetSessionId, targetTurnId);
          const stream = getStreamSlot(targetSessionId);
          if (stream.turnId === targetTurnId || stream.cancelledTurnId === targetTurnId) {
            clearStreamSlot(targetSessionId, true);
          }
          return;
        }
        if (Date.now() - startedAt >= CHAT_STREAM_IDLE_TIMEOUT_MS) {
          stopTerminalTurnSync(targetSessionId, targetTurnId);
          return;
        }
        const timer = window.setTimeout(run, 900);
        terminalTurnSyncRef.current.set(key, { startedAt, timer });
      });
    };
    terminalTurnSyncRef.current.set(key, { startedAt, timer: null });
    run();
  }, [
    getSlot,
    getStreamSlot,
    clearStreamSlot,
    isWorkspaceCurrent,
    loadMessages,
    loadSessions,
    loadTraces,
    stopTerminalTurnSync,
  ]);

  const loadHandoffs = useCallback(() => {
    if (!auth) return Promise.resolve();
    setHandoffsLoading(true);
    return tenantClient
      .get<HumanHandoffRead[]>('/api/chat/handoffs?status=pending')
      .then((rows) => {
        if (isWorkspaceCurrent()) setHandoffs(rows);
      })
      .catch((error) => {
        if (isWorkspaceCurrent()) notifyRequestError('handoffs', error, 'chat.error.handoffsLoad');
      })
      .finally(() => {
        if (isWorkspaceCurrent()) setHandoffsLoading(false);
      });
  }, [auth, isWorkspaceCurrent, notifyRequestError, tenantClient, tenantId]);

  /** 提交人工接续回复；服务错误仅记录技术根因并显示稳定的本地化错误。 */
  const replyToHandoff = useCallback(async (handoff: HumanHandoffRead, reply: string): Promise<boolean> => {
    if (!isWorkspaceCurrent()) return false;
    try {
      await tenantClient.post<HumanHandoffRead>(`/api/chat/handoffs/${handoff.id}/reply`, { reply });
      if (!isWorkspaceCurrent()) return false;
      notify.successText(t('chat.notice.handoffReplied'));
      setHandoffs((rows) => rows.filter((item) => item.id !== handoff.id));
      setHandoffReplies((prev) => {
        const next = { ...prev };
        delete next[handoff.id];
        return next;
      });
      loadSessions();
      getSlot(handoff.session_id);
      void loadMessages(handoff.session_id);
      void loadTraces(handoff.session_id);
      return true;
    } catch (error) {
      if (!isWorkspaceCurrent()) return false;
      if (isAuthError(error)) {
        redirectToLogin();
        return false;
      }
      console.error('[chat] handoff reply failed', error);
      notify.error(t('chat.error.replyFailed'));
      return false;
    }
  }, [getSlot, isWorkspaceCurrent, loadMessages, loadSessions, loadTraces, redirectToLogin, t, tenantClient, tenantId]);

  /** 校验并提交人工接续文本；空输入使用稳定的语义校验消息。 */
  const submitHandoffReply = useCallback((handoff: HumanHandoffRead) => {
    const reply = (handoffReplies[handoff.id] || '').trim();
    if (!reply) {
      notify.warning(t('chat.error.replyRequired'));
      return;
    }
    if (!ensureModelAvailable()) return;
    void replyToHandoff(handoff, reply);
  }, [ensureModelAvailable, handoffReplies, replyToHandoff, t]);

  const openHandoffInbox = useCallback(() => {
    setShowHandoffInbox(true);
    void loadHandoffs();
  }, [loadHandoffs]);

  const appendRealtime = useCallback((id: string, messageItem: ChatMessage) => {
    const slot = getSlot(id);
    const existingIndex = messageItem.role === 'assistant'
      ? slot.realtimeMessages.findIndex((item) => sameRoleTurn(item, messageItem))
      : -1;
    if (existingIndex >= 0) {
      const nextMessages = [...slot.realtimeMessages];
      nextMessages[existingIndex] = {
        ...nextMessages[existingIndex],
        ...messageItem,
        id: messageItem.id,
        created_at: nextMessages[existingIndex].created_at || messageItem.created_at,
      };
      slot.realtimeMessages = nextMessages.slice(-200);
    } else {
      slot.realtimeMessages = [...slot.realtimeMessages, messageItem].slice(-200);
    }
    notifyStore();
  }, [getSlot, notifyStore]);

  const appendQueuedTurnPreview = useCallback((turn: PreparedChatTurn) => {
    appendRealtime(turn.conversationId, queuedTurnPreview(turn));
  }, [appendRealtime]);

  const removeQueuedTurnPreview = useCallback((turn: PreparedChatTurn) => {
    const slot = getSlot(turn.conversationId);
    const nextMessages = slot.realtimeMessages.filter((item) => item.id !== `queued_${turn.turnId}`);
    if (nextMessages.length === slot.realtimeMessages.length) return;
    slot.realtimeMessages = nextMessages;
    notifyStore();
  }, [getSlot, notifyStore]);

  /** 将发送内容加入持久化队列，并以本地化产品通知反馈队列状态。 */
  const enqueuePreparedTurn = useCallback((turn: PreparedChatTurn) => {
    queuedTurnsRef.current = [...queuedTurnsRef.current, turn];
    const persisted = persistQueuedTurns();
    appendQueuedTurnPreview(turn);
    notifyQueue();
    notify.info(t('chat.notice.queued'));
    if (!persisted) {
      notify.warning(t('chat.notice.queuePersistenceWarning'));
    }
  }, [appendQueuedTurnPreview, notifyQueue, persistQueuedTurns, t]);

  const removeQueuedTurn = useCallback((turnId: string) => {
    if (!turnId) return;
    const queuedTurn = queuedTurnsRef.current.find((turn) => turn.turnId === turnId);
    if (!queuedTurn) return;
    queuedTurnsRef.current = queuedTurnsRef.current.filter((turn) => turn.turnId !== turnId);
    persistQueuedTurns();
    removeQueuedTurnPreview(queuedTurn);
    notifyQueue();
  }, [notifyQueue, persistQueuedTurns, removeQueuedTurnPreview]);

  useEffect(() => {
    if (queuedTurnPreviewsRestoredRef.current) return;
    queuedTurnPreviewsRestoredRef.current = true;
    queuedTurnsRef.current.forEach(appendQueuedTurnPreview);
    if (queuedTurnsRef.current.length > 0) notifyQueue();
  }, [appendQueuedTurnPreview, notifyQueue]);

  const updateMessageFeedback = useCallback((
    id: string,
    messageId: string,
    rating: ChatMessage['feedback_rating'],
  ) => {
    const slot = getSlot(id);
    const update = (item: ChatMessage) => (item.id === messageId ? { ...item, feedback_rating: rating } : item);
    slot.serverMessages = slot.serverMessages.map(update);
    slot.realtimeMessages = slot.realtimeMessages.map(update);
    notifyFeedback();
  }, [getSlot, notifyFeedback]);

  const updateStreaming = useCallback((id: string, text: string, turnId?: string, force = false) => {
    const slot = getSlot(id);
    const stream = getStreamSlot(id);
    const activeTurnId = turnId || stream.turnId || undefined;
    const streamId = streamingMessageId(id, activeTurnId);
    const draftStreamingMessage: ChatMessage = {
      id: streamId,
      turnId: activeTurnId,
      role: 'assistant',
      content: text,
      created_at: timestampAfterMessage(latestUserMessageForTurn(slot, activeTurnId)),
      isStreaming: true,
    };
    const aliasMap = buildTurnAliasMap([...slot.serverMessages, ...slot.realtimeMessages, draftStreamingMessage]);
    const activeCanonicalTurnId = canonicalTurnIdForValue(activeTurnId, aliasMap);
    const index = slot.realtimeMessages.findIndex((item) => (
      item.id === streamId
      || (
        isStreamingMessageId(item.id, id)
        && activeCanonicalTurnId
        && canonicalMessageTurnId(item, aliasMap) === activeCanonicalTurnId
      )
    ));
    const hasVisibleText = Boolean(normalizeMessageText(text));
    if (!hasVisibleText || (!force && !hasRenderableStreamingText(text))) {
      if (index >= 0 && normalizeMessageText(slot.realtimeMessages[index].content)) {
        slot.realtimeMessages = [...slot.realtimeMessages];
        slot.realtimeMessages[index] = {
          ...slot.realtimeMessages[index],
          content: '',
          isStreaming: true,
        };
        notifyStore();
      }
      return;
    }
    const previousMessage = index >= 0 ? slot.realtimeMessages[index] : undefined;
    const previousCanonicalTurnId = previousMessage ? canonicalMessageTurnId(previousMessage, aliasMap) : undefined;
    const previousCreatedAt = previousMessage && previousCanonicalTurnId === activeCanonicalTurnId
      ? previousMessage.created_at
      : undefined;
    const streamingMessage: ChatMessage = {
      ...draftStreamingMessage,
      created_at: previousCreatedAt || draftStreamingMessage.created_at,
    };
    if (activeTurnId) {
      slot.realtimeMessages = slot.realtimeMessages.filter((item) => (
        item.id === streamId
        || !(
          item.role === 'assistant'
          && activeCanonicalTurnId
          && canonicalMessageTurnId(item, aliasMap) === activeCanonicalTurnId
          && !hasServerMessageForTurn(item, slot.serverMessages)
        )
      ));
    }
    const streamIndex = slot.realtimeMessages.findIndex((item) => item.id === streamId);
    if (streamIndex >= 0) {
      const previous = slot.realtimeMessages[streamIndex];
      if (
        previous.turnId === streamingMessage.turnId
        && previous.content === streamingMessage.content
        && previous.isStreaming === streamingMessage.isStreaming
      ) {
        return;
      }
      slot.realtimeMessages = [...slot.realtimeMessages];
      slot.realtimeMessages[streamIndex] = streamingMessage;
    } else {
      slot.realtimeMessages = [...slot.realtimeMessages, streamingMessage];
    }
    notifyStore();
  }, [getSlot, getStreamSlot, notifyStore]);

  const ensureStreamingTraceMessage = useCallback((id: string, turnId?: string | null) => {
    if (!turnId) return;
    const stream = getStreamSlot(id);
    if (!stream.loading) return;
    const trace = turnTraceRef.current.get(turnId);
    const hasVisibleTrace = Boolean(trace?.lines.some((line) => (
      !line.provisional && !line.placeholder && Boolean(normalizeMessageText(line.text))
    )));
    if (hasRenderableStreamingText(stream.accumulated)) {
      updateStreaming(id, stream.accumulated, turnId);
      return;
    }
    if (!hasVisibleTrace) return;
    if (upsertStreamingTracePlaceholder(getSlot(id), id, turnId)) {
      notifyStore();
    }
  }, [getSlot, getStreamSlot, notifyStore, updateStreaming]);

  const flushStreaming = useCallback((id: string) => {
    const stream = getStreamSlot(id);
    if (stream.timer) {
      window.clearTimeout(stream.timer);
      stream.timer = null;
    }
    if (stream.accumulated) {
      updateStreaming(id, stream.accumulated, stream.turnId || undefined, true);
    }
  }, [getStreamSlot, updateStreaming]);

  const finalizeStreaming = useCallback((id: string) => {
    flushStreaming(id);
    const slot = getSlot(id);
    const stream = getStreamSlot(id);
    const activeTurnId = stream.turnId || undefined;
    const streamId = streamingMessageId(id, activeTurnId);
    let index = slot.realtimeMessages.findIndex((item) => item.id === streamId);
    if (index < 0 && activeTurnId) {
      index = slot.realtimeMessages.findIndex((item) => (
        isStreamingMessageId(item.id, id)
        && effectiveMessageTurnId(item) === activeTurnId
      ));
    }
    if (index >= 0) {
      const streamMessage = slot.realtimeMessages[index];
      const streamTurnId = effectiveMessageTurnId(streamMessage);
      const streamMessageId = streamMessage.id;
      if (streamTurnId && hasServerMessageForTurn(streamMessage, slot.serverMessages)) {
        slot.realtimeMessages = slot.realtimeMessages.filter((item) => item.id !== streamMessageId);
      } else if (!normalizeMessageText(streamMessage.content)) {
        slot.realtimeMessages = slot.realtimeMessages.filter((item) => item.id !== streamMessageId);
      } else {
        const finalMessage: ChatMessage = {
          ...streamMessage,
          id: streamTurnId ? `__final_${id}_${streamTurnId}` : `text_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          isStreaming: false,
        };
        const nextMessages = slot.realtimeMessages.filter((item, itemIndex) => (
          itemIndex === index
          || !(streamTurnId && item.role === 'assistant' && effectiveMessageTurnId(item) === streamTurnId)
        ));
        const nextIndex = nextMessages.findIndex((item) => item.id === streamMessageId);
        if (nextIndex >= 0) {
          nextMessages[nextIndex] = finalMessage;
        } else {
          nextMessages.push(finalMessage);
        }
        slot.realtimeMessages = nextMessages;
      }
    }
    stream.accumulated = '';
    stream.turnId = null;
    notifyStore();
  }, [flushStreaming, getSlot, getStreamSlot, notifyStore]);

  useEffect(() => {
    if (!auth || !tenantContext) {
      // A tenant provider has a deliberate null verification window. Do not
      // clear the persisted session or navigate away while /api/auth/me is
      // still establishing the verified context.
      if (!tenantContext) return;
      if (!anonymous) redirectToLogin();
      return;
    }
    loadSessions();
  }, [anonymous, auth, loadSessions, redirectToLogin, tenantContext]);

  useEffect(() => {
    if (!auth) return;
    const timer = window.setInterval(loadSessions, 2500);
    return () => window.clearInterval(timer);
  }, [auth, loadSessions]);

  useEffect(() => {
    if (!auth) return;
    void loadHandoffs();
    const timer = window.setInterval(() => {
      void loadHandoffs();
    }, 15000);
    return () => window.clearInterval(timer);
  }, [auth, loadHandoffs]);

  useEffect(() => {
    if (!auth) return;
    tenantClient
      .get<UIConfigRead>('/api/chat/ui-config')
      .then((config) => {
        if (isWorkspaceCurrent()) setUiConfig(config);
      })
      .catch(() => undefined);
  }, [auth, isWorkspaceCurrent, tenantClient, tenantId]);

  useEffect(() => {
    if (sessionId) {
      pendingPromotedSessionIdRef.current = null;
    }
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || !auth || !tenantContext) return;
    void loadMessages(sessionId).finally(() => {
      void loadTraces(sessionId);
    });
  }, [auth, loadMessages, loadTraces, sessionId, tenantContext]);

  useEffect(() => {
    if (!sessionId || runningTurn?.sessionId !== sessionId) return;
    const timer = window.setInterval(() => {
      void loadMessages(sessionId).finally(() => {
        void loadTraces(sessionId);
      });
    }, 1500);
    return () => window.clearInterval(timer);
  }, [loadMessages, loadTraces, runningTurn?.sessionId, sessionId]);

  // A TL turn ends as soon as the team DAG is dispatched. The eventual synthesis is
  // persisted asynchronously, outside that turn's SSE stream, so keep the active team
  // conversation synchronized even while there is no locally running turn.
  useEffect(() => {
    if (!sessionId || !displayedTeamId || runningTurn?.sessionId === sessionId) return;
    const timer = window.setInterval(() => {
      void loadMessages(sessionId).finally(() => {
        void loadTraces(sessionId);
      });
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [displayedTeamId, loadMessages, loadTraces, runningTurn?.sessionId, sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    const session = sessions.find((item) => item.id === sessionId);
    if (session) {
      markSessionRead(sessionId, session.updated_at);
    }
  }, [markSessionRead, sessionId, sessions]);

  useLayoutEffect(() => {
    const conversationChanged = activeConversationId !== lastActiveConversationIdRef.current;
    lastActiveConversationIdRef.current = activeConversationId;
    const messageCountChanged = displayedMessages.length !== lastDisplayedMessageCountRef.current;
    lastDisplayedMessageCountRef.current = displayedMessages.length;
    if (conversationChanged) {
      isChatStickyToBottomRef.current = true;
      scrollChatToBottom({ preserveShortContentTop: !currentTraceRunning, force: true });
      return;
    }
    if (messageCountChanged && isChatStickyToBottomRef.current) {
      scrollChatToBottom();
    }
  }, [activeConversationId, currentTraceRunning, displayedMessages.length, scrollChatToBottom]);

  useEffect(() => {
    if (!currentTraceRunning) return;
    if (!isChatStickyToBottomRef.current) return;
    scrollChatToBottom();
  }, [currentTraceRunning, scrollChatToBottom, streamTick, traceTick]);

  useEffect(() => () => {
    streamRef.current.forEach((slot) => {
      if (slot.timer) window.clearTimeout(slot.timer);
    });
    terminalTurnSyncRef.current.forEach((slot) => {
      if (slot.timer) window.clearTimeout(slot.timer);
    });
    terminalTurnSyncRef.current.clear();
  }, []);

  const openRename = useCallback((session: ChatSession) => {
    setRenameSession(session);
    setRenameTitle(session.title || session.summary || session.last_agent_question || '');
  }, []);

  /** 保存会话标题；标题本身是用户输入，校验与失败提示使用本地化产品文案。 */
  const saveRename = useCallback(async () => {
    if (!renameSession || !isWorkspaceCurrent()) return;
    const title = renameTitle.trim();
    if (!title) {
      notify.warning(t('chat.error.renameRequired'));
      return;
    }
    try {
      const updated = await tenantClient.put<ChatSession>(`/api/chat/sessions/${renameSession.id}`, {
        title,
      });
      if (!isWorkspaceCurrent()) return;
      setSessions((items) => items.map((item) => (item.id === updated.id ? updated : item)));
      setRenameSession(null);
      setRenameTitle('');
      notify.successText(t('chat.notice.renamed'));
    } catch (error) {
      if (!isWorkspaceCurrent()) return;
      console.error('[chat] rename session failed', error);
      notify.error(t('chat.error.renameFailed'));
    }
  }, [isWorkspaceCurrent, renameSession, renameTitle, t, tenantClient, tenantId]);

  const requestDelete = useCallback((session: ChatSession) => {
    setPendingDelete(session);
  }, []);

  /** 删除会话并清理本地流状态；技术异常保留在日志，用户只看到稳定错误。 */
  const confirmDeleteSession = useCallback(async () => {
    const target = pendingDelete;
    if (!target || !isWorkspaceCurrent()) return;
    setPendingDelete(null);
    const stream = getStreamSlot(target.id);
    stream.abortController?.abort();
    streamRef.current.delete(target.id);
    storeRef.current.delete(target.id);
    try {
      await tenantClient.delete(`/api/chat/sessions/${target.id}`);
      if (!isWorkspaceCurrent()) return;
      forgetMissingSession(target.id);
      if (target.id === sessionId) {
        navigate(CHAT_BASE_PATH);
      }
      notify.successText(t('chat.notice.deleted'));
    } catch (error) {
      if (!isWorkspaceCurrent()) return;
      if (isAuthError(error)) {
        redirectToLogin();
        return;
      }
      console.error('[chat] delete session failed', error);
      notify.error(t('chat.error.deleteFailed'));
    }
  }, [forgetMissingSession, getStreamSlot, isWorkspaceCurrent, navigate, pendingDelete, redirectToLogin, t, tenantClient, sessionId, tenantId]);

  const abortStream = useCallback(() => {
    if (!activeConversationId) return;
    const stream = getStreamSlot(activeConversationId);
    if (!stream.loading && stream.cancelledTurnId) return;
    const cancelledTurnId = stream.turnId || (
      runningTurn?.sessionId === activeConversationId ? runningTurn.turnId : null
    );
    const controller = stream.abortController;
    locallyCancelledSessionIdsRef.current.add(activeConversationId);
    const releaseLocalCancellation = () => {
      locallyCancelledSessionIdsRef.current.delete(activeConversationId);
      if (isDraftConversationKey(activeConversationId)) return;
      void loadMessages(activeConversationId);
      void loadTraces(activeConversationId);
      void loadSessions();
    };
    const cancelRequest = cancelledTurnId && !isDraftConversationKey(activeConversationId)
      ? tenantClient.post(`/api/chat/sessions/${activeConversationId}/cancel`, {
          turn_id: cancelledTurnId,
        }).catch(() => undefined)
      : Promise.resolve();
    if (cancelledTurnId) {
      upsertTraceLine(cancelledTurnId, {
        id: 'generation_stopped',
        kind: 'decision',
        text: t('chat.trace.generationStopped'),
        state: 'completed',
      });
      finishTrace(cancelledTurnId);
    }
    clearStreamSlot(activeConversationId, false);
    if (cancelledTurnId) {
      upsertTraceStatusPlaceholder(getSlot(activeConversationId), activeConversationId, cancelledTurnId);
      notifyStore();
    }
    const stoppedStream = getStreamSlot(activeConversationId);
    stoppedStream.cancelledTurnId = cancelledTurnId;
    setRunningTurn((current) => (current?.sessionId === activeConversationId ? null : current));
    notifyStream();
    const abortAfterCancel = () => {
      controller?.abort();
    };
    if (controller) {
      const cancelDeadline = new Promise<void>((resolve) => {
        window.setTimeout(resolve, 300);
      });
      void Promise.race([cancelRequest, cancelDeadline]).then(abortAfterCancel, abortAfterCancel);
    }
    void cancelRequest.finally(() => {
      window.setTimeout(releaseLocalCancellation, 180);
    });
  }, [
    activeConversationId,
    clearStreamSlot,
    finishTrace,
    getSlot,
    getStreamSlot,
    loadMessages,
    loadSessions,
    loadTraces,
    notifyStore,
    notifyStream,
    runningTurn,
    tenantClient,
    tenantId,
    t,
    upsertTraceLine,
  ]);

  /** 保存消息反馈并在请求失败时恢复本地状态，错误文本不直接暴露服务端异常。 */
  const rateMessage = useCallback(async (item: ChatMessage, rating: 'up' | 'down') => {
    if (!sessionId || !isWorkspaceCurrent()) return;
    const previous = item.feedback_rating || null;
    const next = previous === rating ? null : rating;
    updateMessageFeedback(sessionId, item.id, next);
    try {
      if (next) {
        await tenantClient.post(`/api/chat/messages/${item.id}/feedback`, { rating: next });
      } else {
        await tenantClient.delete(`/api/chat/messages/${item.id}/feedback`);
      }
      if (!isWorkspaceCurrent()) return;
    } catch (error) {
      if (!isWorkspaceCurrent()) return;
      updateMessageFeedback(sessionId, item.id, previous);
      if (isAuthError(error)) {
        redirectToLogin();
        return;
      }
      console.error('[chat] message feedback failed', error);
      notify.error(t('chat.error.feedbackFailed'));
    }
  }, [isWorkspaceCurrent, redirectToLogin, sessionId, t, tenantClient, tenantId, updateMessageFeedback]);

  /** 将用户确认的定时任务写入服务端；任务标题作为业务值插入本地化通知。 */
  const confirmScheduledTask = useCallback(async (draft: ScheduledTaskDraftRead, draftKey?: string) => {
    if (!sessionId || !isWorkspaceCurrent()) return;
    try {
      const saved = await tenantClient.post<ScheduledTaskRead>('/api/chat/scheduled-tasks', {
        agent_id: draft.agent_id,
        title: draft.title,
        prompt: draft.prompt,
        description: draft.description,
        schedule_type: draft.schedule_type,
        schedule: draft.schedule,
        timezone: draft.timezone || getClientTimeZone(),
        rrule: draft.rrule,
        status: 'active',
        concurrency_policy: 'forbid',
        misfire_policy: 'coalesce',
        source_session_id: draft.source_session_id || sessionId,
        metadata: {
          created_from: 'chat_confirmation',
          confidence: draft.confidence,
          reason: draft.reason,
        },
      });
      if (!isWorkspaceCurrent()) return;
      const createdKey = draftKey || `session:${sessionId}`;
      setCreatedScheduledTasks((prev) => ({ ...prev, [createdKey]: saved }));
      setScheduledDrafts((prev) => {
        const next = { ...prev };
        delete next[sessionId];
        return next;
      });
      notify.successText(t('chat.notice.scheduledEnabled', { title: saved.title }));
    } catch (error) {
      if (!isWorkspaceCurrent()) return;
      if (isAuthError(error)) {
        redirectToLogin();
        return;
      }
      console.error('[chat] scheduled task creation failed', error);
      notify.error(t('chat.error.scheduleCreateFailed'));
    }
  }, [isWorkspaceCurrent, redirectToLogin, sessionId, t, tenantClient, tenantId]);

  const dismissScheduledTaskDraft = useCallback((messageId?: string) => {
    if (!sessionId) return;
    setScheduledDrafts((prev) => {
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
    if (messageId) {
      setDismissedDraftMessageIds((prev) => (prev.includes(messageId) ? prev : [...prev, messageId]));
    }
  }, [sessionId]);

  const handleStreamEvent = useCallback((
    item: StreamEvent,
    baseSessionId: string,
    turnId: string,
    options?: { preserveExistingStreamTurn?: boolean },
  ) => {
    const eventSessionId = String(item.data.sessionId || baseSessionId);
    const traceTurnId = explicitStreamTurnId(item.data, turnId);
    const eventStream = getStreamSlot(eventSessionId);
    const ownsStreamTurn = Boolean(eventStream.turnId)
      && (eventStream.turnId === traceTurnId || eventStream.turnId === turnId);
    const shouldTouchStream = !options?.preserveExistingStreamTurn || ownsStreamTurn;
    const upsertVisibleTraceLine = (line: TraceLine) => {
      upsertTraceLine(traceTurnId, line);
      if (shouldTouchStream && traceTurnId) {
        ensureStreamingTraceMessage(eventSessionId, traceTurnId);
      }
    };
    if (item.event === 'session_created') return;
    if (item.event === 'heartbeat') return;
    if (item.event === 'session_title_summarized') {
      applySessionTitleSummary(eventSessionId, item.data.title);
      return;
    }
    if (item.event === 'scheduled_task_draft') {
      const draft = item.data as unknown as ScheduledTaskDraftRead;
      if (draft.should_create) {
        setScheduledDrafts((prev) => ({ ...prev, [eventSessionId]: draft }));
      }
      if (traceTurnId) {
        if (shouldTouchStream && eventStream.turnId !== traceTurnId) {
          eventStream.turnId = traceTurnId;
        }
        scheduledTaskTraceLines(draft, locale, t).forEach(upsertVisibleTraceLine);
        finishTrace(traceTurnId);
        notifyStream();
      }
      return;
    }
    if (traceTurnId && !STREAM_TERMINAL_EVENTS.has(item.event)) {
      if (shouldTouchStream && eventStream.turnId !== traceTurnId) {
        eventStream.turnId = traceTurnId;
      }
    }
    if (item.event === 'router_decision') {
      upsertVisibleTraceLine(routerDecisionTraceLine(item.data, t));
      return;
    }
    if (item.event === 'step_result') {
      upsertVisibleTraceLine(stepResultTraceLine(item.data, t));
      return;
    }
    if (
      item.event === 'task_frame_started'
      || item.event === 'task_frame_finished'
      || item.event === 'harness_action_created'
      || item.event === 'harness_mcp_app_view'
      || item.event === 'harness_tool_completed'
      || item.event === 'harness_step_timeout'
    ) {
      const line = harnessEventTraceLine(item.event, item.data, t);
      if (line) upsertVisibleTraceLine(line);
      return;
    }
    if (item.event === 'skill_state') {
      const skills = Array.isArray(item.data.currentSkills) ? item.data.currentSkills : [];
      skills
        .map((entry) => normalizeTraceSkill(entry))
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
        .forEach((skill, index) => {
          const label = streamSkillLabel(item.data, skill, t);
          const stateKey = skill.stepId || String(index);
          upsertVisibleTraceLine({
            id: `skill_state_${skill.skillId}_${skill.state || 'active'}_${stateKey}`,
            kind: 'skill',
            text: `${label} ${skill.name || skill.skillId}`,
            detail: skill.stepId ? t('chat.trace.taskFrameStep', { stepId: skill.stepId }) : undefined,
            state: skill.state === 'suspended' ? 'completed' : 'running',
            icon: 'advance',
          });
        });
      return;
    }
    if (item.event === 'general_skill_state') {
      const skillName = typeof item.data.skillName === 'string' ? item.data.skillName : '';
      const skillSlug = typeof item.data.skillSlug === 'string' ? item.data.skillSlug : '';
      upsertVisibleTraceLine({
        id: `general_skill_${skillSlug || skillName || 'selected'}`,
        kind: 'skill',
        text: t('chat.trace.selectGeneralSkill', { skillName: skillName || skillSlug || t('chat.empty.unset') }),
        detail: skillSlug || undefined,
        state: 'running',
        icon: 'advance',
      });
      return;
    }
    if (item.event === 'general_skill_trace') {
      const phase = typeof item.data.phase === 'string' ? item.data.phase : 'trace';
      if (HIDDEN_GENERAL_SKILL_TRACE_PHASES.has(phase)) {
        notifyStream();
        return;
      }
      const text = t('chat.trace.runGeneralSkill');
      const code = typeof item.data.code === 'string' ? item.data.code : '';
      const runtime = typeof item.data.runtime === 'string' ? item.data.runtime : '';
      const attempt = typeof item.data.attempt === 'number' || typeof item.data.attempt === 'string'
        ? String(item.data.attempt)
        : '';
      const trace = getTurnTrace(traceTurnId);
      const sequence = trace.lines.length;
      const isOutputChunk = phase === 'stdout_chunk' || phase === 'stderr_chunk';
      const id = isOutputChunk
        ? `general_skill_trace_${phase}_${attempt || 'current'}`
        : `general_skill_trace_${phase}_${attempt || sequence}`;
      const rawDetail = generalSkillTraceDetail(item.data, phase);
      const existing = trace.lines.find((line) => line.id === id);
      const previousOutput = existing?.output || existing?.detail || '';
      const detail = isOutputChunk && previousOutput && rawDetail ? `${previousOutput}${rawDetail}` : rawDetail;
      const outputInfo = generalSkillTraceOutput(item.data, phase, detail, t);
      const codePhases = new Set(['plan_created', 'plan_failed', 'attempt_started', 'running_code', 'stdout_chunk', 'stderr_chunk', 'code_finished', 'code_timeout']);
      const runningPhases = new Set(['planning', 'repair_planning', 'attempt_started', 'running_code', 'reflection_reviewing', 'replying']);
      upsertVisibleTraceLine({
        id,
        kind: codePhases.has(phase) ? 'code' : 'decision',
        text,
        detail: outputInfo.output ? undefined : detail,
        code: code || undefined,
        language: code ? (runtime === 'bash' ? 'bash' : 'python') : undefined,
        output: outputInfo.output,
        outputLanguage: outputInfo.language,
        outputTitle: outputInfo.title,
        state: runningPhases.has(phase) ? 'running' : phase.includes('failed') || phase === 'code_timeout' ? 'failed' : 'completed',
        collapsible: Boolean(code || outputInfo.output),
        icon: codePhases.has(phase)
          ? 'generated'
          : phase.startsWith('reflection_') || phase === 'repair_planning'
            ? 'loading'
            : 'advance',
      });
      return;
    }
    if (item.event === 'knowledge_result') {
      upsertVisibleTraceLine({
        id: knowledgeTraceLineId(item.data),
        kind: 'knowledge',
        text: t('chat.trace.readKnowledge'),
        detail: knowledgeResultTraceDetail(item.data, t),
        state: 'completed',
        icon: 'advance',
      });
      return;
    }
    if (item.event === 'tool_result') {
      const tool = normalizeTraceTool(item.data);
      if (tool) {
        const output = formatTracePayload(tool.content);
        upsertVisibleTraceLine({
          id: `tool_${tool.toolCallId || tool.rawToolName || tool.toolId}`,
          kind: 'tool',
          text: tool.isError
            ? t('chat.trace.toolCallFailed')
            : t('chat.trace.toolCall', { toolName: tool.toolName }),
          detail: toolTraceDetail(tool, t),
          output: output || undefined,
          outputLanguage: output ? 'json' : undefined,
          outputTitle: output ? t('chat.trace.toolResult') : undefined,
          state: tool.isError ? 'failed' : 'completed',
          icon: 'tool',
        });
      }
      return;
    }
    if (item.event === 'agent_loop_continued' || item.event === 'agent_loop_completed') {
      const iteration = typeof item.data.iteration === 'number' || typeof item.data.iteration === 'string' ? String(item.data.iteration) : '1';
      const targetTool = typeof item.data.target_tool_name === 'string' ? item.data.target_tool_name : '';
      upsertVisibleTraceLine({
        id: `decision_stepping_tool_continuation_${iteration}`,
        kind: 'decision',
        text: t('chat.trace.reanalysis'),
        detail: item.event === 'agent_loop_continued'
          ? (targetTool
            ? t('chat.trace.continueTool', { toolName: targetTool })
            : t('chat.trace.continueToolGeneric'))
          : t('chat.trace.noContinueTool'),
        state: 'completed',
        icon: 'loading',
      });
      return;
    }
    if (item.event === 'reflection_decision') {
      const needsRetry = item.data.needs_retry === true;
      const skipped = item.data.skipped === true;
      const attempt = item.data.attempt;
      const maxAttempts = item.data.max_attempts;
      const hasRetryMetadata = (
        typeof attempt === 'number'
        && Number.isInteger(attempt)
        && typeof maxAttempts === 'number'
        && Number.isInteger(maxAttempts)
      );
      upsertVisibleTraceLine({
        id: 'reflection',
        kind: 'decision',
        text: skipped
          ? t('chat.trace.reflectionClosed')
          : needsRetry
            ? hasRetryMetadata
              ? t('chat.trace.reflectionRetry', { attempt, max_attempts: maxAttempts })
              : t('chat.trace.reflectionRetryLegacy')
            : t('chat.trace.reflectionPassed'),
        detail: reflectionTraceDetail(item.data, t),
        state: 'completed',
        icon: 'loading',
      });
      return;
    }
    if (item.event === 'status') {
      if (shouldTouchStream && traceTurnId && eventStream.turnId !== traceTurnId) {
        eventStream.turnId = traceTurnId;
      }
      const phase = typeof item.data.phase === 'string' ? item.data.phase : 'thinking';
      const canonicalMessage = canonicalStatusMessage(item.data, t);
      if (canonicalMessage !== null) {
        // Workflow: canonical events own product wording; legacy phase/text fields remain
        // compatibility input only and cannot override the localized code projection.
        if (shouldTouchStream) eventStream.phase = canonicalMessage;
        if (phase !== 'responding') {
          upsertVisibleTraceLine({
            id: 'canonical_status',
            kind: 'decision',
            text: canonicalMessage,
            state: 'running',
            icon: 'advance',
          });
        }
        notifyStream();
        return;
      }
      if (phase === 'responding') {
        notifyStream();
        return;
      }
      if (shouldTouchStream) {
        eventStream.phase = publicStreamPhase(item.data, t);
      }
      const scheduledTaskLine = scheduledTaskStatusTraceLine(phase, item.data, locale, t);
      if (scheduledTaskLine) {
        upsertVisibleTraceLine(scheduledTaskLine);
      } else if (phase === 'error') {
        upsertVisibleTraceLine(streamErrorTraceLine(item.data, 'error_occurred', t));
        finishTrace(traceTurnId, true);
      } else if (phase === 'tool' && typeof item.data.tool_name === 'string') {
        const toolCallId = typeof item.data.tool_call_id === 'string' ? item.data.tool_call_id : item.data.tool_name;
        upsertVisibleTraceLine({
          id: `tool_${toolCallId}`,
          kind: 'tool',
          text: t('chat.trace.callingTool', { toolName: item.data.tool_name }),
          state: 'running',
          icon: 'tool',
        });
      } else if (phase === 'routing') {
        upsertVisibleTraceLine({
          id: 'decision_router',
          kind: 'decision',
          text: t('chat.trace.decideIntent'),
          state: 'running',
          icon: 'judge',
        });
      } else if (isKnowledgeTracePhase(phase)) {
        upsertVisibleTraceLine({
          id: knowledgeTraceLineId(item.data),
          kind: 'knowledge',
          text: knowledgeTraceText(item.data, t),
          detail: knowledgeTraceDetail(item.data, t),
          state: phase === 'evidence_pack' || phase.startsWith('no_') || phase === 'okf_only' ? 'completed' : 'running',
          icon: 'advance',
        });
      } else if (phase === 'stepping') {
        const repairReason = typeof item.data.repair_reason === 'string' ? item.data.repair_reason : 'main';
        const iteration = typeof item.data.iteration === 'number' || typeof item.data.iteration === 'string' ? `_${item.data.iteration}` : '';
        upsertVisibleTraceLine({
          id: `decision_stepping_${repairReason}${iteration}`,
          kind: 'decision',
          text: repairReason === 'main' ? t('chat.trace.nextStep') : t('chat.trace.reanalysis'),
          state: 'running',
          icon: repairReason === 'main' ? 'advance' : 'loading',
        });
      } else if (phase === 'reflecting') {
        upsertVisibleTraceLine({
          id: 'reflection',
          kind: 'decision',
          text: t('chat.trace.reflecting'),
          state: 'running',
          icon: 'loading',
        });
      } else if (phase !== 'received') {
        upsertVisibleTraceLine({
          id: `decision_status_${phase}`,
          kind: 'decision',
          text: shouldTouchStream ? eventStream.phase : publicStreamPhase(item.data, t),
          state: 'running',
          icon: 'advance',
        });
      }
      notifyStream();
      return;
    }
    if (item.event === 'stream_replace') {
      if (!shouldTouchStream) return;
      const next = typeof item.data.content === 'string' ? item.data.content : '';
      if (eventStream.timer) {
        window.clearTimeout(eventStream.timer);
        eventStream.timer = null;
      }
      eventStream.accumulated = next;
      updateStreaming(eventSessionId, next, getStreamSlot(eventSessionId).turnId || traceTurnId);
      notifyStream();
      return;
    }
    if (item.event === 'stream_delta' || item.event === 'token') {
      if (!shouldTouchStream) return;
      const piece = typeof item.data.content === 'string' ? item.data.content : '';
      if (!piece) return;
      const previous = eventStream.accumulated;
      let next = previous + piece;
      if (previous) {
        if (piece === previous) return;
        if (piece.startsWith(previous)) {
          next = piece;
        }
      }
      if (next === previous) return;
      const hadVisibleText = Boolean(normalizeMessageText(previous));
      eventStream.accumulated = next;
      if (!normalizeMessageText(next)) return;
      if (!hadVisibleText) {
        updateStreaming(eventSessionId, eventStream.accumulated, eventStream.turnId || traceTurnId);
        notifyStream();
        return;
      }
      if (!eventStream.timer) {
        eventStream.timer = window.setTimeout(() => {
          eventStream.timer = null;
          updateStreaming(eventSessionId, eventStream.accumulated, eventStream.turnId || traceTurnId);
        }, 100);
      }
      return;
    }
    if (item.event === 'stream_end') {
      finishTrace(traceTurnId);
      if (!shouldTouchStream) {
        syncTurnUntilAssistant(eventSessionId, traceTurnId);
        notifyTrace();
        return;
      }
      const hadStreamContent = Boolean(normalizeMessageText(eventStream.accumulated));
      finalizeStreaming(eventSessionId);
      if (!hadStreamContent && !hasAssistantMessageForTurn(getSlot(eventSessionId), traceTurnId)) {
        upsertTraceStatusPlaceholder(getSlot(eventSessionId), eventSessionId, traceTurnId);
        notifyStore();
      }
      eventStream.loading = false;
      eventStream.phase = '';
      eventStream.abortController = null;
      eventStream.relayRecoveryStartedAt = null;
      eventStream.relayRecoveryTurnId = null;
      setRunningTurn((current) => (
        current?.sessionId === eventSessionId && current.turnId === traceTurnId ? null : current
      ));
      notifyStream();
      loadSessions();
      window.setTimeout(() => {
        loadMessages(eventSessionId);
        loadTraces(eventSessionId);
        syncTurnUntilAssistant(eventSessionId, traceTurnId);
      }, 250);
      return;
    }
    if (item.event === 'stream_cancelled') {
      const cancelledStreamTurnId = eventStream.turnId || traceTurnId;
      finishTrace(traceTurnId);
      if (!shouldTouchStream) {
        window.setTimeout(() => {
          loadMessages(eventSessionId);
          loadTraces(eventSessionId);
          syncTurnUntilAssistant(eventSessionId, traceTurnId);
        }, 120);
        notifyStream();
        return;
      }
      clearStreamSlot(eventSessionId, false);
      eventStream.relayRecoveryStartedAt = null;
      eventStream.relayRecoveryTurnId = null;
      upsertTraceStatusPlaceholder(getSlot(eventSessionId), eventSessionId, traceTurnId);
      notifyStore();
      window.setTimeout(() => {
        loadMessages(eventSessionId);
        loadTraces(eventSessionId);
        syncTurnUntilAssistant(eventSessionId, traceTurnId);
      }, 120);
      setRunningTurn((current) => (
        current?.sessionId === eventSessionId && (current.turnId === traceTurnId || current.turnId === cancelledStreamTurnId)
          ? null
          : current
      ));
      notifyStream();
      return;
    }
    if (item.event === 'stream_interrupted' || item.event === 'error_occurred') {
      const interruptedStreamTurnId = eventStream.turnId || traceTurnId;
      if (isMissingModelConfigurationError(item.data)) {
        invalidateModelSelection(selectedModelConfigId);
      }
      finishTrace(traceTurnId, true);
      if (!shouldTouchStream) {
        window.setTimeout(() => {
          loadMessages(eventSessionId);
          loadTraces(eventSessionId);
          syncTurnUntilAssistant(eventSessionId, traceTurnId);
        }, 120);
        notifyStream();
        return;
      }
      clearStreamSlot(eventSessionId, true);
      eventStream.relayRecoveryStartedAt = null;
      eventStream.relayRecoveryTurnId = null;
      upsertVisibleTraceLine(streamErrorTraceLine(item.data, item.event, t));
      window.setTimeout(() => {
        loadMessages(eventSessionId);
        loadTraces(eventSessionId);
        syncTurnUntilAssistant(eventSessionId, traceTurnId);
      }, 120);
      setRunningTurn((current) => (
        current?.sessionId === eventSessionId && (current.turnId === traceTurnId || current.turnId === interruptedStreamTurnId)
          ? null
          : current
      ));
      notifyStream();
      return;
    }
    if (item.event === 'complete' || item.event === 'done') {
      if (!shouldTouchStream) {
        finishTrace(traceTurnId);
        notifyStream();
        return;
      }
      const result = item.data as unknown as ChatTurnResponse;
      const userIntent = typeof result.router_decision?.user_intent === 'string' ? result.router_decision.user_intent : '';
      const decisionReason = typeof result.router_decision?.reason === 'string' ? result.router_decision.reason : '';
      if (userIntent || decisionReason) {
        upsertVisibleTraceLine({
          id: 'decision_router',
          kind: 'decision',
          text: userIntent
            ? t('chat.trace.intentWithValue', { intent: userIntent })
            : t('chat.trace.completedSopDecision'),
          detail: decisionReason || undefined,
          state: 'completed',
        });
      }
      finishTrace(traceTurnId);
      const hadStreamContent = Boolean(normalizeMessageText(eventStream.accumulated));
      finalizeStreaming(eventSessionId);
      if (!hadStreamContent && !hasAssistantMessageForTurn(getSlot(eventSessionId), traceTurnId)) {
        upsertTraceStatusPlaceholder(getSlot(eventSessionId), eventSessionId, traceTurnId);
        notifyStore();
      }
      setLastTurn(result);
      eventStream.loading = false;
      eventStream.phase = '';
      eventStream.abortController = null;
      eventStream.relayRecoveryStartedAt = null;
      eventStream.relayRecoveryTurnId = null;
      setRunningTurn((current) => (
        current?.sessionId === eventSessionId && current.turnId === traceTurnId ? null : current
      ));
      notifyStream();
      loadSessions();
      window.setTimeout(() => {
        loadMessages(eventSessionId);
        loadTraces(eventSessionId);
        syncTurnUntilAssistant(eventSessionId, traceTurnId);
      }, 250);
    }
    if (item.event === 'error') {
      if (isMissingModelConfigurationError(item.data)) {
        invalidateModelSelection(selectedModelConfigId);
      }
      if (!shouldTouchStream) {
        finishTrace(traceTurnId, true);
        notifyStream();
        return;
      }
      eventStream.loading = false;
      eventStream.phase = '';
      eventStream.abortController = null;
      eventStream.relayRecoveryStartedAt = null;
      eventStream.relayRecoveryTurnId = null;
      setRunningTurn((current) => (
        current?.sessionId === eventSessionId && current.turnId === (eventStream.turnId || traceTurnId) ? null : current
      ));
      const errorTurnId = eventStream.turnId || traceTurnId;
      upsertTraceLine(errorTurnId, streamErrorTraceLine(item.data, item.event, t));
      finishTrace(errorTurnId, true);
      console.error('[chat] scheduled task execution failed', item.data);
      appendRealtime(eventSessionId, {
        id: `scheduled_error_${Date.now()}`,
        turnId: errorTurnId,
        role: 'assistant',
        content: t('chat.error.scheduledExecutionFailed'),
        created_at: new Date().toISOString(),
        isError: true,
      });
      notifyStream();
    }
  }, [
    appendRealtime,
    applySessionTitleSummary,
    clearStreamSlot,
    finalizeStreaming,
    finishTrace,
    getSlot,
    getStreamSlot,
    invalidateModelSelection,
    getTurnTrace,
    loadMessages,
    loadSessions,
    loadTraces,
    notifyStore,
    notifyStream,
    selectedModelConfigId,
    notifyTrace,
    ensureStreamingTraceMessage,
    syncTurnUntilAssistant,
    updateStreaming,
    t,
    locale,
    upsertTraceLine,
  ]);

  const eventTextPayload = useCallback((event: ChatSessionEventRead): string => {
    const data = event.data || {};
    if (typeof data.content === 'string') return data.content;
    if (typeof data.text === 'string') return data.text;
    return '';
  }, []);

  const isTerminalEvent = useCallback((event: ChatSessionEventRead) => (
    event.event === 'complete'
    || event.event === 'done'
    || event.event === 'stream_end'
    || event.event === 'stream_cancelled'
    || event.event === 'stream_interrupted'
    || event.event === 'error_occurred'
    || event.event === 'error'
  ), []);

  const eventTime = useCallback((event: ChatSessionEventRead) => parseMessageTime(event.created_at) || 0, []);

  const hydrateRunningSessionFromEvents = useCallback((id: string, events: ChatSessionEventRead[]) => {
    if (locallyCancelledSessionIdsRef.current.has(id)) return false;
    const traceEvents = events.filter((event) => Boolean(eventTraceTurnId(event)));
    if (!traceEvents.length) return false;
    const slot = getSlot(id);
    if (slot.serverMessages.length === 0) return false;
    const stream = getStreamSlot(id);
    if (stream.loading && stream.abortController) return false;

    const groups = new Map<string, ChatSessionEventRead[]>();
    traceEvents.forEach((event) => {
      const eventTurnId = eventTraceTurnId(event);
      if (!eventTurnId) return;
      const key = `${id}:${eventTurnId}`;
      const bucket = groups.get(key) || [];
      bucket.push(event);
      groups.set(key, bucket);
    });

    const runningGroup = [...groups.values()]
      .map((group) => [...group].sort((left, right) => eventTime(left) - eventTime(right)))
      .sort((left, right) => eventTime(right[right.length - 1]) - eventTime(left[left.length - 1]))
      .find((group) => !group.some((event) => isTerminalSessionEvent(event, isTerminalEvent)));

    if (!runningGroup?.length) return false;

    const turnId = eventTraceTurnId(runningGroup[0]);
    if (!turnId) return false;
    const runningUserMessage = slot.serverMessages.find((messageItem) => (
      messageItem.role === 'user'
      && (effectiveMessageTurnId(messageItem) === turnId || messageItem.id === turnId)
    ));
    if (!runningUserMessage) return false;
    const latestRunningEventTime = eventTime(runningGroup[runningGroup.length - 1]);
    if (latestRunningEventTime <= 0 || Date.now() - latestRunningEventTime > RUNNING_EVENT_RECOVERY_WINDOW_MS) {
      clearStreamSlot(id, false);
      return false;
    }
    if (!hasRecoverableEventProgress(runningGroup)) {
      clearStreamSlot(id, false);
      return false;
    }
    if (hasAssistantCarrierForTurn(slot, turnId)) {
      clearStreamSlot(id, false);
      return false;
    }

    let text = '';
    runningGroup.forEach((event) => {
      const payloadText = eventTextPayload(event);
      if (event.event === 'stream_replace') {
        text = payloadText;
      } else if (event.event === 'stream_delta' || event.event === 'token') {
        text = text && payloadText.startsWith(text) ? payloadText : text + payloadText;
      }
    });

    const streamChanged = (
      stream.turnId !== turnId
      || !stream.loading
      || !stream.phase
      || stream.accumulated !== text
      || stream.relayRecoveryTurnId !== turnId
    );
    stream.turnId = turnId;
    stream.loading = true;
    stream.phase = stream.phase || t('chat.trace.running');
    stream.accumulated = text;
    stream.relayRecoveryStartedAt = stream.relayRecoveryStartedAt || Date.now();
    stream.relayRecoveryTurnId = turnId;
    if (streamChanged && normalizeMessageText(text)) {
      updateStreaming(id, text, turnId);
    }
    setRunningTurn((current) => (
      current?.sessionId === id && current.turnId === turnId
        ? current
        : { sessionId: id, turnId }
    ));

    const unseenRunningEvents = runningGroup.filter((event) => !scheduledEventIdsRef.current.has(event.id));
    unseenRunningEvents.forEach((event) => {
      scheduledEventIdsRef.current.add(event.id);
      const streamEvent = normalizeSessionEventForStream(event);
      if (streamEvent.event === 'stream_replace' || streamEvent.event === 'stream_delta' || streamEvent.event === 'token') return;
      handleStreamEvent(streamEvent, id, turnId);
    });

    if (streamChanged) notifyStream();
    return streamChanged || unseenRunningEvents.length > 0;
  }, [
    clearStreamSlot,
    eventTextPayload,
    eventTime,
    getSlot,
    getStreamSlot,
    handleStreamEvent,
    isTerminalEvent,
    notifyStream,
    updateStreaming,
  ]);

  const pollScheduledSessionEvents = useCallback((id: string) => {
    if (locallyCancelledSessionIdsRef.current.has(id)) return Promise.resolve();
    const inFlight = scheduledEventPollsRef.current.get(id);
    if (inFlight) return inFlight;
    const request = tenantClient
      .get<ChatSessionEventRead[]>(`/api/chat/sessions/${id}/events`)
      .then((events) => {
        const traceEvents = events.filter((event) => Boolean(eventTraceTurnId(event)));
        if (!traceEvents.length) return;
        hydrateRunningSessionFromEvents(id, traceEvents);
        const slot = getSlot(id);
        if (slot.serverMessages.length === 0) return;
        const latestLoadedMessageTime = Math.max(
          0,
          ...slot.serverMessages.map((messageItem) => parseMessageTime(messageItem.created_at)),
        );
        const now = Date.now();
        const stream = getStreamSlot(id);
        const recoveringTurnId = (
          stream.loading && !stream.abortController
            ? (stream.relayRecoveryTurnId || stream.turnId || '')
            : ''
        );
        if (recoveringTurnId) {
          const recoveryEvents = traceEvents
            .filter((event) => eventTraceTurnId(event) === recoveringTurnId)
            .sort((left, right) => eventTime(left) - eventTime(right));
          let recoveredText = '';
          recoveryEvents.forEach((event) => {
            const payloadText = eventTextPayload(event);
            if (event.event === 'stream_replace' || event.event === 'assistant_message_created') {
              recoveredText = payloadText;
            } else if (event.event === 'stream_delta' || event.event === 'token') {
              recoveredText = recoveredText && payloadText.startsWith(recoveredText)
                ? payloadText
                : recoveredText + payloadText;
            }
          });
          if (recoveredText && recoveredText !== stream.accumulated) {
            stream.accumulated = recoveredText;
            updateStreaming(id, recoveredText, recoveringTurnId);
            notifyStream();
          }
          const hasTerminalRecoveryEvent = recoveryEvents.some((event) => isTerminalSessionEvent(event, isTerminalEvent));
          if (
            stream.relayRecoveryStartedAt
            && !hasTerminalRecoveryEvent
            && !hasAssistantMessageForTurn(slot, recoveringTurnId)
            && now - stream.relayRecoveryStartedAt >= CHAT_STREAM_IDLE_TIMEOUT_MS
          ) {
            clearStreamSlot(id, true);
            upsertTraceLine(recoveringTurnId, {
              id: 'stream_relay_timeout',
              kind: 'thinking',
              text: t('chat.trace.responseTimeout'),
              detail: t('chat.trace.responseTimeoutDetail'),
              state: 'failed',
              icon: 'loading',
            });
            finishTrace(recoveringTurnId, true);
            appendRealtime(id, {
              id: `stream_relay_timeout_${recoveringTurnId}_${Date.now()}`,
              turnId: recoveringTurnId,
              role: 'assistant',
              content: t('chat.error.streamSyncTimeout'),
              created_at: new Date().toISOString(),
              isError: true,
            });
            setRunningTurn((current) => (
              current?.sessionId === id && current.turnId === recoveringTurnId ? null : current
            ));
            notifyStore();
            notifyStream();
            return;
          }
        }
        const unseenEvents = traceEvents.filter((event) => {
          if (scheduledEventIdsRef.current.has(event.id)) return false;
          const timestamp = eventTime(event);
          return timestamp > 0 && (timestamp >= latestLoadedMessageTime || now - timestamp <= RUNNING_EVENT_RECOVERY_WINDOW_MS);
        });
        if (!unseenEvents.length) return;
        const unseenEventsByTurn = new Map<string, ChatSessionEventRead[]>();
        unseenEvents.forEach((event) => {
          const eventTurnId = eventTraceTurnId(event);
          if (!eventTurnId) return;
          const bucket = unseenEventsByTurn.get(eventTurnId) || [];
          bucket.push(event);
          unseenEventsByTurn.set(eventTurnId, bucket);
        });
        unseenEvents.forEach((event) => {
          const eventTurnId = eventTraceTurnId(event);
          if (!eventTurnId) return;
          const liveSseOwnsTurn = Boolean(stream.abortController && stream.turnId === eventTurnId);
          const terminalEvent = isTerminalSessionEvent(event, isTerminalEvent);
          if (shouldDeferPersistedEventToLiveStream(event.event, liveSseOwnsTurn)) return;
          scheduledEventIdsRef.current.add(event.id);
          const hasFinalAssistant = hasAssistantMessageForTurn(slot, eventTurnId);
          if (event.event === 'assistant_message_created') {
            if (!hasFinalAssistant) {
              void loadMessages(id);
              void loadTraces(id);
              syncTurnUntilAssistant(id, eventTurnId);
            }
            return;
          }
          if (terminalEvent && !hasFinalAssistant) {
            syncTurnUntilAssistant(id, eventTurnId);
          }
          const streamEvent = normalizeSessionEventForStream(event);
          if (recoveringTurnId && eventTurnId === recoveringTurnId && STREAM_TEXT_EVENTS.has(streamEvent.event)) {
            return;
          }
          const turnEvents = unseenEventsByTurn.get(eventTurnId) || [event];
          const hasTurnProgress = hasRecoverableEventProgress(turnEvents);
          if (hasAssistantCarrierForTurn(slot, eventTurnId)) return;
          if (!stream.turnId && !terminalEvent && hasTurnProgress) {
            stream.turnId = eventTurnId;
          }
          if (!stream.loading && !terminalEvent) {
            if (!hasTurnProgress) {
              handleStreamEvent(streamEvent, id, eventTurnId, { preserveExistingStreamTurn: true });
              return;
            }
            stream.loading = true;
            stream.phase = t('chat.trace.running');
            if (hasRenderableStreamingText(stream.accumulated)) {
              updateStreaming(id, stream.accumulated, eventTurnId);
            }
            notifyStream();
          }
          handleStreamEvent(streamEvent, id, eventTurnId, { preserveExistingStreamTurn: true });
        });
      })
      .catch((error) => {
        if (isAuthError(error)) {
          redirectToLogin();
        }
      })
      .finally(() => {
        if (scheduledEventPollsRef.current.get(id) === request) {
          scheduledEventPollsRef.current.delete(id);
        }
      });
    scheduledEventPollsRef.current.set(id, request);
    return request;
  }, [
    appendRealtime,
    clearStreamSlot,
    eventTextPayload,
    eventTime,
    finishTrace,
    getSlot,
    getStreamSlot,
    handleStreamEvent,
    hydrateRunningSessionFromEvents,
    isTerminalEvent,
    loadMessages,
    loadTraces,
    notifyStore,
    notifyStream,
    redirectToLogin,
    syncTurnUntilAssistant,
    tenantClient,
    tenantId,
    updateStreaming,
    t,
    upsertTraceLine,
  ]);

  const uploadComposerFiles = useCallback((files: File[]) => {
    const validFiles = files.filter((file) => file.size > 0);
    if (!validFiles.length) return;
    validFiles.forEach((file) => {
      const uploadKey = `upload_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      const controller = new AbortController();
      const scopeSignal = workspaceSignal();
      const onScopeAbort = () => controller.abort();
      if (scopeSignal?.aborted) controller.abort();
      else scopeSignal?.addEventListener('abort', onScopeAbort, { once: true });
      uploadControllersRef.current.set(uploadKey, controller);
      setComposerAttachments((current) => [
        ...current,
        {
          id: uploadKey,
          uploadKey,
          filename: file.name || t('chat.composer.clipboardFile'),
          content_type: file.type || 'application/octet-stream',
          size: file.size,
          kind: file.type.startsWith('image/') ? 'image' : 'binary',
          uploadStatus: 'uploading',
        },
      ]);
      uploadChatAttachments<ChatAttachmentRead[]>(tenantId, [file], controller.signal)
        .then((items) => {
          if (!isWorkspaceCurrent() || controller.signal.aborted) return;
          const parsed = items[0];
          if (!parsed) throw new Error('chat.error.uploadParseFailed');
          setComposerAttachments((current) =>
            current.map((item) => (item.uploadKey === uploadKey ? { ...parsed, uploadKey, uploadStatus: 'ready' } : item)),
          );
        })
        .catch((error) => {
          if (controller.signal.aborted || !isWorkspaceCurrent()) return;
          setComposerAttachments((current) =>
            current.map((item) => (
              item.uploadKey === uploadKey
                ? { ...item, uploadStatus: 'error', error: t('chat.error.uploadFailed') }
                : item
            )),
          );
        })
        .finally(() => {
          scopeSignal?.removeEventListener('abort', onScopeAbort);
          uploadControllersRef.current.delete(uploadKey);
        });
    });
  }, [isWorkspaceCurrent, t, tenantId, workspaceSignal]);

  const removeComposerAttachment = useCallback((uploadKey: string) => {
    uploadControllersRef.current.get(uploadKey)?.abort();
    uploadControllersRef.current.delete(uploadKey);
    setComposerAttachments((current) => current.filter((item) => item.uploadKey !== uploadKey));
  }, []);

  const handleComposerFileChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    uploadComposerFiles(files);
    event.target.value = '';
  }, [uploadComposerFiles]);

  const handleComposerDragEnter = useCallback((event: DragEvent<HTMLFormElement>) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    setComposerDragActive(true);
  }, []);

  const handleComposerDragOver = useCallback((event: DragEvent<HTMLFormElement>) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    setComposerDragActive(true);
  }, []);

  const handleComposerDragLeave = useCallback((event: DragEvent<HTMLFormElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setComposerDragActive(false);
    }
  }, []);

  const handleComposerDrop = useCallback((event: DragEvent<HTMLFormElement>) => {
    const files = Array.from(event.dataTransfer.files || []);
    if (!files.length) return;
    event.preventDefault();
    setComposerDragActive(false);
    uploadComposerFiles(files);
  }, [uploadComposerFiles]);

  useEffect(() => {
    if (!auth || !sessionId || isDraftConversationKey(sessionId)) return;
    const pollCurrentSessionEvents = () => {
      void pollScheduledSessionEvents(sessionId);
    };
    pollCurrentSessionEvents();
    const timer = window.setInterval(pollCurrentSessionEvents, STREAM_RELAY_RECOVERY_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [auth, pollScheduledSessionEvents, sessionId]);

  useEffect(() => {
    if (!auth) return;
    const pollBackgroundSessions = () => {
      const ids = new Set<string>();
      const isLiveSseSession = (id: string) => Boolean(streamRef.current.get(id)?.abortController);
      sessions.forEach((session) => {
        const looksRunning = session.status === 'running' || session.status === 'executing';
        const updatedAt = parseMessageTime(session.updated_at);
        const recentlyUpdated = updatedAt > 0 && Date.now() - updatedAt <= RUNNING_EVENT_RECOVERY_WINDOW_MS;
        if (looksRunning && recentlyUpdated && !isLiveSseSession(session.id)) ids.add(session.id);
      });
      streamRef.current.forEach((slot, id) => {
        if (slot.loading && !slot.abortController && !isDraftConversationKey(id)) ids.add(id);
      });
      Array.from(ids).slice(0, 8).forEach((id) => {
        void pollScheduledSessionEvents(id);
      });
    };
    pollBackgroundSessions();
    const timer = window.setInterval(pollBackgroundSessions, STREAM_RELAY_RECOVERY_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [auth, pollScheduledSessionEvents, sessionId, sessions]);

  /** 执行一次聊天发送及流式恢复流程；用户输入和附件作为 raw 业务数据原样传输。 */
  const executePreparedTurn = useCallback(async (
    prepared: PreparedChatTurn,
    options: { queued?: boolean } = {},
  ) => {
    if (!isWorkspaceCurrent()) return;
    const resolvedInteractionMode = prepared.interactionMode;
    const currentConversationId = prepared.conversationId;
    const sessionAgentId = prepared.agentId;
    const userText = prepared.text;
    const outgoingAttachments = prepared.attachments;
    const turnId = prepared.turnId;
    const startedAsDraftConversation = isDraftConversationKey(currentConversationId);
    const stream = getStreamSlot(currentConversationId);
    let liveConversationId = currentConversationId;
    let createdSessionId = '';
    locallyCancelledSessionIdsRef.current.delete(currentConversationId);
    if (options.queued) {
      removeQueuedTurnPreview(prepared);
    }
    stream.accumulated = '';
    stream.cancelledTurnId = null;
    stream.turnId = turnId;
    appendRealtime(currentConversationId, {
      id: `local_${turnId}`,
      turnId,
      role: 'user',
      content: userText,
      metadata: {
        ...(outgoingAttachments.length ? { attachments: outgoingAttachments } : {}),
        ...(resolvedInteractionMode === 'scheduled_task' ? { interaction_mode: 'scheduled_task' } : {}),
      },
      created_at: options.queued ? new Date().toISOString() : prepared.createdAt,
    });
    upsertTraceLine(turnId, {
      id: 'decision_router',
      kind: 'decision',
      text: t('chat.trace.decideIntent'),
      state: 'running',
      icon: 'judge',
      provisional: true,
    });
    setCollapsedTraceIds((current) => current.filter((item) => item !== turnId));
    setExpandedTraceIds((current) => (current.includes(turnId) ? current : [...current, turnId]));
    stream.loading = true;
    stream.phase = t('chat.trace.thinking');
    setRunningTurn({ sessionId: currentConversationId, turnId });
    notifyStream();

    const controller = new AbortController();
    const scopeSignal = workspaceSignal();
    const onScopeAbort = () => controller.abort();
    if (scopeSignal?.aborted) controller.abort();
    else scopeSignal?.addEventListener('abort', onScopeAbort, { once: true });
    stream.abortController = controller;
    let receivedTerminalEvent = false;
    let streamWatchdog: number | null = null;
    let lastStreamEventAt = Date.now();

    const clearRunningTurn = (targetId = liveConversationId) => {
      setRunningTurn((current) => (
        current?.turnId === turnId && (current.sessionId === targetId || current.sessionId === currentConversationId)
          ? null
          : current
      ));
    };

    const clearStreamWatchdog = () => {
      if (streamWatchdog !== null) {
        window.clearTimeout(streamWatchdog);
        streamWatchdog = null;
      }
    };

    /** 在无法确认服务端会话时插入安全的本地化错误消息，根因保留在技术日志。 */
    const appendInterruptedResponse = (reason: string) => {
      if (!isWorkspaceCurrent() || controller.signal.aborted) return;
      const activeTurnId = getStreamSlot(liveConversationId).turnId || turnId;
      clearStreamSlot(liveConversationId, true);
      appendRealtime(liveConversationId, {
        id: `stream_interrupted_${activeTurnId}_${Date.now()}`,
        turnId: activeTurnId,
        role: 'assistant',
        content: reason,
        created_at: new Date().toISOString(),
        isError: true,
      });
      finishTrace(activeTurnId, true);
      clearRunningTurn(liveConversationId);
      notifyStream();
      window.setTimeout(() => {
        if (!isWorkspaceCurrent() || controller.signal.aborted) return;
        loadMessages(liveConversationId);
        loadTraces(liveConversationId);
        loadSessions();
      }, 250);
    };

    const checkStreamHealth = () => {
      if (receivedTerminalEvent || controller.signal.aborted) return;
      const activeStream = getStreamSlot(liveConversationId);
      if (
        activeStream.abortController !== controller
        || activeStream.cancelledTurnId === turnId
        || (activeStream.turnId && activeStream.cancelledTurnId === activeStream.turnId)
      ) {
        return;
      }
      if (Date.now() - lastStreamEventAt < CHAT_STREAM_HEARTBEAT_GRACE_MS) {
        streamWatchdog = window.setTimeout(checkStreamHealth, CHAT_STREAM_IDLE_CHECK_INTERVAL_MS);
        return;
      }
      controller.abort();
      beginRelayRecovery();
    };

    const armStreamWatchdog = () => {
      lastStreamEventAt = Date.now();
      clearStreamWatchdog();
      streamWatchdog = window.setTimeout(checkStreamHealth, CHAT_STREAM_IDLE_CHECK_INTERVAL_MS);
    };

    const markStreamTerminal = () => {
      receivedTerminalEvent = true;
      clearStreamWatchdog();
    };

    const promoteDraftConversation = (nextSessionId: string) => {
      if (!startedAsDraftConversation || !nextSessionId || nextSessionId === liveConversationId) return;
      // Keep the active conversation resolvable to the real session until the route
      // param catches up, so the transition frame doesn't fall back to the deleted
      // draft slot and briefly render ChatEmptyState.
      pendingPromotedSessionIdRef.current = nextSessionId;
      const previousId = liveConversationId;
      const draftSlot = storeRef.current.get(previousId);
      if (draftSlot) {
        draftSlot.realtimeMessages = draftSlot.realtimeMessages.map((item) => (
          isStreamingMessageId(item.id, previousId)
            ? { ...item, id: streamingMessageId(nextSessionId, effectiveMessageTurnId(item)) }
            : item
        ));
        storeRef.current.set(nextSessionId, draftSlot);
        storeRef.current.delete(previousId);
      }
      const draftStream = streamRef.current.get(previousId);
      if (draftStream) {
        streamRef.current.set(nextSessionId, draftStream);
        streamRef.current.delete(previousId);
      }
      if (locallyCancelledSessionIdsRef.current.has(previousId)) {
        locallyCancelledSessionIdsRef.current.delete(previousId);
        locallyCancelledSessionIdsRef.current.add(nextSessionId);
      }
      if (queuedTurnsRef.current.some((item) => item.conversationId === previousId)) {
        queuedTurnsRef.current = queuedTurnsRef.current.map((item) => (
          item.conversationId === previousId ? { ...item, conversationId: nextSessionId } : item
        ));
        persistQueuedTurns();
        notifyQueue();
      }
      setScheduledDrafts((prev) => {
        if (!prev[previousId]) return prev;
        const next = { ...prev, [nextSessionId]: prev[previousId] };
        delete next[previousId];
        return next;
      });
      setCreatedScheduledTasks((prev) => {
        const previousKey = `session:${previousId}`;
        if (!prev[previousKey]) return prev;
        const next = { ...prev, [`session:${nextSessionId}`]: prev[previousKey] };
        delete next[previousKey];
        return next;
      });
      const now = new Date().toISOString();
      upsertOptimisticSession({
        id: nextSessionId,
        tenant_id: tenantId,
        user_id: userId,
        agent_id: sessionAgentId,
        status: 'active',
        summary: userText || undefined,
        last_agent_question: userText || undefined,
        agent_reply_locale: prepared.languageContext.agentReplyLocale,
        agent_reply_locale_source: prepared.languageContext.agentReplyLocaleSource,
        updated_at: now,
      });
      liveConversationId = nextSessionId;
      setRunningTurn((current) => (
        current?.sessionId === previousId && current.turnId === turnId ? { sessionId: nextSessionId, turnId } : current
      ));
      notifyStore();
      notifyStream();
      navigate(chatSessionPath(nextSessionId), { replace: true });
      loadSessions();
    };

    function beginRelayRecovery() {
      if (!isWorkspaceCurrent() || receivedTerminalEvent || controller.signal.aborted) return;
      clearStreamWatchdog();
      if (startedAsDraftConversation && createdSessionId) {
        promoteDraftConversation(createdSessionId);
      }
      const targetSessionId = liveConversationId;
      if (!targetSessionId || isDraftConversationKey(targetSessionId)) {
        console.error('[chat] response connection interrupted before session confirmation');
        appendInterruptedResponse(t('chat.error.connectionInterrupted'));
        return;
      }
      const activeStream = getStreamSlot(targetSessionId);
      const activeTurnId = activeStream.turnId || turnId;
      activeStream.abortController = null;
      activeStream.loading = true;
      activeStream.phase = activeStream.phase || t('chat.trace.running');
      activeStream.turnId = activeTurnId;
      activeStream.relayRecoveryStartedAt = activeStream.relayRecoveryStartedAt || Date.now();
      activeStream.relayRecoveryTurnId = activeTurnId;
      if (normalizeMessageText(activeStream.accumulated)) {
        updateStreaming(targetSessionId, activeStream.accumulated, activeTurnId);
      }
      setRunningTurn((current) => (
        current?.sessionId === targetSessionId && current.turnId === activeTurnId
          ? current
          : { sessionId: targetSessionId, turnId: activeTurnId }
      ));
      notifyStream();
      void pollScheduledSessionEvents(targetSessionId);
    }

    try {
      // Workflow: request fields are derived only from the prepared turn snapshot so
      // retries, queue resume, and a later UI preference change cannot alter execution.
      const languageContext = prepared.languageContext;
      const requestBody: Record<string, unknown> = {
        tenant_id: tenantId,
        user_id: userId,
        agent_id: sessionAgentId,
        message: userText,
        client_turn_id: turnId,
        attachments: outgoingAttachments,
        channel: 'web',
        interaction_mode: resolvedInteractionMode,
        client_timezone: getClientTimeZone(),
        model_config_id: prepared.modelConfigId,
        ui_locale: languageContext.uiLocale,
        agent_reply_locale: languageContext.agentReplyLocale,
        ui_locale_source: languageContext.uiLocaleSource,
        agent_reply_locale_source: languageContext.agentReplyLocaleSource,
        language_context: {
          version: languageContext.version,
          ui_locale: languageContext.uiLocale,
          agent_reply_locale: languageContext.agentReplyLocale,
          ui_locale_source: languageContext.uiLocaleSource,
          agent_reply_locale_source: languageContext.agentReplyLocaleSource,
        },
      };
      if (!startedAsDraftConversation) {
        requestBody.session_id = currentConversationId;
      }
      armStreamWatchdog();
      await streamChatTurn(requestBody, (item) => {
        if (!controller.signal.aborted && isWorkspaceCurrent()) {
          armStreamWatchdog();
        }
        if (controller.signal.aborted || !isWorkspaceCurrent()) return;
        if (item.event === 'session_created') {
          createdSessionId = String(item.data.newSessionId || item.data.sessionId || '');
          if (startedAsDraftConversation && createdSessionId) {
            promoteDraftConversation(createdSessionId);
          }
          return;
        }
        const eventSessionId = startedAsDraftConversation
          ? liveConversationId
          : String(item.data.sessionId || liveConversationId);
        const eventStream = getStreamSlot(eventSessionId);
        const traceTurnId = explicitStreamTurnId(item.data, eventStream.turnId || turnId);
        if (
          controller.signal.aborted
          || eventStream.cancelledTurnId === turnId
          || Boolean(traceTurnId && eventStream.cancelledTurnId === traceTurnId)
        ) {
          return;
        }
        if (item.event === 'user_message_received') {
          const serverMessageId = typeof item.data.message_id === 'string' ? item.data.message_id : '';
          bindRealtimeUserToServerMessage(eventSessionId, turnId, serverMessageId);
          return;
        }
        if (item.event === 'complete' || item.event === 'done') {
          markStreamTerminal();
          const result = item.data as unknown as ChatTurnResponse;
          const completedSessionId = result.session_id || createdSessionId || String(item.data.sessionId || '');
          handleStreamEvent(item, String(item.data.sessionId || liveConversationId), turnId);
          if (startedAsDraftConversation && completedSessionId) {
            promoteDraftConversation(completedSessionId);
          }
          return;
        }
        if (
          item.event === 'stream_end'
          || item.event === 'stream_cancelled'
          || item.event === 'stream_interrupted'
          || item.event === 'error_occurred'
        ) {
          markStreamTerminal();
        }
        handleStreamEvent(item, eventSessionId, turnId);
      }, controller.signal);
      clearStreamWatchdog();
      if (!receivedTerminalEvent && !controller.signal.aborted && isWorkspaceCurrent()) {
        beginRelayRecovery();
      }
    } catch (error) {
      clearStreamWatchdog();
      if (controller.signal.aborted) {
        return;
      }
      if (isMissingModelConfigurationError(error)) {
        finishTrace(getStreamSlot(liveConversationId).turnId || turnId, true);
        clearStreamSlot(liveConversationId, true);
        clearRunningTurn();
        invalidateModelSelection(prepared.modelConfigId);
        notifyStream();
        return;
      }
      if (isAuthError(error)) {
        finishTrace(getStreamSlot(liveConversationId).turnId || turnId, true);
        clearStreamSlot(liveConversationId, true);
        clearRunningTurn();
        notifyStream();
        redirectToLogin();
        return;
      }
      beginRelayRecovery();
    } finally {
      clearStreamWatchdog();
      scopeSignal?.removeEventListener('abort', onScopeAbort);
      if (stream.abortController === controller) {
        stream.abortController = null;
        stream.loading = false;
        stream.phase = '';
        clearRunningTurn();
        notifyStream();
      }
    }
  }, [
    appendRealtime,
    bindRealtimeUserToServerMessage,
    clearStreamSlot,
    finalizeStreaming,
    finishTrace,
    getStreamSlot,
    handleStreamEvent,
    invalidateModelSelection,
    loadMessages,
    loadSessions,
    loadTraces,
    isWorkspaceCurrent,
    navigate,
    notifyQueue,
    notifyStore,
    notifyStream,
    persistQueuedTurns,
    pollScheduledSessionEvents,
    redirectToLogin,
    removeQueuedTurnPreview,
    tenantId,
    updateStreaming,
    upsertOptimisticSession,
    upsertTraceLine,
    workspaceSignal,
    t,
    userId,
  ]);

  const send = useCallback(async (interactionMode?: ComposerInteractionMode) => {
    const resolvedInteractionMode = interactionMode || composerIntent || 'normal';
    if (!activeConversationId) return;
    if (resolvedInteractionMode === 'scheduled_task' && !input.trim()) {
      notify.warning(t('chat.error.scheduleContentRequired'));
      return;
    }
    if (!input.trim() && readyComposerAttachments.length === 0) return;
    if (uploadingComposerAttachment) {
      notify.warning(t('chat.error.uploadInProgress'));
      return;
    }
    if (!ensureModelAvailable()) return;
    const currentConversationId = activeConversationId;
    const pendingHandoff = handoffs.find((handoff) => (
      handoff.session_id === currentConversationId && handoff.status === 'pending'
    ));
    if (pendingHandoff) {
      if (resolvedInteractionMode !== 'normal') {
        notify.warning(t('chat.error.handoffReplyOnly'));
        return;
      }
      if (readyComposerAttachments.length > 0) {
        notify.warning(t('chat.error.handoffAttachmentUnsupported'));
        return;
      }
      const reply = input.trim();
      if (!reply) {
        notify.warning(t('chat.error.replyRequired'));
        return;
      }
      if (await replyToHandoff(pendingHandoff, reply)) {
        setInput('');
        setComposerAttachments([]);
        setComposerIntent(null);
      }
      return;
    }
    const activeSession = sessionId ? sessions.find((item) => item.id === sessionId) || null : null;
    if (!isDraftConversation && !activeSession && !optimisticSessionIdsRef.current.has(currentConversationId)) {
      if (sessionsLoading || handoffsLoading) {
        notify.warning(t('chat.error.sessionLoading'));
      } else {
        notify.warning(t('chat.error.sessionAccess'));
      }
      return;
    }
    const sessionAgentId = activeSession?.agent_id || activeDraftAgentId || selectedAgentId || displayedAgent?.id || '';
    if (!sessionAgentId) {
      notify.warning(t('chat.error.agentRequired'));
      return;
    }
    const prepared: PreparedChatTurn = {
      queueId: `queue_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      conversationId: currentConversationId,
      agentId: sessionAgentId,
      turnId: `turn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      text: input.trim(),
      attachments: readyComposerAttachments.map(toRequestAttachment),
      interactionMode: resolvedInteractionMode,
      modelConfigId: selectedModelConfig?.id,
      createdAt: new Date().toISOString(),
      languageContext: resolveLanguageContextSnapshot({
        uiLocale: locale,
        agentReplyLocalePreference,
        sessionAgentReplyLocale: activeSession?.agent_reply_locale,
      }),
    };
    setInput('');
    setComposerAttachments([]);
    setComposerIntent(null);
    const stream = getStreamSlot(currentConversationId);
    const hasQueuedTurnForConversation = queuedTurnsRef.current.some(
      (item) => item.conversationId === currentConversationId,
    );
    const sessionReportsRunning = Boolean(
      activeSession
      && (activeSession.status === 'running' || activeSession.status === 'executing'),
    );
    if (stream.loading || currentSessionRunning || sessionReportsRunning || hasQueuedTurnForConversation) {
      enqueuePreparedTurn(prepared);
      return;
    }
    await executePreparedTurn(prepared);
  }, [
    activeConversationId,
    activeDraftAgentId,
    agentReplyLocalePreference,
    composerIntent,
    currentSessionRunning,
    displayedAgent?.id,
    enqueuePreparedTurn,
    ensureModelAvailable,
    executePreparedTurn,
    getStreamSlot,
    handoffs,
    handoffsLoading,
    input,
    isDraftConversation,
    locale,
    readyComposerAttachments,
    replyToHandoff,
    selectedAgentId,
    selectedModelConfig?.id,
    sessionId,
    sessions,
    sessionsLoading,
    t,
    uploadingComposerAttachment,
  ]);

  const drainQueuedTurns = useCallback(() => {
    if (queuedTurnProcessingRef.current) return;
    const nextTurn = queuedTurnsRef.current[0];
    if (!nextTurn) return;
    if (sessionsLoading) return;
    if (modelConfigsLoading || modelConfigsLoadError) return;
    if (!selectedModelConfig) {
      if (canConfigureModels) setModelSetupOpen(true);
      return;
    }
    const queuedSession = sessions.find((item) => item.id === nextTurn.conversationId);
    if (
      queuedSession
      && (queuedSession.status === 'running' || queuedSession.status === 'executing')
    ) {
      return;
    }
    if (
      !queuedSession
      && !isDraftConversationKey(nextTurn.conversationId)
      && !optimisticSessionIdsRef.current.has(nextTurn.conversationId)
    ) {
      return;
    }
    const stream = getStreamSlot(nextTurn.conversationId);
    if (stream.loading || runningTurn?.sessionId === nextTurn.conversationId) return;
    queuedTurnsRef.current = queuedTurnsRef.current.slice(1);
    persistQueuedTurns();
    notifyQueue();
    queuedTurnProcessingRef.current = true;
    void executePreparedTurn(nextTurn, { queued: true }).finally(() => {
      queuedTurnProcessingRef.current = false;
      notifyQueue();
    });
  }, [
    executePreparedTurn,
    getStreamSlot,
    canConfigureModels,
    modelConfigsLoadError,
    modelConfigsLoading,
    notifyQueue,
    persistQueuedTurns,
    runningTurn,
    selectedModelConfig,
    sessions,
    sessionsLoading,
  ]);

  useEffect(() => {
    void queuedTurnsTick;
    drainQueuedTurns();
  }, [drainQueuedTurns, queuedTurnsTick, streamTick]);

  const handleComposerPaste = useCallback((event: ClipboardEvent<HTMLTextAreaElement>) => {
    const clipboardData = event.clipboardData;
    if (!clipboardData || !clipboardContainsComposerImage(clipboardData)) return;
    event.preventDefault();
    void extractPastedComposerFiles(clipboardData).then((files) => {
      if (files.length) uploadComposerFiles(files);
    });
  }, [uploadComposerFiles]);

  const handleComposerPlusAction = useCallback((action: 'upload' | 'scheduled_task') => {
    setComposerPlusOpen(false);
    if (action === 'upload') {
      fileInputRef.current?.click();
      return;
    }
    setComposerIntent('scheduled_task');
  }, []);

  const openSession = useCallback((id: string) => {
    navigate(chatSessionPath(id));
  }, [navigate]);

  const openDraftForAgent = useCallback((agentId: string) => {
    if (!agentId) return;
    setSelectedAgentId(agentId);
    persistChatSessionAgentFilter(agentId);
    persistSharedAgentScope(agentId, tenantId, userId);
    emitAgentScopeChange(agentId);
    navigate(`${CHAT_BASE_PATH}/draft/${encodeURIComponent(agentId)}`);
  }, [navigate, persistChatSessionAgentFilter, tenantId, userId]);

  const openGallery = useCallback(() => {
    navigate('/workspace/gallery');
  }, [navigate]);

  const changeSessionAgentFilter = useCallback((value: string) => {
    persistChatSessionAgentFilter(value || 'all');
  }, [persistChatSessionAgentFilter]);

  return {
    auth,
    SHOW_DEBUG,
    lastTurn,
    // sessions + agents
    sessions,
    sessionsLoading,
    visibleSidebarSessions,
    agents,
    teams,
    sessionId,
    sessionReadTimes,
    sessionAgentFilter,
    setSessionAgentFilter: changeSessionAgentFilter,
    sessionFilterOptions,
    // active state
    activeConversationId,
    displayedAgent,
    displayedProfile,
    displayedTeam,
    teamEmptyStats,
    currentSession,
    agentReplyLocale,
    agentReplyLocaleLocked,
    setAgentReplyLocale,
    emptyProfileTags,
    emptyRoleSummary,
    emptyStats,
    // messages / trace
    displayedMessages,
    turnTraceRef,
    uiConfig,
    expandedTraceIds,
    collapsedTraceIds,
    toggleTrace,
    currentStream,
    runningTurn,
    currentSessionRunning,
    isCurrentStreamingTrace,
    // scheduled
    scheduledDrafts,
    createdScheduledTasks,
    dismissedDraftMessageIds,
    currentScheduledDraft,
    hasVisibleMessageScheduledDraft,
    confirmScheduledTask,
    dismissScheduledTaskDraft,
    // composer
    input,
    setInput,
    slashCommands,
    composerAttachments,
    composerDragActive,
    composerPlusOpen,
    setComposerPlusOpen,
    composerIntent,
    setComposerIntent,
    readyComposerAttachments,
    uploadingComposerAttachment,
    composerActive,
    showComposerAvatar,
    isComposing,
    setIsComposing,
    enabledModelConfigs,
    selectedModelConfig,
    changeModelConfig,
    showModelSetupNotice,
    modelSetupNoticeText,
    tenantId,
    canConfigureModels,
    modelConfigsLoading,
    modelSetupOpen,
    setModelSetupOpen,
    completeModelSetup,
    // refs
    chatMessagesRef,
    fileInputRef,
    // handlers
    handleChatMessagesScroll,
    send,
    abortStream,
    removeQueuedTurn,
    rateMessage,
    setActiveCitation,
    activeCitation,
    // sidebar
    sidebarCollapsed,
    toggleSidebar,
    openSession,
    refreshAgents: loadAgents,
    openDraftForAgent,
    openGallery,
    openRename,
    requestDelete,
    logout: redirectToLogin,
    openAdmin: () => navigate('/enterprise/dashboard'),
    // rename dialog
    renameSession,
    setRenameSession,
    renameTitle,
    setRenameTitle,
    saveRename,
    // delete dialog
    pendingDelete,
    setPendingDelete,
    confirmDeleteSession,
    // handoff
    handoffs,
    handoffsLoading,
    showHandoffInbox,
    setShowHandoffInbox,
    openHandoffInbox,
    handoffReplies,
    setHandoffReplies,
    submitHandoffReply,
    // composer actions
    handleComposerFileChange,
    handleComposerDragEnter,
    handleComposerDragOver,
    handleComposerDragLeave,
    handleComposerDrop,
    handleComposerPaste,
    removeComposerAttachment,
    handleComposerPlusAction,
    uploadComposerFiles,
    navigate,
  };
}
