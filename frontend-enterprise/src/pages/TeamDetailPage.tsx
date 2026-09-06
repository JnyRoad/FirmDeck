import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Crown, Download, Eye, FileJson, LoaderCircle, MessageCircle } from 'lucide-react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';

import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@/components/ui';
import { createToastNotifier } from '@/components/ui/app-toast';
import { createMessageDescriptor } from '@/i18n/descriptors';
import { createAppTranslator, useAppIntl, type AppLocale, type AppTranslator, type MessageId, type MessageValues } from '@/i18n';
import { RawContent, RawIdentifier } from '@/i18n/RawContent';
import { createUiSinks } from '@/i18n/sinks';
import { backendEventMessageDescriptor } from '@/lib/backendEventMessages';
import { cn } from '@/lib/utils';

import { createTenantClient } from '../api/tenant-client';
import type { EnterpriseAuthUser } from '../auth';
import { useTenantSession } from '../contexts/TenantSessionContext';
import AppHeader from '../components/AppHeader';
import BiddingArena from '../components/BiddingArena';
import EmployeeAvatar from '../components/EmployeeAvatar';
import TeamKnowledgePermissionMatrix from '../components/knowledge/TeamKnowledgePermissionMatrix';
import { employeeDisplayName } from '../employee';
import { EnterpriseRoute } from '../enums/routes';
import { apiErrorCode } from '../lib/apiErrorMessages';
import { getClientTimeZone, parseBackendDateTime } from '../lib/timezone';
import { MarkdownMessage } from './chat/chatHelpers';
import type {
  AgentProfileRead,
  KnowledgeBaseRead,
  TeamBlackboardEntryRead,
  TeamEventRead,
  TeamMemberRead,
  TeamKnowledgeBindingRead,
  TeamKnowledgeGrantInput,
  TeamRead,
  TeamReviewVerdict,
  TeamTaskBidRead,
  TeamTaskRead,
} from '../types';


type TeamDetailMessageId = MessageId;

type TeamDetailTranslate = (id: TeamDetailMessageId, values?: MessageValues) => string;

/** 将语义目录的受控 translator 适配到本页的补迁移键集合；业务原文不经过翻译。 */
function createTeamDetailTranslator(translator: Pick<AppTranslator, 't'>): TeamDetailTranslate {
  return (id, values) => translator.t(id, values);
}

/** 提供测试、导出 helper 和非 React 边界使用的中文默认 translator。 */
function defaultTeamDetailTranslator(): TeamDetailTranslate {
  return createTeamDetailTranslator(createAppTranslator('zh-CN'));
}

const TEAM_EVENT_TYPE_MESSAGE_IDS: Record<string, TeamDetailMessageId> = {
  task_created: 'teamDetailPage.event.taskCreated',
  task_started: 'teamDetailPage.event.taskStarted',
  task_rework_started: 'teamDetailPage.event.taskReworkStarted',
  task_reported: 'teamDetailPage.event.taskReported',
  task_escalated: 'teamDetailPage.event.taskEscalated',
  task_needs_input: 'teamDetailPage.event.taskNeedsInput',
  task_bidding_started: 'teamDetailPage.event.taskBiddingStarted',
  task_awarded: 'teamDetailPage.event.taskAwarded',
  bid_submitted: 'teamDetailPage.event.bidSubmitted',
  bid_skipped: 'teamDetailPage.event.bidSkipped',
  bid_failed: 'teamDetailPage.event.bidFailed',
  bid_award_unparsed: 'teamDetailPage.event.bidAwardUnparsed',
  tl_review_skipped: 'teamDetailPage.event.tlReviewSkipped',
  tl_review_unparsed: 'teamDetailPage.event.tlReviewUnparsed',
  tl_review_repair_failed: 'teamDetailPage.event.tlReviewRepairFailed',
  tl_review_approve: 'teamDetailPage.event.tlReviewApprove',
  tl_review_rework: 'teamDetailPage.event.tlReviewRework',
  tl_review_escalate: 'teamDetailPage.event.tlReviewEscalate',
  review_override_approve: 'teamDetailPage.event.reviewOverrideApprove',
  review_override_rework: 'teamDetailPage.event.reviewOverrideRework',
  review_override_escalate: 'teamDetailPage.event.reviewOverrideEscalate',
  blackboard_written: 'teamDetailPage.event.blackboardWritten',
  wake_claimed: 'teamDetailPage.event.wakeClaimed',
  wake_completed: 'teamDetailPage.event.wakeCompleted',
  wake_failed: 'teamDetailPage.event.wakeFailed',
  wake_recovered: 'teamDetailPage.event.wakeRecovered',
  member_execution_resumed: 'teamDetailPage.event.memberExecutionResumed',
  member_execution_skipped: 'teamDetailPage.event.memberExecutionSkipped',
};

/** 将后端事件枚举映射为语义消息；未知协议值原样保留以便诊断。 */
export function teamEventTypeLabel(eventType: string, translate = defaultTeamDetailTranslator()): string {
  const messageId = TEAM_EVENT_TYPE_MESSAGE_IDS[eventType];
  return messageId ? translate(messageId) : eventType;
}

/**
 * Project one team audit event from its canonical code/params, with legacy event type as fallback.
 * Event payload text is deliberately ignored so backend-rendered product prose cannot leak into UI.
 */
export function teamEventLabel(
  eventType: string,
  payload: Record<string, unknown> | null | undefined,
  translate = defaultTeamDetailTranslator(),
): string {
  const eventCode = typeof payload?.event_code === 'string' ? payload.event_code : '';
  const params = payload?.params;
  const descriptor = backendEventMessageDescriptor(eventCode, params);
  if (descriptor) return translate(descriptor.messageId, descriptor.values);
  return teamEventTypeLabel(eventType, translate);
}

const TASK_STATUS_COLUMNS: { status: string }[] = [
  { status: 'bidding' },
  { status: 'pending' },
  { status: 'in_progress' },
  { status: 'review' },
  { status: 'done' },
  { status: 'rework' },
  { status: 'escalated' },
];

const TASK_STATUS_MESSAGE_IDS: Record<string, TeamDetailMessageId> = {
  bidding: 'teamDetailPage.status.bidding',
  pending: 'teamDetailPage.status.pending',
  in_progress: 'teamDetailPage.status.inProgress',
  review: 'teamDetailPage.status.review',
  done: 'teamDetailPage.status.done',
  rework: 'teamDetailPage.status.rework',
  escalated: 'teamDetailPage.status.escalated',
};

/** 将任务状态码转为当前页面的本地化标签；未注册值原样保留。 */
function teamTaskStatusLabel(status: string, translate: TeamDetailTranslate): string {
  const messageId = TASK_STATUS_MESSAGE_IDS[status];
  return messageId ? translate(messageId) : status;
}

/** 将团队状态码转为当前页面的本地化标签；未注册状态原样保留。 */
function teamStatusLabelForDetail(status: string, translate: TeamDetailTranslate): string {
  if (status === 'active') return translate('teamDetailPage.status.active');
  if (status === 'archived') return translate('teamDetailPage.status.archived');
  return status;
}

/** 按当前语言、客户端时区和受控消息格式化相对时间，避免业务代码固定地区参数。 */
function teamRelativeTimeLabel(
  iso: string,
  locale: AppLocale,
  translate: TeamDetailTranslate,
): string {
  const time = parseBackendDateTime(iso).getTime();
  if (Number.isNaN(time)) return '';
  const minutes = Math.floor((Date.now() - time) / 60000);
  if (minutes < 1) return translate('teamsPage.time.justNow');
  if (minutes < 60) return translate('teamsPage.time.minutesAgo', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return translate('teamsPage.time.hoursAgo', { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 7) return translate('teamsPage.time.daysAgo', { count: days });
  return new Intl.DateTimeFormat(locale, { timeZone: getClientTimeZone() }).format(parseBackendDateTime(iso));
}

/** 按当前 UI locale 与客户端时区格式化绝对时间；非法日期降级为受控占位文案。 */
function formatTeamDateTime(
  iso: string | undefined,
  locale: AppLocale,
  translate: TeamDetailTranslate,
): string {
  if (!iso) return translate('teamDetailPage.value.none');
  const date = parseBackendDateTime(iso);
  if (Number.isNaN(date.getTime())) return translate('teamDetailPage.value.none');
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'short',
    timeStyle: 'short',
    hour12: false,
    timeZone: getClientTimeZone(),
  }).format(date);
}

const OVERRIDABLE_STATUSES = new Set(['review', 'escalated']);

const AWARD_OVERRIDABLE_STATUSES = new Set(['bidding', 'pending']);

const POOL_ASSIGNEE_VALUE = '__pool__';

type TeamLogMessage = {
  id?: string;
  role?: string;
  content?: string;
  created_at?: string;
};

type TeamLogSession = {
  session?: Record<string, unknown>;
  messages?: TeamLogMessage[];
  feedback?: Array<Record<string, unknown>>;
  traces?: unknown[];
  events?: Array<Record<string, unknown>>;
  tool_invocations?: Array<Record<string, unknown>>;
};

type TeamLogPayload = {
  schema_version?: string;
  exported_at?: string;
  team?: Record<string, unknown>;
  summary?: {
    task_count?: number;
    wake_event_count?: number;
    blackboard_entry_count?: number;
    session_count?: number;
  };
  tasks?: unknown[];
  wake_events?: unknown[];
  blackboard_entries?: unknown[];
  sessions?: TeamLogSession[];
};

type TeamRouteFence = {
  teamId: string;
  routeRevision: number;
  signal: AbortSignal;
  isCurrent: () => boolean;
};

type TeamActionFence = TeamRouteFence & {
  release: () => void;
};

/** 将业务优先级枚举映射为本地化产品标签；未知值原样保留以避免翻译业务数据。 */
export function taskPriorityLabel(
  priority: string,
  translate = defaultTeamDetailTranslator(),
): string {
  if (priority === 'high' || priority === 'urgent') return translate('teamDetailPage.priority.high');
  if (priority === 'medium' || priority === 'normal') return translate('teamDetailPage.priority.medium');
  if (priority === 'low') return translate('teamDetailPage.priority.low');
  return priority;
}

const REVIEW_BANNERS: Record<string, { bannerClass: string; quoteClass: string }> = {
  approve: {
    bannerClass: 'border-[#bfe6cf] bg-[#eefaf3] text-[#1e7a4c]',
    quoteClass: 'border-[#35b26f]',
  },
  rework: {
    bannerClass: 'border-[#f5ddba] bg-[#fdf6ea] text-[#a3620a]',
    quoteClass: 'border-[#f5a83b]',
  },
  escalate: {
    bannerClass: 'border-[#f6c8c4] bg-[#fdeeec] text-[#c0342b]',
    quoteClass: 'border-[#f5483b]',
  },
};

const DEFAULT_REVIEW_BANNER = {
  bannerClass: 'border-[#e3e7f1] bg-[#f8f9fb] text-[#464c5e]',
  quoteClass: 'border-[#a7adbb]',
};

/** 将验收结论映射为本地化标签；未知结论作为协议值保留，避免丢失诊断信息。 */
function reviewVerdictLabel(
  verdict: string,
  translate = defaultTeamDetailTranslator(),
): string {
  if (verdict === 'approve') return translate('teamDetailPage.review.approve');
  if (verdict === 'rework') return translate('teamDetailPage.review.rework');
  if (verdict === 'escalate') return translate('teamDetailPage.review.escalate');
  return verdict;
}

function textField(source: Record<string, unknown> | undefined, key: string): string {
  const value = source?.[key];
  return typeof value === 'string' ? value : '';
}

function parseTags(raw: string): string[] {
  return raw
    .split(/[,，]/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

/** 渲染团队详情及协作控制面板；仅产品 chrome 本地化，团队与执行内容保持 raw。 */
export default function TeamDetailPage({
  currentUser,
  onLogout,
}: {
  currentUser?: EnterpriseAuthUser;
  isAdmin?: boolean;
  onLogout?: () => void;
}) {
  const { teamId = '' } = useParams<{ teamId: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const taskParam = searchParams.get('task');
  const { locale, t: appT } = useAppIntl();
  const t = useMemo(() => createTeamDetailTranslator({ t: appT }), [appT]);
  const toast = useMemo(() => createToastNotifier({ t: appT }), [appT]);
  const uiSinks = useMemo(() => createUiSinks({ t: appT }), [appT]);
  const tenantContext = useTenantSession();
  const tenantApi = useMemo(() => createTenantClient(tenantContext), [tenantContext]);
  const [team, setTeam] = useState<TeamRead | null>(null);
  const [tasks, setTasks] = useState<TeamTaskRead[]>([]);
  const [agents, setAgents] = useState<AgentProfileRead[]>([]);
  const [loading, setLoading] = useState(false);
  const [addAgentId, setAddAgentId] = useState('');
  const [addingMember, setAddingMember] = useState(false);
  const [activeTask, setActiveTask] = useState<TeamTaskRead | null>(null);
  const [overrideComment, setOverrideComment] = useState('');
  const [overriding, setOverriding] = useState(false);
  const [boardEntries, setBoardEntries] = useState<TeamBlackboardEntryRead[]>([]);
  const [boardContent, setBoardContent] = useState('');
  const [boardTags, setBoardTags] = useState('');
  const [postingEntry, setPostingEntry] = useState(false);
  const [editingEntry, setEditingEntry] = useState<TeamBlackboardEntryRead | null>(null);
  const [editContent, setEditContent] = useState('');
  const [editTags, setEditTags] = useState('');
  const [savingEntry, setSavingEntry] = useState(false);
  const [taskDialogOpen, setTaskDialogOpen] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [newTaskDescription, setNewTaskDescription] = useState('');
  const [newTaskPriority, setNewTaskPriority] = useState('medium');
  const [newTaskAssignee, setNewTaskAssignee] = useState(POOL_ASSIGNEE_VALUE);
  const [creatingTask, setCreatingTask] = useState(false);
  const [awardAgentId, setAwardAgentId] = useState('');
  const [awardComment, setAwardComment] = useState('');
  const [awarding, setAwarding] = useState(false);
  const [teamEvents, setTeamEvents] = useState<TeamEventRead[]>([]);
  const [configConcurrency, setConfigConcurrency] = useState('1');
  const [configTaskTimeout, setConfigTaskTimeout] = useState('30');
  const [configBidRounds, setConfigBidRounds] = useState('1');
  const [savingConfig, setSavingConfig] = useState(false);
  const [startingChat, setStartingChat] = useState(false);
  const [teamLogOpen, setTeamLogOpen] = useState(false);
  const [teamLog, setTeamLog] = useState<TeamLogPayload | null>(null);
  const [loadingTeamLog, setLoadingTeamLog] = useState(false);
  const [promotingEntryId, setPromotingEntryId] = useState<string | null>(null);
  const [knowledgeBindings, setKnowledgeBindings] = useState<TeamKnowledgeBindingRead[]>([]);
  const [availableSharedKnowledge, setAvailableSharedKnowledge] = useState<KnowledgeBaseRead[]>([]);
  const [knowledgeBusyIds, setKnowledgeBusyIds] = useState<Set<string>>(() => new Set());
  const [addKnowledgeBaseId, setAddKnowledgeBaseId] = useState('');
  const [newSharedKnowledgeName, setNewSharedKnowledgeName] = useState('');
  const routeKey = `${teamId}|${taskParam ?? ''}`;
  const routeRevisionRef = useRef({ key: routeKey, revision: 0 });
  if (routeRevisionRef.current.key !== routeKey) {
    routeRevisionRef.current = {
      key: routeKey,
      revision: routeRevisionRef.current.revision + 1,
    };
  }
  const routeRevision = routeRevisionRef.current.revision;
  const teamIdRef = useRef(teamId);
  teamIdRef.current = teamId;
  const routeAbortControllerRef = useRef<AbortController | null>(null);
  const actionControllersRef = useRef<Set<AbortController>>(new Set());

  /** Abort every mutation controller captured by the previous team route. */
  function cancelRouteActionControllers() {
    actionControllersRef.current.forEach((actionController) => actionController.abort());
    actionControllersRef.current.clear();
  }

  // Abort every route-bound request/action before the next route can publish
  // anything. The route revision remains the logical fence; this controller
  // also stops fetch work that is still in flight.
  useEffect(() => {
    const controller = new AbortController();
    const previousController = routeAbortControllerRef.current;
    routeAbortControllerRef.current = controller;
    previousController?.abort();
    cancelRouteActionControllers();
    return () => {
      controller.abort();
      cancelRouteActionControllers();
      if (routeAbortControllerRef.current === controller) routeAbortControllerRef.current = null;
    };
  }, [routeKey]);

  /** Capture the current team route and reject snapshots after route changes. */
  function captureTeamRouteFence(): TeamRouteFence | null {
    const controller = routeAbortControllerRef.current;
    if (!controller || controller.signal.aborted) return null;
    const capturedTeamId = teamIdRef.current;
    const capturedRouteRevision = routeRevisionRef.current.revision;
    return {
      teamId: capturedTeamId,
      routeRevision: capturedRouteRevision,
      signal: controller.signal,
      isCurrent: () => (
        !controller.signal.aborted
        && routeAbortControllerRef.current?.signal === controller.signal
        && teamIdRef.current === capturedTeamId
        && routeRevisionRef.current.revision === capturedRouteRevision
      ),
    };
  }

  /** Capture one route action, including an abortable controller for its request. */
  function beginTeamActionFence(): TeamActionFence | null {
    const context = tenantContext;
    const generation = context?.generation;
    const routeFence = captureTeamRouteFence();
    if (!context || generation === undefined || !routeFence || !routeFence.isCurrent()) return null;

    const actionController = new AbortController();
    const abortAction = () => actionController.abort();
    routeFence.signal.addEventListener('abort', abortAction, { once: true });
    actionControllersRef.current.add(actionController);

    return {
      teamId: routeFence.teamId,
      routeRevision: routeFence.routeRevision,
      signal: actionController.signal,
      isCurrent: () => (
        !actionController.signal.aborted
        && context.isCurrentGeneration(generation)
        && routeFence.isCurrent()
      ),
      release: () => {
        routeFence.signal.removeEventListener('abort', abortAction);
        actionControllersRef.current.delete(actionController);
      },
    };
  }

  const openedTaskParamRef = useRef<string | null>(null);
  const memberScrollRef = useRef<HTMLDivElement | null>(null);
  const [memberScrollEdges, setMemberScrollEdges] = useState({
    overflow: false,
    left: false,
    right: false,
  });

  const teamMemberKey = useMemo(
    () => (team?.members || []).map((member) => `${member.id}:${member.role}`).join('|'),
    [team?.members],
  );

  const updateMemberScrollEdges = useCallback(() => {
    const node = memberScrollRef.current;
    if (!node) return;
    const maxScrollLeft = Math.max(0, node.scrollWidth - node.clientWidth);
    const overflow = maxScrollLeft > 1;
    const nextEdges = {
      overflow,
      left: overflow && node.scrollLeft > 1,
      right: overflow && node.scrollLeft < maxScrollLeft - 1,
    };
    setMemberScrollEdges((current) => (
      current.overflow === nextEdges.overflow
      && current.left === nextEdges.left
      && current.right === nextEdges.right
        ? current
        : nextEdges
    ));
  }, []);

  useEffect(() => {
    const node = memberScrollRef.current;
    if (!node) return;
    node.scrollLeft = 0;
    updateMemberScrollEdges();

    node.addEventListener('scroll', updateMemberScrollEdges, { passive: true });
    window.addEventListener('resize', updateMemberScrollEdges);
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(updateMemberScrollEdges);
    resizeObserver?.observe(node);
    if (node.firstElementChild instanceof HTMLElement) {
      resizeObserver?.observe(node.firstElementChild);
    }
    return () => {
      node.removeEventListener('scroll', updateMemberScrollEdges);
      window.removeEventListener('resize', updateMemberScrollEdges);
      resizeObserver?.disconnect();
    };
  }, [teamMemberKey, updateMemberScrollEdges]);

  /** 加载团队概要；错误只展示受控产品消息，不把异常正文作为 UI 文案。 */
  const loadTeam = useCallback(async (expectedRouteFence?: TeamRouteFence) => {
    const context = tenantContext;
    const generation = context?.generation;
    const routeFence = expectedRouteFence || captureTeamRouteFence();
    if (!context || generation === undefined || !routeFence) return;
    try {
      const detail = await tenantApi.get<TeamRead>(
        `/api/enterprise/teams/${routeFence.teamId}`,
        { signal: routeFence.signal },
      );
      if (!context.isCurrentGeneration(generation) || !routeFence.isCurrent()) return;
      setTeam(detail);
    } catch {
      if (context.isCurrentGeneration(generation) && routeFence.isCurrent()) {
        toast.error(createMessageDescriptor('teamDetailPage.toast.loadTeam'));
      }
    }
  }, [tenantApi, teamId, tenantContext, toast]);

  /** 加载任务看板数据；后端任务标题和描述仍作为业务原文保留。 */
  const loadTasks = useCallback(async (expectedRouteFence?: TeamRouteFence) => {
    const context = tenantContext;
    const generation = context?.generation;
    const routeFence = expectedRouteFence || captureTeamRouteFence();
    if (!context || generation === undefined || !routeFence) return;
    try {
      const rows = await tenantApi.get<TeamTaskRead[]>(
        `/api/enterprise/teams/${routeFence.teamId}/tasks`,
        { signal: routeFence.signal },
      );
      if (!context.isCurrentGeneration(generation) || !routeFence.isCurrent()) return;
      setTasks(rows);
    } catch {
      if (context.isCurrentGeneration(generation) && routeFence.isCurrent()) {
        toast.error(createMessageDescriptor('teamDetailPage.toast.loadTasks'));
      }
    }
  }, [tenantApi, teamId, tenantContext, toast]);

  /** 加载团队黑板；网络或服务端错误采用稳定 fallback。 */
  const loadBoard = useCallback(async (expectedRouteFence?: TeamRouteFence) => {
    const context = tenantContext;
    const generation = context?.generation;
    const routeFence = expectedRouteFence || captureTeamRouteFence();
    if (!context || generation === undefined || !routeFence) return;
    try {
      const rows = await tenantApi.get<TeamBlackboardEntryRead[]>(
        `/api/enterprise/teams/${routeFence.teamId}/blackboard?status=active`,
        { signal: routeFence.signal },
      );
      if (!context.isCurrentGeneration(generation) || !routeFence.isCurrent()) return;
      setBoardEntries(rows);
    } catch {
      if (context.isCurrentGeneration(generation) && routeFence.isCurrent()) {
        toast.error(createMessageDescriptor('teamDetailPage.toast.loadBlackboard'));
      }
    }
  }, [tenantApi, teamId, tenantContext, toast]);

  const loadEvents = useCallback(async (expectedRouteFence?: TeamRouteFence) => {
    const context = tenantContext;
    const generation = context?.generation;
    const routeFence = expectedRouteFence || captureTeamRouteFence();
    if (!context || generation === undefined || !routeFence) return;
    try {
      const rows = await tenantApi.get<TeamEventRead[]>(
        `/api/enterprise/teams/${routeFence.teamId}/events?limit=50`,
        { signal: routeFence.signal },
      );
      if (!context.isCurrentGeneration(generation) || !routeFence.isCurrent()) return;
      setTeamEvents(rows);
    } catch {
      if (context.isCurrentGeneration(generation) && routeFence.isCurrent()) setTeamEvents([]);
    }
  }, [tenantApi, teamId, tenantContext]);

  /** 加载团队知识库绑定；权限矩阵只接收服务器数据，不翻译知识库名称。 */
  const loadKnowledgeBindings = useCallback(async (expectedRouteFence?: TeamRouteFence) => {
    /** Load team-local binding revisions and permission matrices. */
    const context = tenantContext;
    const generation = context?.generation;
    const routeFence = expectedRouteFence || captureTeamRouteFence();
    if (!context || generation === undefined || !routeFence) return;
    try {
      const rows = await tenantApi.get<TeamKnowledgeBindingRead[]>(
        `/api/enterprise/teams/${routeFence.teamId}/knowledge-bases`,
        { signal: routeFence.signal },
      );
      if (!context.isCurrentGeneration(generation) || !routeFence.isCurrent()) return;
      setKnowledgeBindings(rows.filter((row) => row.status === 'active'));
    } catch {
      if (context.isCurrentGeneration(generation) && routeFence.isCurrent()) {
        toast.error(createMessageDescriptor('teamDetailPage.toast.loadKnowledge'));
        setKnowledgeBindings([]);
      }
    }
  }, [tenantApi, teamId, tenantContext, toast]);

  const loadAvailableSharedKnowledge = useCallback(async (expectedRouteFence?: TeamRouteFence) => {
    /** Load reusable shared bases that may be added to this team. */
    const context = tenantContext;
    const generation = context?.generation;
    const routeFence = expectedRouteFence || captureTeamRouteFence();
    if (!context || generation === undefined || !routeFence) return;
    try {
      const rows = await tenantApi.get<KnowledgeBaseRead[]>(
        '/api/enterprise/knowledge-bases',
        { signal: routeFence.signal },
      );
      if (!context.isCurrentGeneration(generation) || !routeFence.isCurrent()) return;
      setAvailableSharedKnowledge(rows.filter((row) => row.mode === 'shared'));
    } catch {
      if (context.isCurrentGeneration(generation) && routeFence.isCurrent()) setAvailableSharedKnowledge([]);
    }
  }, [teamId, tenantApi, tenantContext]);

  useEffect(() => {
    const context = tenantContext;
    const generation = context?.generation;
    const routeFence = captureTeamRouteFence();
    if (!context || generation === undefined || !routeFence) return undefined;
    setLoading(true);
    void Promise.all([
      loadTeam(routeFence),
      loadTasks(routeFence),
      loadBoard(routeFence),
      loadEvents(routeFence),
      loadKnowledgeBindings(routeFence),
      loadAvailableSharedKnowledge(routeFence),
      tenantApi
        .get<AgentProfileRead[]>('/api/enterprise/agents', { signal: routeFence.signal })
        .then((rows) => {
          if (context.isCurrentGeneration(generation) && routeFence.isCurrent()) setAgents(rows);
        })
        .catch(() => {
          if (context.isCurrentGeneration(generation) && routeFence.isCurrent()) setAgents([]);
        }),
    ]).finally(() => {
      if (context.isCurrentGeneration(generation) && routeFence.isCurrent()) setLoading(false);
    });
    return undefined;
  }, [
    loadAvailableSharedKnowledge,
    loadBoard,
    loadEvents,
    loadKnowledgeBindings,
    loadTasks,
    loadTeam,
    routeRevision,
    teamId,
    tenantApi,
    tenantContext,
  ]);

  // A provider replacement briefly exposes no context. Clear all resource
  // state at that boundary so a tenant-A detail page cannot remain visible
  // while tenant-B verification is in flight.
  useEffect(() => {
    if (tenantContext) return;
    setTeam(null);
    setTasks([]);
    setAgents([]);
    setBoardEntries([]);
    setTeamEvents([]);
    setKnowledgeBindings([]);
    setAvailableSharedKnowledge([]);
    setTeamLog(null);
    setTeamLogOpen(false);
    setLoadingTeamLog(false);
    setActiveTask(null);
    setEditingEntry(null);
    setTaskDialogOpen(false);
    setAddingMember(false);
    setCreatingTask(false);
    setPostingEntry(false);
    setSavingEntry(false);
    setOverriding(false);
    setAwarding(false);
    setSavingConfig(false);
    setStartingChat(false);
    setPromotingEntryId(null);
    setKnowledgeBusyIds(new Set());
    setLoading(false);
    openedTaskParamRef.current = null;
  }, [tenantContext]);

  // A route replacement keeps this component mounted. Clear the previous
  // team's resources immediately so its detail, tasks, or dialogs cannot
  // remain visible while the new team request is in flight.
  useEffect(() => {
    setTeam(null);
    setTasks([]);
    setAgents([]);
    setBoardEntries([]);
    setTeamEvents([]);
    setKnowledgeBindings([]);
    setAvailableSharedKnowledge([]);
    setTeamLog(null);
    setTeamLogOpen(false);
    setLoadingTeamLog(false);
    setActiveTask(null);
    setEditingEntry(null);
    setTaskDialogOpen(false);
    setAddingMember(false);
    setCreatingTask(false);
    setPostingEntry(false);
    setSavingEntry(false);
    setOverriding(false);
    setAwarding(false);
    setSavingConfig(false);
    setStartingChat(false);
    setPromotingEntryId(null);
    setKnowledgeBusyIds(new Set());
    openedTaskParamRef.current = null;
  }, [routeKey]);

  useEffect(() => {
    const config = team?.config || {};
    setConfigConcurrency(String(config.member_concurrency ?? 1));
    setConfigTaskTimeout(String(config.task_timeout_minutes ?? 30));
    setConfigBidRounds(String(config.bid_rebuttal_rounds ?? 1));
  }, [team]);

  useEffect(() => {
    if (!tenantContext) {
      openedTaskParamRef.current = null;
      setActiveTask(null);
      return;
    }
    if (!taskParam) {
      openedTaskParamRef.current = null;
      setActiveTask(null);
      return;
    }
    if (openedTaskParamRef.current === taskParam) return;
    const target = tasks.find((item) => item.id === taskParam);
    if (!target) return;
    openedTaskParamRef.current = taskParam;
    void openTask(target, routeRevision);
  }, [routeRevision, taskParam, tasks, tenantContext]);

  const memberNameByAgentId = useMemo(() => {
    const map = new Map<string, string>();
    (team?.members || []).forEach((member) => {
      if (member.agent_name) map.set(member.agent_id, member.agent_name);
    });
    agents.forEach((agent) => {
      if (!map.has(agent.id)) map.set(agent.id, employeeDisplayName(agent));
    });
    return map;
  }, [team, agents]);

  /** 解析任务负责人显示值；未分配是产品状态，已有姓名/ID 保留为业务标识。 */
  function assigneeName(task: TeamTaskRead): string {
    if (!task.assignee_agent_id) return t('teamDetailPage.value.unassigned');
    return memberNameByAgentId.get(task.assignee_agent_id) || task.assignee_agent_id;
  }

  const candidateAgents = useMemo(() => {
    const memberIds = new Set((team?.members || []).map((member) => member.agent_id));
    return agents.filter((agent) => !agent.is_overall && !memberIds.has(agent.id));
  }, [agents, team]);

  /** 添加员工到团队；输入的员工身份来自选择控件，失败仅显示稳定产品消息。 */
  async function addMember() {
    if (!addAgentId) {
      toast.error(createMessageDescriptor('teamDetailPage.toast.addMemberRequired'));
      return;
    }
    const fence = beginTeamActionFence();
    if (!fence) return;
    setAddingMember(true);
    try {
      await tenantApi.post(`/api/enterprise/teams/${fence.teamId}/members`, {
        agent_id: addAgentId,
      }, { signal: fence.signal });
      if (!fence.isCurrent()) return;
      toast.success(createMessageDescriptor('teamDetailPage.toast.memberAdded'));
      setAddAgentId('');
      if (!fence.isCurrent()) return;
      await Promise.all([loadTeam(fence), loadKnowledgeBindings(fence)]);
    } catch {
      if (fence.isCurrent()) {
        toast.error(createMessageDescriptor('teamDetailPage.toast.addMemberFailed'));
      }
    } finally {
      if (fence.isCurrent()) setAddingMember(false);
      fence.release();
    }
  }

  /** 从团队移除员工；agentId 是业务标识，不作为产品文本翻译。 */
  async function removeMember(agentId: string) {
    const fence = beginTeamActionFence();
    if (!fence) return;
    try {
      await tenantApi.delete(`/api/enterprise/teams/${fence.teamId}/members/${agentId}`, undefined, {
        signal: fence.signal,
      });
      if (!fence.isCurrent()) return;
      toast.success(createMessageDescriptor('teamDetailPage.toast.memberRemoved'));
      if (!fence.isCurrent()) return;
      await Promise.all([loadTeam(fence), loadKnowledgeBindings(fence)]);
    } catch {
      if (fence.isCurrent()) {
        toast.error(createMessageDescriptor('teamDetailPage.toast.removeMemberFailed'));
      }
    } finally {
      fence.release();
    }
  }

  /** 将指定成员提升为项目领导；保留员工名称等原始业务数据。 */
  async function promoteLeader(agentId: string) {
    const fence = beginTeamActionFence();
    if (!fence) return;
    try {
      await tenantApi.put(`/api/enterprise/teams/${fence.teamId}/leader`, {
        agent_id: agentId,
      }, { signal: fence.signal });
      if (!fence.isCurrent()) return;
      toast.success(createMessageDescriptor('teamDetailPage.toast.leaderChanged'));
      if (!fence.isCurrent()) return;
      await loadTeam(fence);
    } catch {
      if (fence.isCurrent()) {
        toast.error(createMessageDescriptor('teamDetailPage.toast.changeLeaderFailed'));
      }
    } finally {
      fence.release();
    }
  }

  /** 创建团队任务；标题和描述是用户业务输入，原样提交且不进入翻译资源。 */
  async function createTask() {
    const title = newTaskTitle.trim();
    if (!title) {
      toast.error(createMessageDescriptor('teamDetailPage.toast.taskTitleRequired'));
      return;
    }
    if (creatingTask) return;
    const fence = beginTeamActionFence();
    if (!fence) return;
    setCreatingTask(true);
    try {
      await tenantApi.post<TeamTaskRead>(`/api/enterprise/teams/${fence.teamId}/tasks`, {
        title,
        description: newTaskDescription.trim() || undefined,
        priority: newTaskPriority,
        assignee_agent_id: newTaskAssignee === POOL_ASSIGNEE_VALUE ? undefined : newTaskAssignee,
      }, { signal: fence.signal });
      if (!fence.isCurrent()) return;
      toast.success(createMessageDescriptor('teamDetailPage.toast.taskCreated'));
      setTaskDialogOpen(false);
      setNewTaskTitle('');
      setNewTaskDescription('');
      setNewTaskPriority('medium');
      setNewTaskAssignee(POOL_ASSIGNEE_VALUE);
      if (!fence.isCurrent()) return;
      await loadTasks(fence);
    } catch {
      if (fence.isCurrent()) {
        toast.error(createMessageDescriptor('teamDetailPage.toast.createTaskFailed'));
      }
    } finally {
      if (fence.isCurrent()) setCreatingTask(false);
      fence.release();
    }
  }

  /** 创建团队领导会话并跳转到群聊；异常正文不会直接展示给用户。 */
  async function startTeamChat() {
    if (!teamId || startingChat) return;
    const fence = beginTeamActionFence();
    if (!fence) return;
    setStartingChat(true);
    try {
      const result = await tenantApi.post<{ session_id: string }>(
        `/api/enterprise/teams/${fence.teamId}/tl/session`,
        undefined,
        { signal: fence.signal },
      );
      if (!fence.isCurrent()) return;
      if (!result.session_id) throw new Error('TEAM_SESSION_MISSING');
      navigate(`${EnterpriseRoute.Chat}/${result.session_id}`);
    } catch {
      if (fence.isCurrent()) {
        toast.error(createMessageDescriptor('teamDetailPage.toast.startChatFailed'));
      }
    } finally {
      if (fence.isCurrent()) setStartingChat(false);
      fence.release();
    }
  }

  /** 打开完整团队日志对话框；日志内容保持 raw 诊断数据，仅状态文本本地化。 */
  async function openTeamLog() {
    if (!teamId || loadingTeamLog) return;
    const fence = beginTeamActionFence();
    if (!fence) return;
    setTeamLogOpen(true);
    setLoadingTeamLog(true);
    try {
      const payload = await tenantApi.get<TeamLogPayload>(
        `/api/enterprise/teams/${fence.teamId}/export`,
        { signal: fence.signal },
      );
      if (!fence.isCurrent()) return;
      setTeamLog(payload);
    } catch {
      if (fence.isCurrent()) {
        setTeamLogOpen(false);
        toast.error(createMessageDescriptor('teamDetailPage.toast.logLoadFailed'));
      }
    } finally {
      if (fence.isCurrent()) setLoadingTeamLog(false);
      fence.release();
    }
  }

  /** 下载团队日志；产品前缀本地化，团队名称作为 raw 文件名片段保留。 */
  function downloadTeamLog() {
    if (!teamLog) return;
    const blob = new Blob([JSON.stringify(teamLog, null, 2)], { type: 'application/json;charset=utf-8' });
    const safeName = (team?.name || teamId).replace(/[^\w\-\u4e00-\u9fff]+/g, '-');
    uiSinks.download(
      blob,
      createMessageDescriptor('teamDetailPage.download.teamLog'),
      `firmdeck-${safeName || teamId}`,
      'json',
    );
    toast.success(createMessageDescriptor('teamDetailPage.toast.logDownloaded'));
  }

  /** 创建黑板条目；黑板正文与标签属于用户业务输入，不翻译。 */
  async function addBoardEntry() {
    const content = boardContent.trim();
    if (!content) {
      toast.error(createMessageDescriptor('teamDetailPage.toast.boardContentRequired'));
      return;
    }
    if (postingEntry) return;
    const fence = beginTeamActionFence();
    if (!fence) return;
    setPostingEntry(true);
    try {
      await tenantApi.post(`/api/enterprise/teams/${fence.teamId}/blackboard`, {
        content,
        tags: parseTags(boardTags),
      }, { signal: fence.signal });
      if (!fence.isCurrent()) return;
      toast.success(createMessageDescriptor('teamDetailPage.toast.boardAdded'));
      setBoardContent('');
      setBoardTags('');
      if (!fence.isCurrent()) return;
      await loadBoard(fence);
    } catch {
      if (fence.isCurrent()) {
        toast.error(createMessageDescriptor('teamDetailPage.toast.boardAddFailed'));
      }
    } finally {
      if (fence.isCurrent()) setPostingEntry(false);
      fence.release();
    }
  }

  /** 切换黑板条目置顶状态；仅状态动作文本使用当前 UI locale。 */
  async function togglePinEntry(entry: TeamBlackboardEntryRead) {
    const fence = beginTeamActionFence();
    if (!fence) return;
    try {
      await tenantApi.put(`/api/enterprise/teams/${fence.teamId}/blackboard/${entry.id}`, {
        pinned: !entry.pinned,
      }, { signal: fence.signal });
      if (!fence.isCurrent()) return;
      toast.success(createMessageDescriptor(
        (entry.pinned ? 'teamDetailPage.toast.boardUnpinned' : 'teamDetailPage.toast.boardPinned'),
      ));
      if (!fence.isCurrent()) return;
      await loadBoard(fence);
    } catch {
      if (fence.isCurrent()) {
        toast.error(createMessageDescriptor('teamDetailPage.toast.boardUpdateFailed'));
      }
    } finally {
      fence.release();
    }
  }

  function openEditEntry(entry: TeamBlackboardEntryRead) {
    setEditingEntry(entry);
    setEditContent(entry.content);
    setEditTags(entry.tags.join(', '));
  }

  /** 保存黑板正文和标签；编辑内容保持用户原文。 */
  async function saveEditEntry() {
    const entry = editingEntry;
    if (!entry || savingEntry) return;
    const content = editContent.trim();
    if (!content) {
      toast.error(createMessageDescriptor('teamDetailPage.toast.boardContentRequired'));
      return;
    }
    const fence = beginTeamActionFence();
    if (!fence) return;
    setSavingEntry(true);
    try {
      await tenantApi.put(`/api/enterprise/teams/${fence.teamId}/blackboard/${entry.id}`, {
        content,
        tags: parseTags(editTags),
      }, { signal: fence.signal });
      if (!fence.isCurrent()) return;
      toast.success(createMessageDescriptor('teamDetailPage.toast.boardUpdated'));
      setEditingEntry(null);
      if (!fence.isCurrent()) return;
      await loadBoard(fence);
    } catch {
      if (fence.isCurrent()) {
        toast.error(createMessageDescriptor('teamDetailPage.toast.boardUpdateFailed'));
      }
    } finally {
      if (fence.isCurrent()) setSavingEntry(false);
      fence.release();
    }
  }

  /** 归档黑板条目；确认对话框文案通过 descriptor 本地化。 */
  async function archiveBoardEntry(entry: TeamBlackboardEntryRead) {
    if (!uiSinks.confirm(createMessageDescriptor('teamDetailPage.confirm.archiveDescription'))) return;
    const fence = beginTeamActionFence();
    if (!fence) return;
    try {
      await tenantApi.post(
        `/api/enterprise/teams/${fence.teamId}/blackboard/${entry.id}/archive`,
        undefined,
        { signal: fence.signal },
      );
      if (!fence.isCurrent()) return;
      toast.success(createMessageDescriptor('teamDetailPage.toast.boardArchived'));
      if (!fence.isCurrent()) return;
      await loadBoard(fence);
    } catch {
      if (fence.isCurrent()) {
        toast.error(createMessageDescriptor('teamDetailPage.toast.boardArchiveFailed'));
      }
    } finally {
      fence.release();
    }
  }

  /** 解析黑板来源；产品角色使用 locale 文案，员工标识保持原始业务值。 */
  function boardSourceLabel(entry: TeamBlackboardEntryRead): string {
    if (entry.source_type === 'human') return t('teamDetailPage.role.human');
    if (entry.source_type === 'leader') return t('teamDetailPage.role.tl');
    if (entry.source_agent_id) {
      return memberNameByAgentId.get(entry.source_agent_id) || entry.source_agent_id;
    }
    return t('teamDetailPage.role.member');
  }

  /** 将黑板条目沉淀到知识库；服务端错误正文不透传至产品 toast。 */
  async function promoteBoardEntry(entry: TeamBlackboardEntryRead) {
    if (promotingEntryId) return;
    const fence = beginTeamActionFence();
    if (!fence) return;
    setPromotingEntryId(entry.id);
    try {
      await tenantApi.post(
        `/api/enterprise/teams/${fence.teamId}/blackboard/${entry.id}/promote`,
        undefined,
        { signal: fence.signal },
      );
      if (!fence.isCurrent()) return;
      toast.success(createMessageDescriptor('teamDetailPage.toast.boardPromoted'));
      if (!fence.isCurrent()) return;
      await loadBoard(fence);
    } catch {
      if (fence.isCurrent()) {
        toast.error(createMessageDescriptor('teamDetailPage.toast.boardPromoteFailed'));
      }
    } finally {
      if (fence.isCurrent()) setPromotingEntryId(null);
      fence.release();
    }
  }

  /** 保存一个共享知识库的成员权限矩阵；权限数据是结构化业务值。 */
  async function saveKnowledgeGrants(
    binding: TeamKnowledgeBindingRead,
    grants: TeamKnowledgeGrantInput[],
  ) {
    /** Save the complete displayed matrix under the binding's optimistic-lock revision. */
    const fence = beginTeamActionFence();
    if (!fence) return;
    setKnowledgeBusyIds((current) => new Set(current).add(binding.id));
    try {
      const updated = await tenantApi.put<TeamKnowledgeBindingRead>(
        `/api/enterprise/teams/${fence.teamId}/knowledge-bases/${binding.knowledge_base_id}/grants`,
        {
          expected_revision: binding.revision,
          grants,
        },
        { signal: fence.signal },
      );
      if (!fence.isCurrent()) return;
      setKnowledgeBindings((current) => current.map((row) => (
        row.id === updated.id ? updated : row
      )));
      toast.success(createMessageDescriptor('teamDetailPage.toast.knowledgeSaved'));
    } catch (error) {
      if (!fence.isCurrent()) return;
      const errorMessageId = apiErrorCode(error) === 'KNOWLEDGE_BINDING_REVISION_CONFLICT'
        ? 'teamDetailPage.toast.knowledgeRevisionConflict'
        : 'teamDetailPage.toast.knowledgeSaveFailed';
      toast.error(createMessageDescriptor(errorMessageId));
      if (apiErrorCode(error) === 'KNOWLEDGE_BINDING_REVISION_CONFLICT') {
        if (!fence.isCurrent()) return;
        await loadKnowledgeBindings(fence);
      }
    } finally {
      if (fence.isCurrent()) {
        setKnowledgeBusyIds((current) => {
          const next = new Set(current);
          next.delete(binding.id);
          return next;
        });
      }
      fence.release();
    }
  }

  /** 将团队默认写入目标切换到指定共享知识库。 */
  async function setDefaultKnowledgeBase(binding: TeamKnowledgeBindingRead) {
    /** Select one bound shared base as the team's default write target. */
    const fence = beginTeamActionFence();
    if (!fence) return;
    setKnowledgeBusyIds((current) => new Set(current).add(binding.id));
    try {
      await tenantApi.put<TeamKnowledgeBindingRead>(
        `/api/enterprise/teams/${fence.teamId}/knowledge-bases/${binding.knowledge_base_id}`,
        {
          expected_revision: binding.revision,
          is_default: true,
        },
        { signal: fence.signal },
      );
      if (!fence.isCurrent()) return;
      toast.success(createMessageDescriptor('teamDetailPage.toast.defaultKnowledgeUpdated'));
      if (!fence.isCurrent()) return;
      await Promise.all([loadTeam(fence), loadKnowledgeBindings(fence)]);
    } catch (error) {
      if (!fence.isCurrent()) return;
      toast.error(createMessageDescriptor('teamDetailPage.toast.defaultKnowledgeFailed'));
      if (apiErrorCode(error) === 'KNOWLEDGE_BINDING_REVISION_CONFLICT') {
        if (!fence.isCurrent()) return;
        await loadKnowledgeBindings(fence);
      }
    } finally {
      if (fence.isCurrent()) {
        setKnowledgeBusyIds((current) => {
          const next = new Set(current);
          next.delete(binding.id);
          return next;
        });
      }
      fence.release();
    }
  }

  /** 撤销团队共享知识库绑定；确认描述保留原始知识库名称作为参数。 */
  async function removeKnowledgeBase(binding: TeamKnowledgeBindingRead) {
    /** Revoke only this team's binding and grants after explicit confirmation. */
    if (!uiSinks.confirm(createMessageDescriptor('teamDetailPage.confirm.removeKnowledge', {
      knowledgeBaseName: binding.knowledge_base_name,
    }))) return;
    const fence = beginTeamActionFence();
    if (!fence) return;
    setKnowledgeBusyIds((current) => new Set(current).add(binding.id));
    try {
      await tenantApi.delete(
        `/api/enterprise/teams/${fence.teamId}/knowledge-bases/${binding.knowledge_base_id}`,
        {
          expected_revision: binding.revision,
        },
        { signal: fence.signal },
      );
      if (!fence.isCurrent()) return;
      toast.success(createMessageDescriptor('teamDetailPage.toast.knowledgeRemoved'));
      if (!fence.isCurrent()) return;
      await Promise.all([loadTeam(fence), loadKnowledgeBindings(fence)]);
    } catch (error) {
      if (!fence.isCurrent()) return;
      toast.error(createMessageDescriptor('teamDetailPage.toast.removeKnowledgeFailed'));
      if (apiErrorCode(error) === 'KNOWLEDGE_BINDING_REVISION_CONFLICT') {
        if (!fence.isCurrent()) return;
        await loadKnowledgeBindings(fence);
      }
    } finally {
      if (fence.isCurrent()) {
        setKnowledgeBusyIds((current) => {
          const next = new Set(current);
          next.delete(binding.id);
          return next;
        });
      }
      fence.release();
    }
  }

  /** 绑定已存在的共享知识库；知识库名称和 ID 均保持业务原值。 */
  async function bindExistingKnowledgeBase() {
    /** Bind one reusable shared base selected from the tenant management list. */
    if (!addKnowledgeBaseId) return;
    const fence = beginTeamActionFence();
    if (!fence) return;
    setKnowledgeBusyIds((current) => new Set(current).add('add-existing'));
    try {
      await tenantApi.post<TeamKnowledgeBindingRead>(
        `/api/enterprise/teams/${fence.teamId}/knowledge-bases`,
        {
          existing_knowledge_base_id: addKnowledgeBaseId,
          is_default: false,
        },
        { signal: fence.signal },
      );
      if (!fence.isCurrent()) return;
      setAddKnowledgeBaseId('');
      toast.success(createMessageDescriptor('teamDetailPage.toast.knowledgeBound'));
      if (!fence.isCurrent()) return;
      await loadKnowledgeBindings(fence);
    } catch {
      if (fence.isCurrent()) {
        toast.error(createMessageDescriptor('teamDetailPage.toast.bindKnowledgeFailed'));
      }
    } finally {
      if (fence.isCurrent()) {
        setKnowledgeBusyIds((current) => {
          const next = new Set(current);
          next.delete('add-existing');
          return next;
        });
      }
      fence.release();
    }
  }

  /** 创建并绑定共享知识库；用户输入的知识库名称不翻译。 */
  async function createAndBindSharedKnowledgeBase() {
    /** Create a generic shared base and bind it to this team in one request. */
    const name = newSharedKnowledgeName.trim();
    if (!name) return;
    const fence = beginTeamActionFence();
    if (!fence) return;
    setKnowledgeBusyIds((current) => new Set(current).add('create-shared'));
    try {
      await tenantApi.post<TeamKnowledgeBindingRead>(
        `/api/enterprise/teams/${fence.teamId}/knowledge-bases`,
        {
          create_shared: { name },
          is_default: false,
        },
        { signal: fence.signal },
      );
      if (!fence.isCurrent()) return;
      setNewSharedKnowledgeName('');
      toast.success(createMessageDescriptor('teamDetailPage.toast.knowledgeCreated'));
      if (!fence.isCurrent()) return;
      await Promise.all([loadKnowledgeBindings(fence), loadAvailableSharedKnowledge(fence)]);
    } catch {
      if (fence.isCurrent()) {
        toast.error(createMessageDescriptor('teamDetailPage.toast.createKnowledgeFailed'));
      }
    } finally {
      if (fence.isCurrent()) {
        setKnowledgeBusyIds((current) => {
          const next = new Set(current);
          next.delete('create-shared');
          return next;
        });
      }
      fence.release();
    }
  }

  /** 解析事件操作者标签；成员名称保留 raw，系统角色使用语义消息。 */
  function eventActorLabel(event: TeamEventRead): string {
    if (event.actor_id) {
      const name = memberNameByAgentId.get(event.actor_id);
      if (name) return name;
    }
    if (event.actor_type === 'user') return t('teamDetailPage.role.user');
    if (event.actor_type === 'system') return t('teamDetailPage.role.system');
    if (event.actor_type === 'tl') return t('teamDetailPage.role.tl');
    return event.actor_type;
  }

  /** 保存团队运行参数；数字字段由业务校验后提交，不依赖固定地区格式。 */
  async function saveTeamConfig() {
    if (!team || savingConfig) return;
    const concurrency = Number(configConcurrency);
    const timeoutMinutes = Number(configTaskTimeout);
    const rebuttalRounds = Number(configBidRounds);
    const valid =
      Number.isInteger(concurrency) && concurrency >= 1 &&
      Number.isInteger(timeoutMinutes) && timeoutMinutes >= 1 &&
      Number.isInteger(rebuttalRounds) && rebuttalRounds >= 0;
    if (!valid) {
      toast.error(createMessageDescriptor('teamDetailPage.toast.invalidNumber'));
      return;
    }
    const fence = beginTeamActionFence();
    if (!fence) return;
    setSavingConfig(true);
    try {
      await tenantApi.put(`/api/enterprise/teams/${fence.teamId}`, {
        config: {
          ...(team.config || {}),
          member_concurrency: concurrency,
          task_timeout_minutes: timeoutMinutes,
          bid_rebuttal_rounds: rebuttalRounds,
        },
      }, { signal: fence.signal });
      if (!fence.isCurrent()) return;
      toast.success(createMessageDescriptor('teamDetailPage.toast.settingsSaved'));
      if (!fence.isCurrent()) return;
      await loadTeam(fence);
    } catch {
      if (fence.isCurrent()) {
        toast.error(createMessageDescriptor('teamDetailPage.toast.settingsFailed'));
      }
    } finally {
      if (fence.isCurrent()) setSavingConfig(false);
      fence.release();
    }
  }

  /** 打开任务详情并刷新完整任务记录；标题、报告与评论保持 raw。 */
  async function openTask(task: TeamTaskRead, expectedRouteRevision = routeRevisionRef.current.revision) {
    const context = tenantContext;
    const generation = context?.generation;
    const routeFence = captureTeamRouteFence();
    if (
      !context
      || generation === undefined
      || !routeFence
      || routeFence.routeRevision !== expectedRouteRevision
      || !routeFence.isCurrent()
    ) return;
    const isCurrent = () => context.isCurrentGeneration(generation) && routeFence.isCurrent();
    setActiveTask(task);
    setOverrideComment('');
    setAwardAgentId('');
    setAwardComment('');
    try {
      const detail = await tenantApi.get<TeamTaskRead>(
        `/api/enterprise/teams/${routeFence.teamId}/tasks/${task.id}`,
        { signal: routeFence.signal },
      );
      if (!isCurrent()) return;
      setActiveTask(detail);
    } catch {
      // 详情加载失败时保留列表中的概要数据
    }
  }

  /** 为竞标任务指定执行者；评论是用户业务输入，不翻译。 */
  async function awardOverride() {
    const task = activeTask;
    if (!task || awarding) return;
    if (!awardAgentId) {
      toast.error(createMessageDescriptor('teamDetailPage.toast.executorRequired'));
      return;
    }
    const fence = beginTeamActionFence();
    if (!fence) return;
    setAwarding(true);
    try {
      await tenantApi.post<TeamTaskRead>(
        `/api/enterprise/teams/${fence.teamId}/tasks/${task.id}/award-override`,
        {
          agent_id: awardAgentId,
          comment: awardComment.trim() || undefined,
        },
        { signal: fence.signal },
      );
      if (!fence.isCurrent()) return;
      toast.success(createMessageDescriptor('teamDetailPage.toast.overrideSubmitted'));
      setActiveTask(null);
      if (!fence.isCurrent()) return;
      await loadTasks(fence);
    } catch {
      if (fence.isCurrent()) {
        toast.error(createMessageDescriptor('teamDetailPage.toast.overrideFailed'));
      }
    } finally {
      if (fence.isCurrent()) setAwarding(false);
      fence.release();
    }
  }

  /** 提交人工验收改判；结论为稳定协议枚举，说明文本保持用户原文。 */
  async function overrideTask(verdict: TeamReviewVerdict) {
    const task = activeTask;
    if (!task || overriding) return;
    const fence = beginTeamActionFence();
    if (!fence) return;
    setOverriding(true);
    try {
      await tenantApi.post<TeamTaskRead>(
        `/api/enterprise/teams/${fence.teamId}/tasks/${task.id}/override`,
        {
          verdict,
          comment: overrideComment.trim() || undefined,
        },
        { signal: fence.signal },
      );
      if (!fence.isCurrent()) return;
      toast.success(createMessageDescriptor('teamDetailPage.toast.overrideSubmitted'));
      setActiveTask(null);
      if (!fence.isCurrent()) return;
      await loadTasks(fence);
    } catch {
      if (fence.isCurrent()) {
        toast.error(createMessageDescriptor('teamDetailPage.toast.overrideFailed'));
      }
    } finally {
      if (fence.isCurrent()) setOverriding(false);
      fence.release();
    }
  }

  const tasksByStatus = useMemo(() => {
    const grouped = new Map<string, TeamTaskRead[]>();
    TASK_STATUS_COLUMNS.forEach((column) => grouped.set(column.status, []));
    tasks.forEach((task) => {
      const bucket = grouped.get(task.status) || [];
      bucket.push(task);
      grouped.set(task.status, bucket);
    });
    grouped.forEach((bucket) => {
      bucket.sort(
        (a, b) => parseBackendDateTime(b.created_at).getTime() - parseBackendDateTime(a.created_at).getTime(),
      );
    });
    return grouped;
  }, [tasks]);

  const agentById = useMemo(() => {
    return new Map(agents.map((agent) => [agent.id, agent]));
  }, [agents]);

  type EventGroup = {
    key: string;
    task: TeamTaskRead | null;
    title: string;
    events: TeamEventRead[];
    latest: number;
  };

  const eventGroups = useMemo(() => {
    const groups = new Map<string, EventGroup>();
    teamEvents.forEach((event) => {
      const key = event.task_id || '__other__';
      let group = groups.get(key);
      if (!group) {
        const task = event.task_id
          ? tasks.find((item) => item.id === event.task_id) || null
          : null;
        group = {
          key,
          task,
          title: event.task_id ? event.task_title || task?.title || '' : '',
          events: [],
          latest: 0,
        };
        groups.set(key, group);
      }
      group.events.push(event);
    });
    const result = [...groups.values()];
    result.forEach((group) => {
      group.events.sort(
        (a, b) => parseBackendDateTime(b.created_at).getTime() - parseBackendDateTime(a.created_at).getTime(),
      );
      group.latest = group.events[0]
        ? parseBackendDateTime(group.events[0].created_at).getTime() || 0
        : 0;
    });
    result.sort((a, b) => b.latest - a.latest);
    return result;
  }, [teamEvents, tasks]);

  const sortedBoardEntries = useMemo(() => {
    return [...boardEntries].sort((a, b) => Number(b.pinned) - Number(a.pinned));
  }, [boardEntries]);

  const bidRounds = useMemo(() => {
    const grouped = new Map<number, TeamTaskBidRead[]>();
    (activeTask?.bids || []).forEach((bid) => {
      const list = grouped.get(bid.round) || [];
      list.push(bid);
      grouped.set(bid.round, list);
    });
    return [...grouped.entries()].sort((a, b) => a[0] - b[0]);
  }, [activeTask]);

  // 已裁决：存在竞标记录且已有负责人（竞标中状态视为未裁决）
  const biddingWinnerId =
    activeTask && activeTask.status !== 'bidding' && bidRounds.length > 0
      ? activeTask.assignee_agent_id || null
      : null;

  const awardCandidates = useMemo(() => {
    const members = team?.members || [];
    const bidderIds = new Set((activeTask?.bids || []).map((bid) => bid.agent_id));
    return [...members].sort(
      (a, b) => Number(bidderIds.has(b.agent_id)) - Number(bidderIds.has(a.agent_id)),
    );
  }, [team, activeTask]);

  const reportSummary = textField(activeTask?.report, 'summary');
  const reportFullReply = textField(activeTask?.report, 'full_reply');
  const reviewVerdict = textField(activeTask?.review, 'verdict');
  const reviewComment = textField(activeTask?.review, 'comment');

  return (
    <div className="min-h-full box-border px-[48px] pt-[32px] pb-[43px] max-[900px]:px-[16px]" aria-busy={loading}>
      <AppHeader
        onLogout={onLogout}
        userName={currentUser?.username}
        title={team?.name || t('teamDetailPage.fallback.title')}
        description={team?.description || undefined}
      />

      <div className="mt-[16px] flex items-center justify-between gap-[12px]">
        <Button
          type="button"
          variant="outline"
          onClick={() => navigate(EnterpriseRoute.Teams)}
          className="h-[32px] rounded-[10px] border-[#e3e7f1] px-[12px] text-[12px] font-normal text-[#464c5e]"
        >
          {t('teamDetailPage.action.backToTeams')}
        </Button>
        <div className="flex items-center gap-[8px]">
          <Button
            type="button"
            variant="outline"
            disabled={loadingTeamLog || !team}
            onClick={() => void openTeamLog()}
            className="h-[34px] gap-[6px] rounded-[10px] border-[#e3e7f1] px-[14px] text-[12px] font-normal text-[#464c5e]"
          >
            {loadingTeamLog ? <LoaderCircle className="size-[14px] animate-spin" /> : <Eye className="size-[14px]" />}
            {loadingTeamLog ? t('teamDetailPage.action.loading') : t('teamDetailPage.action.viewLog')}
          </Button>
          <Button
            type="button"
            disabled={startingChat || !team}
            onClick={() => void startTeamChat()}
            className="h-[34px] gap-[6px] rounded-[10px] bg-[#18181a] px-[14px] text-[12px] font-normal text-white hover:bg-[#303030]"
          >
            <MessageCircle className="size-[14px]" />
            {startingChat ? t('teamDetailPage.action.startingChat') : t('teamDetailPage.action.startChat')}
          </Button>
        </div>
      </div>

      <div className="mt-[16px] grid grid-cols-1 gap-[20px] lg:grid-cols-2">
        <section aria-label={t('teamDetailPage.section.members')} className="rounded-[20px] bg-white p-[20px] shadow-[0_0_6px_rgba(0,0,0,0.05)]">
          <div className="mb-[12px] flex items-center justify-between">
            <h2 className="text-[16px] font-medium text-[#18181a]">{t('teamDetailPage.section.members')}</h2>
            <Badge variant="secondary" className="rounded-full bg-[#f2f3f7] text-[12px] font-normal text-[#464c5e]">
              {team ? teamStatusLabelForDetail(team.status, t) : ''}
            </Badge>
          </div>
          <div className="flex flex-col gap-[8px]">
            {(() => {
              const members = team?.members || [];
              const leader = members.find((member) => member.role === 'leader');
              const others = members.filter((member) => member.role !== 'leader');

              /** 渲染单个成员节点；姓名和身份 ID 是 raw 业务数据。 */
              function memberNode(member: TeamMemberRead, isLeader: boolean) {
                return (
                  <div className={cn(
                    'relative flex w-[156px] shrink-0 flex-col items-center gap-[7px] rounded-[12px] border border-[#eef1f6] bg-white px-[12px] py-[12px]',
                    isLeader && 'mt-[12px] border-[#d9e5ff] pt-[17px] shadow-[0_5px_16px_rgba(26,113,255,0.08)]',
                  )}>
                    {isLeader && (
                      <span className="absolute -top-[12px] inline-flex h-[24px] items-center gap-[4px] rounded-full border border-[#cfe0ff] bg-[#f2f6ff] px-[9px] text-[11px] font-medium text-[#1a71ff] shadow-[0_2px_7px_rgba(26,113,255,0.12)]">
                        <Crown className="size-[12px]" />
                        {t('teamDetailPage.status.leader')}
                      </span>
                    )}
                    <EmployeeAvatar agent={agentById.get(member.agent_id)} size={48} radius={14} />
                    <span
                      className="max-w-full truncate text-[13px] font-medium text-[#18181a]"
                      title={member.agent_name || member.agent_id}
                    >
                      <RawIdentifier value={member.agent_name || member.agent_id} />
                    </span>
                    {!isLeader && (
                      <Badge
                        variant="secondary"
                        className="shrink-0 rounded-full bg-[#f2f3f7] text-[12px] font-normal text-[#858b9c]"
                      >
                        {t('teamDetailPage.status.member')}
                      </Badge>
                    )}
                    <div className="flex min-h-[28px] w-full items-center justify-center gap-[4px]">
                      {!isLeader && (
                        <button
                          type="button"
                          onClick={() => void promoteLeader(member.agent_id)}
                          className="shrink-0 whitespace-nowrap rounded-[8px] px-[6px] py-[4px] text-[12px] text-[#464c5e] transition-colors hover:bg-[#f6f6f6]"
                        >
                          {t('teamDetailPage.action.promoteLeader')}
                        </button>
                      )}
                      <button
                        type="button"
                        aria-label={t('teamDetailPage.action.removeMember', {
                          memberName: member.agent_name || member.agent_id,
                        })}
                        onClick={() => void removeMember(member.agent_id)}
                        className="shrink-0 whitespace-nowrap rounded-[8px] px-[6px] py-[4px] text-[12px] text-[#858b9c] transition-colors hover:bg-[#fce7e7] hover:text-[#f5483b]"
                      >
                        {t('teamDetailPage.action.removeMemberButton')}
                      </button>
                    </div>
                  </div>
                );
              }

              return (
                <div className="flex flex-col items-center">
                  {leader && memberNode(leader, true)}
                  {leader && others.length > 0 && <div className="h-[14px] w-px bg-[#dbe1ec]" />}
                  {others.length > 0 && (
                    <div className="relative w-full">
                      {memberScrollEdges.left && (
                        <div
                          aria-hidden="true"
                          data-scroll-edge="left"
                          className="pointer-events-none absolute inset-y-0 left-0 z-10 w-[44px] bg-gradient-to-r from-white via-white/85 to-transparent"
                        />
                      )}
                      {memberScrollEdges.right && (
                        <div
                          aria-hidden="true"
                          data-scroll-edge="right"
                          className="pointer-events-none absolute inset-y-0 right-0 z-10 w-[44px] bg-gradient-to-l from-white via-white/85 to-transparent"
                        />
                      )}
                      <div
                        ref={memberScrollRef}
                        role="region"
                        aria-label={t('teamDetailPage.section.memberList')}
                        aria-describedby={memberScrollEdges.overflow ? 'team-member-scroll-hint' : undefined}
                        tabIndex={0}
                        className="max-w-full overflow-x-auto overscroll-x-contain pb-[8px] outline-none [scrollbar-color:#cfd5e2_transparent] [scrollbar-width:thin] focus-visible:ring-2 focus-visible:ring-[#a9c7ff] focus-visible:ring-offset-2 [&::-webkit-scrollbar]:h-[6px] [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[#cfd5e2] [&::-webkit-scrollbar-track]:bg-transparent"
                      >
                        <div className="flex w-max min-w-full justify-center gap-[12px] px-[4px]">
                          {others.map((member, index) => (
                            <div key={member.id} className="flex flex-col items-center">
                              {leader && (
                                <>
                                  <div className="flex w-full">
                                    <div
                                      className={cn(
                                        '-mr-[6px] h-px w-[calc(50%+6px)]',
                                        index > 0 && 'bg-[#dbe1ec]',
                                      )}
                                    />
                                    <div
                                      className={cn(
                                        '-ml-[6px] h-px w-[calc(50%+6px)]',
                                        index < others.length - 1 && 'bg-[#dbe1ec]',
                                      )}
                                    />
                                  </div>
                                  <div className="h-[12px] w-px bg-[#dbe1ec]" />
                                </>
                              )}
                              {memberNode(member, false)}
                            </div>
                          ))}
                        </div>
                      </div>
                      {memberScrollEdges.overflow && (
                        <p
                          id="team-member-scroll-hint"
                          className="mt-[5px] flex items-center justify-center gap-[5px] text-[11px] text-[#858b9c]"
                        >
                          <ChevronLeft className="size-[12px]" aria-hidden="true" />
                          {t('teamDetailPage.value.horizontalScrollHint')}
                          <ChevronRight className="size-[12px]" aria-hidden="true" />
                        </p>
                      )}
                    </div>
                  )}
                  {team && members.length === 0 && (
                    <p className="py-[12px] text-center text-[12px] text-[#a7adbb]">{t('teamDetailPage.value.noMembers')}</p>
                  )}
                </div>
              );
            })()}
          </div>
          <div className="mt-[12px] flex items-center gap-[8px]">
            <Select value={addAgentId} onValueChange={setAddAgentId}>
              <SelectTrigger aria-label={t('teamDetailPage.members.selectEmployee')} className="h-[36px] flex-1 rounded-[10px] border-[#e3e7f1] text-[14px]">
                <SelectValue placeholder={t('teamDetailPage.members.selectEmployee')} />
              </SelectTrigger>
              <SelectContent>
                {candidateAgents.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>
                    {employeeDisplayName(agent)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              disabled={addingMember}
              onClick={() => void addMember()}
              className="h-[36px] shrink-0 rounded-[10px] bg-[#18181a] px-[16px] text-[14px] font-normal text-white hover:bg-[#303030]"
            >
              {t('teamDetailPage.members.add')}
            </Button>
          </div>
        </section>

        <section aria-label={t('teamDetailPage.section.settings')} className="rounded-[20px] bg-white p-[20px] shadow-[0_0_6px_rgba(0,0,0,0.05)]">
          <h2 className="mb-[12px] text-[16px] font-medium text-[#18181a]">{t('teamDetailPage.section.settings')}</h2>
          <div className="grid grid-cols-1 gap-[12px] sm:grid-cols-3">
            <label className="flex flex-col gap-[6px] text-[12px] text-[#464c5e]">
              {t('teamDetailPage.settings.memberConcurrency')}
              <Input
                type="number"
                min={1}
                step={1}
                value={configConcurrency}
                onChange={(event) => setConfigConcurrency(event.target.value)}
                aria-label={t('teamDetailPage.settings.memberConcurrency')}
                className="h-[36px] rounded-[10px] border-[#e3e7f1] text-[14px]"
              />
            </label>
            <label className="flex flex-col gap-[6px] text-[12px] text-[#464c5e]">
              {t('teamDetailPage.settings.taskTimeout')}
              <Input
                type="number"
                min={1}
                step={1}
                value={configTaskTimeout}
                onChange={(event) => setConfigTaskTimeout(event.target.value)}
                aria-label={t('teamDetailPage.settings.taskTimeout')}
                className="h-[36px] rounded-[10px] border-[#e3e7f1] text-[14px]"
              />
            </label>
            <label className="flex flex-col gap-[6px] text-[12px] text-[#464c5e]">
              {t('teamDetailPage.settings.bidRebuttalRounds')}
              <Input
                type="number"
                min={0}
                step={1}
                value={configBidRounds}
                onChange={(event) => setConfigBidRounds(event.target.value)}
                aria-label={t('teamDetailPage.settings.bidRebuttalRounds')}
                className="h-[36px] rounded-[10px] border-[#e3e7f1] text-[14px]"
              />
            </label>
          </div>
          <div className="mt-[12px] flex justify-end">
            <Button
              type="button"
              disabled={savingConfig || !team}
              onClick={() => void saveTeamConfig()}
              className="h-[32px] rounded-[10px] bg-[#18181a] px-[16px] text-[13px] font-normal text-white hover:bg-[#303030]"
            >
              {savingConfig ? t('teamDetailPage.settings.saving') : t('teamDetailPage.settings.save')}
            </Button>
          </div>
        </section>
      </div>

      <section
        aria-label={t('teamDetailPage.section.knowledge')}
        className="mt-[20px] rounded-[20px] bg-white p-[20px] shadow-[0_0_6px_rgba(0,0,0,0.05)]"
      >
        <div className="flex flex-wrap items-start justify-between gap-[12px]">
          <div>
            <h2 className="text-[16px] font-medium text-[#18181a]">{t('teamDetailPage.section.knowledge')}</h2>
            <p className="mt-[3px] text-[12px] text-[#858b9c]">
              {t('teamDetailPage.knowledge.description')}
            </p>
          </div>
          <Badge className="rounded-full bg-[#f2f3f7] text-[11px] font-normal text-[#464c5e]">
            {t('teamDetailPage.value.bindingCount', { count: knowledgeBindings.length })}
          </Badge>
        </div>

        <div className="mt-[14px] flex flex-col gap-[10px]">
          {knowledgeBindings.map((binding) => (
            <TeamKnowledgePermissionMatrix
              key={binding.id}
              binding={binding}
              members={team?.members || []}
              busy={knowledgeBusyIds.has(binding.id)}
              onSave={saveKnowledgeGrants}
              onSetDefault={setDefaultKnowledgeBase}
              onRemove={removeKnowledgeBase}
            />
          ))}
          {knowledgeBindings.length === 0 && (
            <p className="rounded-[12px] bg-[#fafbfd] py-[18px] text-center text-[12px] text-[#a7adbb]">
              {t('teamDetailPage.value.noKnowledge')}
            </p>
          )}
        </div>

        <div className="mt-[14px] grid gap-[10px] border-t border-[#eef1f6] pt-[14px] lg:grid-cols-2">
          <div className="flex items-center gap-[8px]">
            <select
              aria-label={t('teamDetailPage.knowledge.selectExisting')}
              value={addKnowledgeBaseId}
              onChange={(event) => setAddKnowledgeBaseId(event.target.value)}
              className="h-[34px] min-w-0 flex-1 rounded-[9px] border border-[#dfe4ed] bg-white px-[9px] text-[12px] text-[#464c5e]"
            >
              <option value="">{t('teamDetailPage.knowledge.selectExisting')}</option>
              {availableSharedKnowledge
                .filter((knowledgeBase) => !knowledgeBindings.some(
                  (binding) => binding.knowledge_base_id === knowledgeBase.id,
                ))
                .map((knowledgeBase) => (
                  <option key={knowledgeBase.id} value={knowledgeBase.id}>{knowledgeBase.name}</option>
                ))}
            </select>
            <Button
              type="button"
              disabled={!addKnowledgeBaseId || knowledgeBusyIds.size > 0}
              onClick={() => void bindExistingKnowledgeBase()}
              className="h-[34px] shrink-0 rounded-[9px] bg-[#18181a] px-[12px] text-[12px] text-white"
            >
              {t('teamDetailPage.knowledge.bind')}
            </Button>
          </div>
          <div className="flex items-center gap-[8px]">
            <Input
              value={newSharedKnowledgeName}
              onChange={(event) => setNewSharedKnowledgeName(event.target.value)}
              aria-label={t('teamDetailPage.knowledge.createNameAria')}
              placeholder={t('teamDetailPage.knowledge.createName')}
              className="h-[34px] min-w-0 flex-1 text-[12px]"
            />
            <Button
              type="button"
              disabled={!newSharedKnowledgeName.trim() || knowledgeBusyIds.size > 0}
              onClick={() => void createAndBindSharedKnowledgeBase()}
              className="h-[34px] shrink-0 rounded-[9px] bg-[#18181a] px-[12px] text-[12px] text-white"
            >
              {t('teamDetailPage.knowledge.createAndBind')}
            </Button>
          </div>
        </div>
      </section>

      <section aria-label={t('teamDetailPage.section.blackboard')} className="mt-[20px] rounded-[20px] bg-white p-[20px] shadow-[0_0_6px_rgba(0,0,0,0.05)]">
        <h2 className="mb-[12px] text-[16px] font-medium text-[#18181a]">{t('teamDetailPage.section.blackboard')}</h2>
        <div className="flex flex-col gap-[8px]">
          {sortedBoardEntries.map((entry) => {
            const taskTitle = textField(entry.citation, 'task_title');
            const promoted = Boolean(textField(entry.citation, 'knowledge_base_id'));
            return (
              <div
                key={entry.id}
                className="rounded-[12px] border border-[#eef1f6] px-[12px] py-[10px]"
              >
                <div className="flex items-start gap-[8px]">
                  <p className="min-w-0 flex-1 text-[14px] leading-[20px] whitespace-pre-wrap text-[#18181a]">
                    <RawContent value={entry.content} />
                  </p>
                  {entry.pinned && (
                    <Badge variant="secondary" className="shrink-0 rounded-full bg-[#e8f0ff] text-[12px] font-normal text-[#1a71ff]">
                      {t('teamDetailPage.blackboard.pinned')}
                    </Badge>
                  )}
                </div>
                {entry.tags.length > 0 && (
                  <div className="mt-[6px] flex flex-wrap gap-[6px]">
                    {entry.tags.map((tag) => (
                      <Badge
                        key={tag}
                        variant="secondary"
                        className="rounded-full bg-[#f2f3f7] text-[12px] font-normal text-[#464c5e]"
                      >
                        <RawContent value={tag} />
                      </Badge>
                    ))}
                  </div>
                )}
                <div className="mt-[8px] flex flex-wrap items-center justify-between gap-[8px]">
                  <span className="text-[12px] text-[#a7adbb]">
                    {boardSourceLabel(entry)}
                    {taskTitle ? (
                      <>
                        {' · '}
                        <span>
                          {t('teamDetailPage.value.relatedTask')}
                          <RawContent value={taskTitle} />
                        </span>
                      </>
                    ) : null}
                    {' · '}
                    {formatTeamDateTime(entry.updated_at, locale, t)}
                  </span>
                  <span className="flex items-center gap-[4px]">
                    <button
                      type="button"
                      disabled={promoted || promotingEntryId === entry.id}
                      onClick={() => void promoteBoardEntry(entry)}
                      className="rounded-[8px] px-[8px] py-[4px] text-[12px] text-[#464c5e] transition-colors hover:bg-[#f6f6f6] disabled:cursor-not-allowed disabled:text-[#a7adbb]"
                    >
                      {promoted
                        ? t('teamDetailPage.status.promoted')
                        : promotingEntryId === entry.id
                          ? t('teamDetailPage.status.promoting')
                          : t('teamDetailPage.blackboard.promote')}
                    </button>
                    <button
                      type="button"
                      onClick={() => void togglePinEntry(entry)}
                      className="rounded-[8px] px-[8px] py-[4px] text-[12px] text-[#464c5e] transition-colors hover:bg-[#f6f6f6]"
                    >
                      {entry.pinned ? t('teamDetailPage.blackboard.unpin') : t('teamDetailPage.blackboard.pinned')}
                    </button>
                    <button
                      type="button"
                      onClick={() => openEditEntry(entry)}
                      className="rounded-[8px] px-[8px] py-[4px] text-[12px] text-[#464c5e] transition-colors hover:bg-[#f6f6f6]"
                    >
                      {t('teamDetailPage.blackboard.edit')}
                    </button>
                    <button
                      type="button"
                      onClick={() => void archiveBoardEntry(entry)}
                      className="rounded-[8px] px-[8px] py-[4px] text-[12px] text-[#858b9c] transition-colors hover:bg-[#fce7e7] hover:text-[#f5483b]"
                    >
                      {t('teamDetailPage.blackboard.archive')}
                    </button>
                  </span>
                </div>
              </div>
            );
          })}
          {sortedBoardEntries.length === 0 && (
            <p className="py-[12px] text-center text-[12px] text-[#a7adbb]">{t('teamDetailPage.value.noBlackboardEntries')}</p>
          )}
        </div>
        <div className="mt-[12px] flex items-center gap-[8px]">
          <Input
            value={boardContent}
            onChange={(event) => setBoardContent(event.target.value)}
            placeholder={t('teamDetailPage.blackboard.contentPlaceholder')}
            aria-label={t('teamDetailPage.blackboard.contentPlaceholder')}
            disabled={postingEntry}
            className="h-[36px] flex-1 rounded-[10px] border-[#e3e7f1] text-[14px]"
          />
          <Input
            value={boardTags}
            onChange={(event) => setBoardTags(event.target.value)}
            placeholder={t('teamDetailPage.blackboard.tagsPlaceholder')}
            aria-label={t('teamDetailPage.blackboard.tagsAria')}
            disabled={postingEntry}
            className="h-[36px] w-[200px] shrink-0 rounded-[10px] border-[#e3e7f1] text-[14px]"
          />
          <Button
            type="button"
            disabled={postingEntry || !boardContent.trim()}
            onClick={() => void addBoardEntry()}
            className="h-[36px] shrink-0 rounded-[10px] bg-[#18181a] px-[16px] text-[14px] font-normal text-white hover:bg-[#303030]"
          >
            {postingEntry ? t('teamDetailPage.blackboard.adding') : t('teamDetailPage.blackboard.add')}
          </Button>
        </div>
      </section>

      <section aria-label={t('teamDetailPage.section.taskBoard')} className="mt-[20px] rounded-[20px] bg-white p-[20px] shadow-[0_0_6px_rgba(0,0,0,0.05)]">
        <div className="mb-[12px] flex items-center justify-between">
          <h2 className="text-[16px] font-medium text-[#18181a]">{t('teamDetailPage.section.taskBoard')}</h2>
          <Button
            type="button"
            onClick={() => setTaskDialogOpen(true)}
            className="h-[32px] rounded-[10px] bg-[#18181a] px-[16px] text-[13px] font-normal text-white hover:bg-[#303030]"
          >
            {t('teamDetailPage.task.create')}
          </Button>
        </div>
        <div className="grid grid-cols-1 gap-[12px] sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-7">
          {TASK_STATUS_COLUMNS.map((column) => {
            const columnTasks = tasksByStatus.get(column.status) || [];
            return (
              <div key={column.status} className="flex min-h-[120px] flex-col gap-[8px] rounded-[12px] bg-[#f8f9fb] p-[8px]">
                <div className="flex items-center justify-between px-[4px]">
                  <span className="text-[12px] font-medium text-[#464c5e]">
                    {teamTaskStatusLabel(column.status, t)}
                  </span>
                  <span className="text-[12px] text-[#a7adbb]">{columnTasks.length}</span>
                </div>
                {columnTasks.map((task) => (
                  <button
                    key={task.id}
                    type="button"
                    onClick={() => void openTask(task)}
                    className="flex flex-col gap-[6px] rounded-[10px] bg-white p-[10px] text-left shadow-[0_0_4px_rgba(0,0,0,0.04)] transition-shadow hover:shadow-[0_8px_16px_rgba(0,0,0,0.08)]"
                  >
                    <span className="text-[13px] font-medium leading-[18px] text-[#18181a]">
                      <RawContent value={task.title} />
                    </span>
                    <span className="flex items-center justify-between text-[11px] text-[#858b9c]">
                      <span className="truncate"><RawIdentifier value={assigneeName(task)} /></span>
                      <Badge variant="secondary" className="shrink-0 rounded-full bg-[#f2f3f7] text-[10px] font-normal text-[#464c5e]">
                        {taskPriorityLabel(task.priority, t)}
                      </Badge>
                    </span>
                    <span className="text-[10px] text-[#a7adbb]">
                      {t('teamDetailPage.value.createdAt', {
                        time: teamRelativeTimeLabel(task.created_at, locale, t),
                      })}
                    </span>
                  </button>
                ))}
                {columnTasks.length === 0 && (
                  <p className="py-[12px] text-center text-[11px] text-[#c3c8d4]">{t('teamDetailPage.value.noTasks')}</p>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section aria-label={t('teamDetailPage.section.activity')} className="mt-[20px] rounded-[20px] bg-white p-[20px] shadow-[0_0_6px_rgba(0,0,0,0.05)]">
        <h2 className="mb-[12px] text-[16px] font-medium text-[#18181a]">{t('teamDetailPage.section.activity')}</h2>
        {teamEvents.length === 0 ? (
          <p className="py-[12px] text-center text-[12px] text-[#a7adbb]">{t('teamDetailPage.value.noActivity')}</p>
        ) : (
          <div className="flex flex-col gap-[10px]">
            {eventGroups.map((group) => (
              <div
                key={group.key}
                className="rounded-[12px] border border-[#eef1f6] px-[12px] py-[10px]"
              >
                {group.task ? (
                  <button
                    type="button"
                    onClick={() => void openTask(group.task as TeamTaskRead)}
                    className="mb-[6px] max-w-full truncate rounded-[8px] text-left text-[13px] font-medium text-[#18181a] transition-colors hover:text-[#1a71ff]"
                    title={group.title}
                  >
                    <RawContent value={group.title} />
                  </button>
                ) : (
                  <p className="mb-[6px] text-[13px] font-medium text-[#464c5e]">
                    {group.key === '__other__' ? t('teamDetailPage.value.other') : t('teamDetailPage.value.unnamedTask')}
                  </p>
                )}
                <ol className="flex flex-col gap-[4px]">
                  {group.events.map((event) => (
                    <li
                      key={event.id}
                      className="flex items-baseline gap-[8px] px-[2px] text-[12px] leading-[18px]"
                    >
                      <span className="shrink-0 text-[#464c5e]">{teamEventLabel(event.event_type, event.payload, t)}</span>
                      <span className="shrink-0 text-[#a7adbb]">{eventActorLabel(event)}</span>
                      <span className="ml-auto shrink-0 text-[#a7adbb]">
                        {teamRelativeTimeLabel(event.created_at, locale, t)}
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </div>
        )}
      </section>

      <Dialog
        open={Boolean(activeTask)}
        onOpenChange={(open) => {
          if (!open) setActiveTask(null);
        }}
      >
        <DialogContent className="flex max-h-[calc(100dvh-32px)] w-[calc(100%-32px)] flex-col gap-0 overflow-hidden rounded-[16px] p-0 sm:max-w-[640px]">
          <DialogTitle className="shrink-0 px-[24px] py-[16px] text-[16px] font-semibold text-foreground">
            {activeTask ? <RawContent value={activeTask.title} /> : t('teamDetailPage.fallback.taskDetail')}
          </DialogTitle>
          {activeTask && (
            <div className="flex min-h-0 flex-1 flex-col gap-[16px] overflow-y-auto px-[24px] pb-[16px]">
              <div className="flex flex-wrap items-center gap-[8px] text-[12px] text-[#757f9c]">
                <Badge variant="secondary" className="rounded-full bg-[#f2f3f7] font-normal text-[#464c5e]">
                  {teamTaskStatusLabel(activeTask.status, t)}
                </Badge>
                <span>{t('teamDetailPage.value.assignee', { name: assigneeName(activeTask) })}</span>
                {biddingWinnerId && (
                  <Badge variant="secondary" className="rounded-full bg-[#e8f0ff] font-normal text-[#1a71ff]">
                    {t('teamDetailPage.status.awarded')}
                  </Badge>
                )}
                <span>{t('teamDetailPage.value.priority', { priority: taskPriorityLabel(activeTask.priority, t) })}</span>
                {activeTask.session_id && (
                  <span className="rounded-full bg-[#f2f3f7] px-[8px] py-[3px] text-[11px] text-[#646b7c]">
                    {t('teamDetailPage.value.sessionArchived')}
                  </span>
                )}
              </div>

              {activeTask.description && (
                <section aria-label={t('teamDetailPage.section.taskDescription')}>
                  <h3 className="mb-[4px] text-[13px] font-medium text-[#464c5e]">{t('teamDetailPage.section.taskDescription')}</h3>
                  <p className="text-[13px] leading-[20px] whitespace-pre-wrap text-[#18181a]"><RawContent value={activeTask.description} /></p>
                </section>
              )}

              {(reportSummary || reportFullReply) && (
                <section aria-label={t('teamDetailPage.section.executionReport')}>
                  <h3 className="mb-[4px] text-[13px] font-medium text-[#464c5e]">{t('teamDetailPage.section.executionReport')}</h3>
                  {reportSummary && (
                    <p className="text-[13px] leading-[20px] whitespace-pre-wrap text-[#18181a]"><RawContent value={reportSummary} /></p>
                  )}
                  {reportFullReply && (
                    <pre className="mt-[6px] max-h-[200px] overflow-y-auto rounded-[10px] bg-[#f8f9fb] p-[10px] text-[12px] leading-[18px] whitespace-pre-wrap text-[#464c5e]">
                      <RawContent value={reportFullReply} />
                    </pre>
                  )}
                </section>
              )}

              {reviewVerdict && (() => {
                const banner = REVIEW_BANNERS[reviewVerdict] || DEFAULT_REVIEW_BANNER;
                return (
                  <section aria-label={t('teamDetailPage.section.reviewConclusion')}>
                    <div className={cn('rounded-[12px] border px-[14px] py-[12px]', banner.bannerClass)}>
                      <p className="text-[15px] font-semibold">{reviewVerdictLabel(reviewVerdict, t)}</p>
                      {reviewComment && (
                        <blockquote
                          className={cn(
                            'mt-[8px] border-l-4 pl-[10px] text-[14px] leading-[22px] whitespace-pre-wrap',
                            banner.quoteClass,
                          )}
                        >
                          <RawContent value={reviewComment} />
                        </blockquote>
                      )}
                    </div>
                  </section>
                );
              })()}

              {bidRounds.length > 0 && (
                <section aria-label={t('teamDetailPage.section.biddingArena')}>
                  <h3 className="mb-[4px] text-[13px] font-medium text-[#464c5e]">{t('teamDetailPage.section.biddingArena')}</h3>
                  <BiddingArena
                    bids={activeTask.bids || []}
                    winnerId={biddingWinnerId}
                    agents={agents}
                    resolveName={(agentId) => memberNameByAgentId.get(agentId) || ''}
                  />
                </section>
              )}

              {AWARD_OVERRIDABLE_STATUSES.has(activeTask.status) && (
                <section aria-label={t('teamDetailPage.section.awardOverride')} className="rounded-[12px] border border-[#eef1f6] p-[12px]">
                  <h3 className="mb-[8px] text-[13px] font-medium text-[#464c5e]">{t('teamDetailPage.section.awardOverride')}</h3>
                  <div className="flex flex-col gap-[8px]">
                    <Select value={awardAgentId} onValueChange={setAwardAgentId}>
                      <SelectTrigger
                        aria-label={t('teamDetailPage.task.selectExecutor')}
                        className="h-[36px] rounded-[10px] border-[#e3e7f1] text-[13px]"
                      >
                        <SelectValue placeholder={t('teamDetailPage.task.selectExecutor')} />
                      </SelectTrigger>
                      <SelectContent>
                        {awardCandidates.map((member) => (
                          <SelectItem key={member.agent_id} value={member.agent_id}>
                            {member.agent_name || member.agent_id}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Textarea
                      value={awardComment}
                      onChange={(event) => setAwardComment(event.target.value)}
                      placeholder={t('teamDetailPage.task.overrideComment')}
                      aria-label={t('teamDetailPage.task.overrideComment')}
                      rows={2}
                      className="text-[13px]"
                    />
                    <div>
                      <Button
                        type="button"
                        disabled={awarding || !awardAgentId}
                        onClick={() => void awardOverride()}
                        className="h-[32px] rounded-[10px] bg-[#18181a] px-[16px] text-[13px] font-normal text-white hover:bg-[#303030]"
                      >
                        {awarding ? t('teamDetailPage.task.submitting') : t('teamDetailPage.task.confirmOverride')}
                      </Button>
                    </div>
                  </div>
                </section>
              )}

              <section aria-label={t('teamDetailPage.section.eventTimeline')}>
                <h3 className="mb-[4px] text-[13px] font-medium text-[#464c5e]">{t('teamDetailPage.section.eventTimeline')}</h3>
                {(activeTask.events || []).length === 0 ? (
                  <p className="text-[12px] text-[#a7adbb]">{t('teamDetailPage.value.noEvents')}</p>
                ) : (
                  <ol className="flex flex-col gap-[6px]">
                    {(activeTask.events || []).map((event) => (
                      <li key={event.id} className="flex items-baseline gap-[8px] text-[12px] leading-[18px]">
                        <span className="shrink-0 text-[#a7adbb]">
                          {formatTeamDateTime(event.created_at, locale, t)}
                        </span>
                        <span className="text-[#464c5e]">{teamEventLabel(event.event_type, event.payload, t)}</span>
                        <span className="text-[#a7adbb]">{event.actor_type}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </section>

              {OVERRIDABLE_STATUSES.has(activeTask.status) && (
                <section aria-label={t('teamDetailPage.section.manualReview')} className="rounded-[12px] border border-[#eef1f6] p-[12px]">
                  <h3 className="mb-[8px] text-[13px] font-medium text-[#464c5e]">{t('teamDetailPage.section.manualReview')}</h3>
                  <Textarea
                    value={overrideComment}
                    onChange={(event) => setOverrideComment(event.target.value)}
                    placeholder={t('teamDetailPage.review.overrideComment')}
                    aria-label={t('teamDetailPage.review.overrideComment')}
                    rows={2}
                    className="mb-[8px] text-[13px]"
                  />
                  <div className="flex items-center gap-[8px]">
                    <Button
                      type="button"
                      disabled={overriding}
                      onClick={() => void overrideTask('approve')}
                      className="h-[32px] rounded-[10px] bg-[#18181a] px-[16px] text-[13px] font-normal text-white hover:bg-[#303030]"
                    >
                      {t('teamDetailPage.review.approveButton')}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={overriding}
                      onClick={() => void overrideTask('rework')}
                      className="h-[32px] rounded-[10px] border-[#e3e7f1] px-[16px] text-[13px] font-normal text-[#464c5e]"
                    >
                      {t('teamDetailPage.review.reworkButton')}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={overriding}
                      onClick={() => void overrideTask('escalate')}
                      className="h-[32px] rounded-[10px] border-[#e3e7f1] px-[16px] text-[13px] font-normal text-[#464c5e]"
                    >
                      {t('teamDetailPage.review.escalateButton')}
                    </Button>
                  </div>
                </section>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <TeamLogDialog
        open={teamLogOpen}
        loading={loadingTeamLog}
        log={teamLog}
        onClose={() => setTeamLogOpen(false)}
        onDownload={downloadTeamLog}
      />

      <Dialog
        open={taskDialogOpen}
        onOpenChange={(open) => {
          if (!open) setTaskDialogOpen(false);
        }}
      >
        <DialogContent className="w-[calc(100%-32px)] rounded-[16px] sm:max-w-[480px]">
          <DialogTitle className="text-[16px] font-semibold text-foreground">{t('teamDetailPage.task.createTitle')}</DialogTitle>
          <div className="flex flex-col gap-[12px]">
            <Input
              value={newTaskTitle}
              onChange={(event) => setNewTaskTitle(event.target.value)}
              placeholder={t('teamDetailPage.task.titlePlaceholder')}
              aria-label={t('teamDetailPage.task.titlePlaceholder')}
              className="h-[36px] rounded-[10px] border-[#e3e7f1] text-[14px]"
            />
            <Textarea
              value={newTaskDescription}
              onChange={(event) => setNewTaskDescription(event.target.value)}
              placeholder={t('teamDetailPage.task.descriptionPlaceholder')}
              aria-label={t('teamDetailPage.task.descriptionPlaceholder')}
              rows={3}
              className="text-[14px]"
            />
            <Select value={newTaskPriority} onValueChange={setNewTaskPriority}>
              <SelectTrigger aria-label={t('teamDetailPage.task.priority')} className="h-[36px] rounded-[10px] border-[#e3e7f1] text-[14px]">
                <SelectValue placeholder={t('teamDetailPage.task.priority')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="high">{t('teamDetailPage.priority.high')}</SelectItem>
                <SelectItem value="medium">{t('teamDetailPage.priority.medium')}</SelectItem>
                <SelectItem value="low">{t('teamDetailPage.priority.low')}</SelectItem>
              </SelectContent>
            </Select>
            <Select value={newTaskAssignee} onValueChange={setNewTaskAssignee}>
              <SelectTrigger aria-label={t('teamDetailPage.task.assignee')} className="h-[36px] rounded-[10px] border-[#e3e7f1] text-[14px]">
                <SelectValue placeholder={t('teamDetailPage.task.assignee')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={POOL_ASSIGNEE_VALUE}>{t('teamDetailPage.task.pool')}</SelectItem>
                {(team?.members || []).map((member) => (
                  <SelectItem key={member.agent_id} value={member.agent_id}>
                    {member.agent_name || member.agent_id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex items-center justify-end gap-[8px]">
              <Button
                type="button"
                variant="outline"
                disabled={creatingTask}
                onClick={() => setTaskDialogOpen(false)}
                className="h-[32px] rounded-[10px] border-[#e3e7f1] px-[16px] text-[13px] font-normal text-[#464c5e]"
              >
                {t('teamDetailPage.task.cancel')}
              </Button>
              <Button
                type="button"
                disabled={creatingTask || !newTaskTitle.trim()}
                onClick={() => void createTask()}
                className="h-[32px] rounded-[10px] bg-[#18181a] px-[16px] text-[13px] font-normal text-white hover:bg-[#303030]"
              >
                {creatingTask ? t('teamDetailPage.task.creating') : t('teamDetailPage.task.createSubmit')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(editingEntry)}
        onOpenChange={(open) => {
          if (!open) setEditingEntry(null);
        }}
      >
        <DialogContent className="w-[calc(100%-32px)] rounded-[16px] sm:max-w-[480px]">
          <DialogTitle className="text-[16px] font-semibold text-foreground">{t('teamDetailPage.dialog.editBlackboard')}</DialogTitle>
          <div className="flex flex-col gap-[12px]">
            <Textarea
              value={editContent}
              onChange={(event) => setEditContent(event.target.value)}
              placeholder={t('teamDetailPage.dialog.editContent')}
              aria-label={t('teamDetailPage.dialog.editContent')}
              rows={3}
              className="text-[14px]"
            />
            <Input
              value={editTags}
              onChange={(event) => setEditTags(event.target.value)}
              placeholder={t('teamDetailPage.blackboard.tagsPlaceholder')}
              aria-label={t('teamDetailPage.dialog.editTags')}
              className="h-[36px] rounded-[10px] border-[#e3e7f1] text-[14px]"
            />
            <div className="flex items-center justify-end gap-[8px]">
              <Button
                type="button"
                variant="outline"
                disabled={savingEntry}
                onClick={() => setEditingEntry(null)}
                className="h-[32px] rounded-[10px] border-[#e3e7f1] px-[16px] text-[13px] font-normal text-[#464c5e]"
              >
                {t('teamDetailPage.dialog.cancel')}
              </Button>
              <Button
                type="button"
                disabled={savingEntry || !editContent.trim()}
                onClick={() => void saveEditEntry()}
                className="h-[32px] rounded-[10px] bg-[#18181a] px-[16px] text-[13px] font-normal text-white hover:bg-[#303030]"
              >
                {savingEntry ? t('teamDetailPage.dialog.saving') : t('teamDetailPage.dialog.save')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** 展示团队导出日志；产品 chrome 本地化，消息、事件和原始 JSON 作为诊断/业务原文保留。 */
function TeamLogDialog({
  open,
  loading,
  log,
  onClose,
  onDownload,
}: {
  open: boolean;
  loading: boolean;
  log: TeamLogPayload | null;
  onClose: () => void;
  onDownload: () => void;
}) {
  const { locale, t: appT } = useAppIntl();
  const t = useMemo(() => createTeamDetailTranslator({ t: appT }), [appT]);
  const sessions = log?.sessions || [];
  const summary = log?.summary || {};
  const teamName = String(log?.team?.name || '');
  const [expandedSessionIds, setExpandedSessionIds] = useState<Set<string>>(() => new Set());

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent
        aria-describedby={undefined}
        className="flex max-h-[calc(100dvh-3rem)] w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden rounded-[14px] p-0 sm:max-w-[1180px]"
      >
        <div className="flex shrink-0 items-center justify-between gap-[16px] border-b border-[#edf0f5] px-[24px] py-[18px] pr-[54px]">
          <div className="flex min-w-0 items-center gap-[10px]">
            <span className="flex size-[32px] shrink-0 items-center justify-center rounded-[10px] bg-[#eef4ff] text-[#1a71ff]">
              <FileJson className="size-[16px]" />
            </span>
            <div className="min-w-0">
              <DialogTitle className="truncate text-[15px] font-semibold text-[#18181a]">
                {t('teamDetailPage.section.teamLog')}
              </DialogTitle>
              <p className="mt-[2px] truncate text-[11px] text-[#858b9c]">
                {teamName ? <RawIdentifier value={teamName} /> : t('teamDetailPage.value.team')}
                {' · '}
                {t('teamDetailPage.dialog.logDescription')}
              </p>
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={!log || loading}
            onClick={onDownload}
            className="h-[32px] shrink-0 gap-[6px] rounded-[9px] border-[#e3e7f1] px-[12px] text-[12px] font-normal text-[#464c5e]"
          >
            <Download className="size-[13px]" />
            {t('teamDetailPage.dialog.downloadJson')}
          </Button>
        </div>

        {loading ? (
          <div className="flex min-h-[360px] flex-1 items-center justify-center gap-[8px] text-[13px] text-[#858b9c]">
            <LoaderCircle className="size-[18px] animate-spin text-[#1a71ff]" />
            {t('teamDetailPage.dialog.loadingLog')}
          </div>
        ) : log ? (
          <div className="min-h-0 flex-1 overflow-y-auto bg-[#fafbfc] px-[24px] py-[20px]">
            <div className="grid grid-cols-2 gap-[10px] sm:grid-cols-4">
              {[
                [t('teamDetailPage.dialog.summaryTasks'), summary.task_count ?? log.tasks?.length ?? 0],
                [t('teamDetailPage.dialog.summaryWakeEvents'), summary.wake_event_count ?? log.wake_events?.length ?? 0],
                [t('teamDetailPage.dialog.summaryBlackboard'), summary.blackboard_entry_count ?? log.blackboard_entries?.length ?? 0],
                [t('teamDetailPage.dialog.summarySessions'), summary.session_count ?? sessions.length],
              ].map(([label, value]) => (
                <div key={String(label)} className="rounded-[12px] border border-[#e7eaf0] bg-white px-[14px] py-[12px]">
                  <p className="text-[11px] text-[#858b9c]">{label}</p>
                  <p className="mt-[3px] text-[20px] font-semibold tracking-[-0.02em] text-[#18181a]">{value}</p>
                </div>
              ))}
            </div>

            <section className="mt-[16px] rounded-[14px] border border-[#e3e7f1] bg-white p-[14px]">
              <div className="mb-[10px] flex items-center justify-between gap-[8px]">
                <div>
                  <h3 className="text-[13px] font-semibold text-[#18181a]">{t('teamDetailPage.section.memberSessions')}</h3>
                  <p className="mt-[2px] text-[11px] text-[#858b9c]">{t('teamDetailPage.dialog.memberSessionsDescription')}</p>
                </div>
                <span className="rounded-full bg-[#eef4ff] px-[9px] py-[3px] text-[11px] text-[#1a71ff]">
                  {sessions.length}
                </span>
              </div>

              {sessions.length > 0 ? (
                <div className="grid gap-[8px]">
                  {sessions.map((sessionLog, index) => {
                    const session = sessionLog.session || {};
                    const messages = sessionLog.messages || [];
                    const events = sessionLog.events || [];
                    const invocations = sessionLog.tool_invocations || [];
                    const sessionId = String(session.id || session.session_id || index);
                    return (
                      <details
                        key={sessionId}
                        className="group rounded-[10px] border border-[#e7eaf0] bg-[#fcfcfd] open:bg-white"
                        onToggle={(event) => {
                          const expanded = event.currentTarget.open;
                          setExpandedSessionIds((current) => {
                            const next = new Set(current);
                            if (expanded) next.add(sessionId);
                            else next.delete(sessionId);
                            return next;
                          });
                        }}
                      >
                        <summary className="cursor-pointer list-none px-[13px] py-[11px] marker:hidden">
                          <div className="flex items-center justify-between gap-[12px]">
                            <div className="min-w-0">
                              <p className="truncate text-[12px] font-medium text-[#303442]">
                                <RawIdentifier value={String(session.title || sessionId)} />
                              </p>
                              <p className="mt-[2px] truncate text-[11px] text-[#858b9c]">
                                {session.agent_name || session.agent_id ? (
                                  <RawIdentifier value={String(session.agent_name || session.agent_id)} />
                                ) : t('teamDetailPage.dialog.employeeFallback')}
                                {session.status ? (
                                  <>
                                    {' · '}
                                    <RawIdentifier value={String(session.status)} />
                                  </>
                                ) : null}
                              </p>
                            </div>
                            <div className="flex shrink-0 flex-wrap justify-end gap-[5px] text-[10px] text-[#697086]">
                              <span className="rounded-full bg-[#f1f3f7] px-[7px] py-[3px]">
                                {t('teamDetailPage.value.messageCount', { count: messages.length })}
                              </span>
                              <span className="rounded-full bg-[#f1f3f7] px-[7px] py-[3px]">
                                {t('teamDetailPage.value.eventCount', { count: events.length })}
                              </span>
                              <span className="rounded-full bg-[#f1f3f7] px-[7px] py-[3px]">
                                {t('teamDetailPage.value.toolCount', { count: invocations.length })}
                              </span>
                            </div>
                          </div>
                        </summary>

                        {expandedSessionIds.has(sessionId) && (
                        <div className="border-t border-[#edf0f5] px-[13px] py-[12px]">
                          <div className="grid gap-[8px]">
                            {messages.map((message, messageIndex) => {
                              const role = String(message.role || 'assistant');
                              const content = String(message.content || '');
                              return (
                                <div
                                  key={message.id || `${sessionId}-message-${messageIndex}`}
                                  className={cn('flex', role === 'user' ? 'justify-end' : 'justify-start')}
                                >
                                  <div
                                    className={cn(
                                      'max-w-[88%] rounded-[10px] px-[12px] py-[9px] text-[12px] leading-[1.65]',
                                      role === 'user'
                                        ? 'bg-[#eef4ff] text-[#24456f]'
                                        : 'border border-[#e7eaf0] bg-white text-[#303442]',
                                    )}
                                  >
                                    <div className="mb-[4px] text-[10px] font-medium text-[#858b9c]">
                                      {role === 'user'
                                        ? t('teamDetailPage.role.user')
                                        : role === 'assistant'
                                          ? t('teamDetailPage.role.assistant')
                                          : <RawIdentifier value={role} />}
                                    </div>
                                    {role === 'assistant'
                                      ? <MarkdownMessage content={content} />
                                      : <p className="whitespace-pre-wrap"><RawContent value={content} /></p>}
                                  </div>
                                </div>
                              );
                            })}
                            {messages.length === 0 && (
                              <p className="py-[12px] text-center text-[11px] text-[#a7adbb]">{t('teamDetailPage.value.noMessages')}</p>
                            )}
                          </div>

                          {(events.length > 0 || invocations.length > 0) && (
                            <details className="mt-[10px] rounded-[9px] border border-[#e7eaf0] bg-[#fafbfc] px-[11px] py-[8px]">
                              <summary className="cursor-pointer text-[11px] font-medium text-[#60677a]">{t('teamDetailPage.section.rawEvents')}</summary>
                              <pre className="mt-[8px] max-h-[420px] overflow-auto rounded-[8px] bg-[#18181a] p-[11px] text-[10px] leading-[1.55] text-[#d8e2f0]">
                                {JSON.stringify({
                                  traces: sessionLog.traces || [],
                                  events,
                                  tool_invocations: invocations,
                                }, null, 2)}
                              </pre>
                            </details>
                          )}
                        </div>
                        )}
                      </details>
                    );
                  })}
                </div>
              ) : (
                <p className="py-[24px] text-center text-[12px] text-[#a7adbb]">{t('teamDetailPage.value.noSessions')}</p>
              )}
            </section>

            <details className="mt-[12px] rounded-[12px] border border-[#e3e7f1] bg-white px-[14px] py-[11px]">
              <summary className="cursor-pointer text-[12px] font-medium text-[#464c5e]">{t('teamDetailPage.section.rawJson')}</summary>
              <pre className="mt-[10px] max-h-[560px] overflow-auto rounded-[8px] bg-[#18181a] p-[12px] text-[10px] leading-[1.55] text-[#d8e2f0]">
                {JSON.stringify(log, null, 2)}
              </pre>
            </details>

            <p className="mt-[10px] text-right text-[10px] text-[#a7adbb]">
              {t('teamDetailPage.value.exportedAt', {
                time: formatTeamDateTime(log.exported_at, locale, t),
              })}
            </p>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
