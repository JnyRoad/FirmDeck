import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Clock,
  Download,
  FileSearch,
  GitBranch,
  LoaderCircle,
  RefreshCw,
  Workflow,
  Wrench,
} from 'lucide-react';

import { DataTable, type DataTableColumn } from '@/components/DataTable';
import { DetailField } from '@/components/DetailField';
import { Paginator } from '@/components/Paginator';
import { StatCard } from '@/components/StatCard';
import { Button as UIButton } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  Checkbox,
  Select as UISelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  UnderlineTabs,
  type UnderlineTabItem,
} from '@/components/ui';
import { notify } from '@/components/ui/app-toast';
import { RawContent, RawIdentifier } from '@/i18n/RawContent';
import type { MessageValues } from '@/i18n/imperative';
import type { MessageId } from '@/i18n/types';
import { useAppIntl } from '@/i18n/useAppIntl';
import { apiErrorMessage } from '@/lib/apiErrorMessages';
import { backendEventMessage } from '@/lib/backendEventMessages';
import { cn } from '@/lib/utils';
import { SELECT_TRIGGER_CLASS, formatDateTime } from '@/lib/enterprise-ui';
import { isTeamScope, readEmployeeScope } from '@/lib/agent-scope-storage';
import { MarkdownMessage } from '../chat/chatHelpers';

import { api, TENANT_ID } from '../../api/client';
import IconCalendar from '../../assets/icons/profile-calendar.svg?react';
import { employeeDisplayNameWithCreator } from '../../employee';
import { useClientPagination } from '../../hooks/useClientPagination';
import { StatusBadge } from '../scheduled-tasks/StatusBadge';
import type { BadgeTone } from '../scheduled-tasks/shared';
import type {
  AgentProfileRead,
  EnterpriseChatSessionRead,
  EnterpriseSessionDetailRead,
  FeedbackAnalysisRead,
  FeedbackMessageRead,
  FeedbackSessionRead,
  FeedbackSummaryRead,
  TraceLineRead,
  TurnTraceRead,
} from '../../types';
import {
  buildConversationUserOptions,
  matchesConversationLogFilter,
  type ConversationLogFilter,
  type ConversationLogRow,
} from './conversationLogFilters';
import { employeeDashboardMetrics } from './employeeDashboardMetrics';

const FEEDBACK_PAGE_SIZE = 10;
const ALL_CONVERSATION_USERS = '__all_conversation_users__';

type ConversationDetail = {
  session: Record<string, unknown>;
  messages: FeedbackMessageRead[];
  feedback: Array<Record<string, unknown>>;
  events: EnterpriseSessionDetailRead['events'];
  traces: TurnTraceRead[];
  toolInvocations: NonNullable<EnterpriseSessionDetailRead['tool_invocations']>;
};

const FILTER_TAB_DEFINITIONS = [
  { labelId: 'dashboard.conversationLogs.filter.all', value: 'all' },
  { labelId: 'dashboard.conversationLogs.filter.up', value: 'up' },
  { labelId: 'dashboard.conversationLogs.filter.down', value: 'down' },
  { labelId: 'dashboard.conversationLogs.filter.unrated', value: 'unrated' },
  { labelId: 'dashboard.conversationLogs.filter.ability', value: 'ability' },
  { labelId: 'dashboard.conversationLogs.filter.tool', value: 'tool' },
  { labelId: 'dashboard.conversationLogs.filter.knowledge', value: 'knowledge' },
  { labelId: 'dashboard.conversationLogs.filter.sop', value: 'sop' },
] as const satisfies ReadonlyArray<{ labelId: MessageId; value: ConversationLogFilter }>;

type FeedbackBucketId =
  | 'model_issue'
  | 'skill_issue'
  | 'skill_instruction_issue'
  | 'sop_trigger_issue'
  | 'sop_slot_issue'
  | 'sop_transition_issue'
  | 'sop_capability_issue'
  | 'knowledge_gap'
  | 'tool_or_system_issue'
  | 'tool_or_runtime_issue'
  | 'user_random_or_unclear'
  | 'positive_or_resolved'
  | 'needs_model_analysis'
  | 'unknown';

const FEEDBACK_BUCKET_IDS = {
  model_issue: 'dashboard.conversationLogs.bucket.modelIssue',
  skill_issue: 'dashboard.conversationLogs.bucket.skillIssue',
  skill_instruction_issue: 'dashboard.conversationLogs.bucket.skillInstructionIssue',
  sop_trigger_issue: 'dashboard.conversationLogs.bucket.sopTriggerIssue',
  sop_slot_issue: 'dashboard.conversationLogs.bucket.sopSlotIssue',
  sop_transition_issue: 'dashboard.conversationLogs.bucket.sopTransitionIssue',
  sop_capability_issue: 'dashboard.conversationLogs.bucket.sopCapabilityIssue',
  knowledge_gap: 'dashboard.conversationLogs.bucket.knowledgeGap',
  tool_or_system_issue: 'dashboard.conversationLogs.bucket.toolOrSystemIssue',
  tool_or_runtime_issue: 'dashboard.conversationLogs.bucket.toolOrRuntimeIssue',
  user_random_or_unclear: 'dashboard.conversationLogs.bucket.userRandomOrUnclear',
  positive_or_resolved: 'dashboard.conversationLogs.bucket.positiveOrResolved',
  needs_model_analysis: 'dashboard.conversationLogs.bucket.needsModelAnalysis',
  unknown: 'dashboard.conversationLogs.bucket.unknown',
} as const satisfies Record<FeedbackBucketId, string>;

type AnalysisStatusId = 'pending' | 'analyzed' | 'failed' | 'needs_model' | 'unknown';

const ANALYSIS_STATUS_IDS = {
  pending: 'dashboard.conversationLogs.analysis.pending',
  analyzed: 'dashboard.conversationLogs.analysis.completed',
  failed: 'dashboard.conversationLogs.analysis.failed',
  needs_model: 'dashboard.conversationLogs.analysis.needsModel',
  unknown: 'dashboard.conversationLogs.analysis.unknown',
} as const satisfies Record<AnalysisStatusId, string>;

const FAILED_ATTEMPTS_MESSAGE_ID = 'dashboard.conversationLogs.analysis.failedAttempts';
const SUMMARY_COUNT_MESSAGE_ID = 'dashboard.conversationLogs.summary.count';

export type FeedbackMessageValues = Record<string, number>;

export type FeedbackMessageId =
  | (typeof FEEDBACK_BUCKET_IDS)[FeedbackBucketId]
  | (typeof ANALYSIS_STATUS_IDS)[AnalysisStatusId]
  | typeof FAILED_ATTEMPTS_MESSAGE_ID
  | typeof SUMMARY_COUNT_MESSAGE_ID;

export type FeedbackMessageDescriptor = {
  id: FeedbackMessageId;
  values?: FeedbackMessageValues;
};

export type FeedbackTranslate = (id: FeedbackMessageId, values?: FeedbackMessageValues) => string;

const MOBILE_CARD_CLASS =
  'min-w-0 rounded-[8px] border border-[#eceef1] bg-white p-[14px]';

/** 将未知异常折叠为安全语义消息；普通 Error.message 不进入最终 UI。 */
function conversationLogErrorMessage(
  error: unknown,
  fallbackId: MessageId,
  translate: (id: MessageId, values?: MessageValues) => string,
): string {
  const generic = translate('common.error.generic');
  const message = apiErrorMessage(error, fallbackId, { t: translate });
  return message === generic ? translate(fallbackId) : message;
}

/** Narrow unknown backend values to a record before reading typed projection fields. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Accept only finite positive integer parameters that are safe for ICU number formatting. */
function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Return whether a backend bucket is one of the registered stable identifiers. */
function isFeedbackBucketId(value: unknown): value is FeedbackBucketId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(FEEDBACK_BUCKET_IDS, value);
}

/** Project a backend bucket identifier to a semantic message descriptor; malformed values fail closed. */
export function feedbackBucketDescriptor(bucket: unknown): FeedbackMessageDescriptor {
  return { id: isFeedbackBucketId(bucket) ? FEEDBACK_BUCKET_IDS[bucket] : FEEDBACK_BUCKET_IDS.unknown };
}

/** Render a stable bucket descriptor through the active UI locale without exposing backend labels. */
export function feedbackBucketLabel(bucket: unknown, translate: FeedbackTranslate): string {
  const descriptor = feedbackBucketDescriptor(bucket);
  return translate(descriptor.id, descriptor.values);
}

/** Return whether a backend analysis status is one of the registered stable identifiers. */
function isAnalysisStatusId(value: unknown): value is AnalysisStatusId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ANALYSIS_STATUS_IDS, value);
}

/** Project a stable analysis status and its bounded params to a semantic message descriptor. */
export function feedbackAnalysisStatusDescriptor(
  status: unknown,
  params: unknown,
): FeedbackMessageDescriptor {
  const normalizedStatus: AnalysisStatusId = isAnalysisStatusId(status) ? status : 'unknown';
  if (normalizedStatus === 'failed' && isRecord(params)) {
    const attempts = positiveInteger(params.attempts);
    if (attempts !== null) return { id: FAILED_ATTEMPTS_MESSAGE_ID, values: { attempts } };
  }
  return { id: ANALYSIS_STATUS_IDS[normalizedStatus] };
}

/** Render a stable analysis status through the active UI locale and ignore malformed status params. */
export function analysisStatusLabel(
  status: unknown,
  params: unknown,
  translate: FeedbackTranslate,
): string {
  const descriptor = feedbackAnalysisStatusDescriptor(status, params);
  return translate(descriptor.id, descriptor.values);
}

/** Project the backend aggregate descriptor while keeping model-authored detail outside i18n. */
export function feedbackSummaryDescriptor(value: unknown): {
  bucket: FeedbackMessageDescriptor;
  count: FeedbackMessageDescriptor;
  detail: string | null;
} | null {
  if (!isRecord(value) || !isRecord(value.params)) return null;
  const count = positiveInteger(value.params.count);
  if (count === null) return null;
  if (value.detail !== undefined && value.detail !== null && typeof value.detail !== 'string') return null;
  return {
    bucket: feedbackBucketDescriptor(value.bucket),
    count: { id: SUMMARY_COUNT_MESSAGE_ID, values: { count } },
    detail: typeof value.detail === 'string' ? value.detail : null,
  };
}

/** Project one aggregate bucket count using canonical params, with a numeric legacy reader fallback. */
export function feedbackBucketCountDescriptor(value: unknown): {
  bucket: FeedbackMessageDescriptor;
  count: FeedbackMessageDescriptor;
} | null {
  if (!isRecord(value)) return null;
  const params = isRecord(value.params) ? value.params : null;
  const count = positiveInteger(params?.count ?? value.count);
  if (count === null) return null;
  return {
    bucket: feedbackBucketDescriptor(value.bucket),
    count: { id: SUMMARY_COUNT_MESSAGE_ID, values: { count } },
  };
}

/** Read only the status params field from the versioned analysis payload. */
function feedbackStatusParams(value: FeedbackAnalysisRead | undefined): unknown {
  return value ? Reflect.get(value, 'status_params') : undefined;
}

/** Serialize one model-owned evidence value without translating or silently stringifying failures. */
function rawFeedbackContent(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return null;
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' ? serialized : null;
  } catch {
    return null;
  }
}

/** Read the versioned evidence list and retain only values that can cross a RawContent boundary. */
export function feedbackEvidenceContent(value: unknown): string[] {
  const evidence = value ? Reflect.get(value, 'evidence') : undefined;
  if (!Array.isArray(evidence)) return [];
  return evidence
    .map(rawFeedbackContent)
    .filter((item): item is string => item !== null && item.length > 0);
}

/** 按当前界面语言格式化百分比指标，避免把数值和单位手工拼接进 UI。 */
function formatMetricPercent(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    maximumFractionDigits: 0,
  }).format(value / 100);
}

export default function ConversationLogsTab() {
  const { locale, t } = useAppIntl();
  const feedbackTranslate: FeedbackTranslate = (id, values) => {
    switch (id) {
      case 'dashboard.conversationLogs.bucket.modelIssue':
        return t('dashboard.conversationLogs.bucket.modelIssue', values);
      case 'dashboard.conversationLogs.bucket.skillIssue':
        return t('dashboard.conversationLogs.bucket.skillIssue', values);
      case 'dashboard.conversationLogs.bucket.skillInstructionIssue':
        return t('dashboard.conversationLogs.bucket.skillInstructionIssue', values);
      case 'dashboard.conversationLogs.bucket.sopTriggerIssue':
        return t('dashboard.conversationLogs.bucket.sopTriggerIssue', values);
      case 'dashboard.conversationLogs.bucket.sopSlotIssue':
        return t('dashboard.conversationLogs.bucket.sopSlotIssue', values);
      case 'dashboard.conversationLogs.bucket.sopTransitionIssue':
        return t('dashboard.conversationLogs.bucket.sopTransitionIssue', values);
      case 'dashboard.conversationLogs.bucket.sopCapabilityIssue':
        return t('dashboard.conversationLogs.bucket.sopCapabilityIssue', values);
      case 'dashboard.conversationLogs.bucket.knowledgeGap':
        return t('dashboard.conversationLogs.bucket.knowledgeGap', values);
      case 'dashboard.conversationLogs.bucket.toolOrSystemIssue':
        return t('dashboard.conversationLogs.bucket.toolOrSystemIssue', values);
      case 'dashboard.conversationLogs.bucket.toolOrRuntimeIssue':
        return t('dashboard.conversationLogs.bucket.toolOrRuntimeIssue', values);
      case 'dashboard.conversationLogs.bucket.userRandomOrUnclear':
        return t('dashboard.conversationLogs.bucket.userRandomOrUnclear', values);
      case 'dashboard.conversationLogs.bucket.positiveOrResolved':
        return t('dashboard.conversationLogs.bucket.positiveOrResolved', values);
      case 'dashboard.conversationLogs.bucket.needsModelAnalysis':
        return t('dashboard.conversationLogs.bucket.needsModelAnalysis', values);
      case 'dashboard.conversationLogs.bucket.unknown':
        return t('dashboard.conversationLogs.bucket.unknown', values);
      case 'dashboard.conversationLogs.analysis.pending':
        return t('dashboard.conversationLogs.analysis.pending', values);
      case 'dashboard.conversationLogs.analysis.completed':
        return t('dashboard.conversationLogs.analysis.completed', values);
      case 'dashboard.conversationLogs.analysis.failed':
        return t('dashboard.conversationLogs.analysis.failed', values);
      case 'dashboard.conversationLogs.analysis.failedAttempts':
        return t('dashboard.conversationLogs.analysis.failedAttempts', values);
      case 'dashboard.conversationLogs.analysis.needsModel':
        return t('dashboard.conversationLogs.analysis.needsModel', values);
      case 'dashboard.conversationLogs.analysis.unknown':
        return t('dashboard.conversationLogs.analysis.unknown', values);
      case 'dashboard.conversationLogs.summary.count':
        return t('dashboard.conversationLogs.summary.count', values);
      default:
        return t('dashboard.conversationLogs.analysis.unknown');
    }
  };
  const [searchParams] = useSearchParams();
  const [scopedAgentId, setScopedAgentId] = useState(readEmployeeScope);
  const agentId = searchParams.get('agent_id') || scopedAgentId;
  const [sessions, setSessions] = useState<EnterpriseChatSessionRead[]>([]);
  const [downRows, setDownRows] = useState<FeedbackSessionRead[]>([]);
  const [upRows, setUpRows] = useState<FeedbackSessionRead[]>([]);
  const [agents, setAgents] = useState<AgentProfileRead[]>([]);
  const [summary, setSummary] = useState<FeedbackSummaryRead | null>(null);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [filter, setFilter] = useState<ConversationLogFilter>('all');
  const [conversationUserId, setConversationUserId] = useState(ALL_CONVERSATION_USERS);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [reanalyzingId, setReanalyzingId] = useState<string | null>(null);
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(() => new Set());
  const [exportingKey, setExportingKey] = useState('');
  const filterTabs = useMemo<UnderlineTabItem<ConversationLogFilter>[]>(
    () => FILTER_TAB_DEFINITIONS.map((item) => ({ value: item.value, label: t(item.labelId) })),
    [t],
  );

  useEffect(() => {
    const onScopeChange = (event: Event) => {
      const next = (event as CustomEvent<{ agentId?: string }>).detail?.agentId || '';
      setScopedAgentId(next && !isTeamScope(next) ? next : readEmployeeScope());
    };
    window.addEventListener('ultrarag-enterprise-agent-scope-change', onScopeChange);
    return () => window.removeEventListener('ultrarag-enterprise-agent-scope-change', onScopeChange);
  }, []);

  const load = async () => {
    setLoading(true);
    const agentQuery = agentId ? `&agent_id=${encodeURIComponent(agentId)}` : '';
    // Load each source independently so one failing endpoint doesn't blank the whole tab.
    const [sessionResult, downResult, upResult, summaryResult, agentResult] = await Promise.allSettled([
      api.get<EnterpriseChatSessionRead[]>(`/api/enterprise/sessions?tenant_id=${TENANT_ID}${agentQuery}`),
      api.get<FeedbackSessionRead[]>(`/api/enterprise/feedback/sessions?tenant_id=${TENANT_ID}&rating=down${agentQuery}`),
      api.get<FeedbackSessionRead[]>(`/api/enterprise/feedback/sessions?tenant_id=${TENANT_ID}&rating=up${agentQuery}`),
      api.get<FeedbackSummaryRead>(`/api/enterprise/feedback/summary?tenant_id=${TENANT_ID}${agentQuery}`),
      api.get<AgentProfileRead[]>(`/api/enterprise/agents?tenant_id=${TENANT_ID}`),
    ]);
    if (sessionResult.status === 'fulfilled') setSessions(sessionResult.value);
    if (downResult.status === 'fulfilled') setDownRows(downResult.value);
    if (upResult.status === 'fulfilled') setUpRows(upResult.value);
    if (summaryResult.status === 'fulfilled') setSummary(summaryResult.value);
    if (agentResult.status === 'fulfilled') setAgents(agentResult.value);
    const failure = [sessionResult, downResult, upResult, summaryResult, agentResult].find(
      (item): item is PromiseRejectedResult => item.status === 'rejected',
    );
    if (failure) {
      notify.error(conversationLogErrorMessage(failure.reason, 'dashboard.conversationLogs.error.partialLoad', t));
    }
    setLoading(false);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  useEffect(() => {
    setConversationUserId(ALL_CONVERSATION_USERS);
  }, [agentId]);

  const rows = useMemo<ConversationLogRow[]>(() => {
    const downBySession = new Map(downRows.map((item) => [item.session_id, item]));
    const upBySession = new Map(upRows.map((item) => [item.session_id, item]));
    return sessions
      .filter((session) => !agentId || session.agent_id === agentId)
      .map((session) => ({
        ...session,
        downFeedback: downBySession.get(session.id),
        upFeedback: upBySession.get(session.id),
      }));
  }, [agentId, downRows, sessions, upRows]);
  const dashboardMetrics = employeeDashboardMetrics(rows, summary);
  const aggregateSummary = feedbackSummaryDescriptor(summary?.summary);

  const agentsById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);

  const agentLabelFromId = (rowAgentId?: string | null): string => {
    if (!rowAgentId) return t('dashboard.conversationLogs.placeholder.empty');
    const agent = agentsById.get(rowAgentId);
    return agent ? employeeDisplayNameWithCreator(agent) : rowAgentId;
  };

  const agentLabel = (row: ConversationLogRow): string => agentLabelFromId(row.agent_id);

  const logFilterRows = useMemo(
    () => rows.filter((row) => matchesConversationLogFilter(row, filter)),
    [filter, rows],
  );

  const conversationUserOptions = useMemo(
    () => buildConversationUserOptions(logFilterRows),
    [logFilterRows],
  );

  const filteredRows = useMemo(
    () => logFilterRows.filter((row) => (
      conversationUserId === ALL_CONVERSATION_USERS || row.user_id === conversationUserId
    )),
    [conversationUserId, logFilterRows],
  );

  useEffect(() => {
    if (loading || conversationUserId === ALL_CONVERSATION_USERS) return;
    if (!conversationUserOptions.some((option) => option.userId === conversationUserId)) {
      setConversationUserId(ALL_CONVERSATION_USERS);
    }
  }, [conversationUserId, conversationUserOptions, loading]);

  const pagination = useClientPagination(
    filteredRows,
    FEEDBACK_PAGE_SIZE,
    `${filter}:${conversationUserId}`,
  );

  useEffect(() => {
    const visibleIds = new Set(filteredRows.map((row) => row.id));
    setSelectedSessionIds((current) => {
      const next = new Set([...current].filter((sessionId) => visibleIds.has(sessionId)));
      if (next.size === current.size && [...next].every((sessionId) => current.has(sessionId))) {
        return current;
      }
      return next;
    });
  }, [filteredRows]);

  const pageSessionIds = pagination.pagedItems.map((row) => row.id);
  const allPageRowsSelected =
    pageSessionIds.length > 0 && pageSessionIds.every((sessionId) => selectedSessionIds.has(sessionId));
  const somePageRowsSelected = pageSessionIds.some((sessionId) => selectedSessionIds.has(sessionId));
  const batchRows = selectedSessionIds.size
    ? filteredRows.filter((row) => selectedSessionIds.has(row.id))
    : filteredRows;

  const toggleSessionSelection = (sessionId: string, selected: boolean) => {
    setSelectedSessionIds((current) => {
      const next = new Set(current);
      if (selected) next.add(sessionId);
      else next.delete(sessionId);
      return next;
    });
  };

  const togglePageSelection = (selected: boolean) => {
    setSelectedSessionIds((current) => {
      const next = new Set(current);
      pageSessionIds.forEach((sessionId) => {
        if (selected) next.add(sessionId);
        else next.delete(sessionId);
      });
      return next;
    });
  };

  const exportSingleSession = async (row: ConversationLogRow) => {
    setExportingKey(row.id);
    try {
      const blob = await api.blob(
        `/api/enterprise/sessions/${encodeURIComponent(row.id)}/export?tenant_id=${TENANT_ID}`,
      );
      downloadBlob(blob, `staffdeck-conversation-log-${safeFilenamePart(row.id)}.json`);
      notify.success(t('dashboard.conversationLogs.toast.exportSingleSuccess'));
    } catch (error) {
      notify.error(conversationLogErrorMessage(error, 'dashboard.conversationLogs.error.exportSingle', t));
    } finally {
      setExportingKey('');
    }
  };

  const exportBatch = async () => {
    const sessionIds = batchRows.map((row) => row.id);
    if (sessionIds.length === 0) return;
    if (sessionIds.length > 500) {
      notify.error(t('dashboard.conversationLogs.error.exportBatchLimit', { count: 500 }));
      return;
    }
    setExportingKey('batch');
    try {
      const blob = await api.postBlob(
        `/api/enterprise/sessions/export?tenant_id=${TENANT_ID}`,
        { session_ids: sessionIds },
      );
      downloadBlob(blob, `staffdeck-conversation-logs-${filenameTimestamp()}.json`);
      notify.success(t('dashboard.conversationLogs.toast.exportBatchSuccess', { count: sessionIds.length }));
    } catch (error) {
      notify.error(conversationLogErrorMessage(error, 'dashboard.conversationLogs.error.exportBatch', t));
    } finally {
      setExportingKey('');
    }
  };

  const openDetail = async (row: ConversationLogRow) => {
    setDetailLoading(true);
    try {
      const sessionDetail = await api.get<EnterpriseSessionDetailRead>(
        `/api/enterprise/sessions/${row.id}?tenant_id=${TENANT_ID}`,
      );
      setDetail({
        session: sessionDetail.session,
        messages: sessionDetail.messages,
        feedback: sessionDetail.feedback || [],
        events: sessionDetail.events || [],
        traces: sessionDetail.traces || [],
        toolInvocations: sessionDetail.tool_invocations || [],
      });
    } catch (error) {
      notify.error(conversationLogErrorMessage(error, 'dashboard.conversationLogs.error.loadDetail', t));
    } finally {
      setDetailLoading(false);
    }
  };

  const reloadCurrentDetail = async () => {
    const sessionId = String(detail?.session?.id || detail?.session?.session_id || '');
    if (!sessionId) return;
    const row = rows.find((item) => item.id === sessionId);
    if (row) await openDetail(row);
  };

  const reanalyzeFeedback = async (feedbackId: string) => {
    setReanalyzingId(feedbackId);
    try {
      await api.post(`/api/enterprise/feedback/${feedbackId}/reanalyze?tenant_id=${TENANT_ID}`);
      notify.success(t('dashboard.conversationLogs.toast.reanalyzeSuccess'));
      await reloadCurrentDetail();
      await load();
    } catch (error) {
      notify.error(conversationLogErrorMessage(error, 'dashboard.conversationLogs.error.reanalyze', t));
    } finally {
      setReanalyzingId(null);
    }
  };

  const columns: DataTableColumn<ConversationLogRow>[] = [
    {
      key: 'selection',
      title: (
        <Checkbox
          aria-label={t('dashboard.conversationLogs.aria.selectPage')}
          checked={allPageRowsSelected ? true : somePageRowsSelected ? 'indeterminate' : false}
          onCheckedChange={(checked) => togglePageSelection(checked === true)}
        />
      ),
      width: 46,
      align: 'center',
      render: (row) => (
        <Checkbox
          aria-label={t('dashboard.conversationLogs.aria.selectRow', { session: row.title || row.id })}
          checked={selectedSessionIds.has(row.id)}
          onCheckedChange={(checked) => toggleSessionSelection(row.id, checked === true)}
        />
      ),
    },
    {
      key: 'title',
      title: t('dashboard.conversationLogs.table.title'),
      width: 200,
      className: 'whitespace-normal text-[#18181a]',
      render: (row) => (
        <span className="line-clamp-1 wrap-break-word">
          <RawContent value={row.title || row.summary || row.last_agent_question || row.id} />
        </span>
      ),
    },
    {
      key: 'agent',
      title: t('dashboard.conversationLogs.table.agent'),
      width: 180,
      render: (row) => (
        <span className="block truncate" title={agentLabel(row)}>
          <RawContent value={agentLabel(row)} />
        </span>
      ),
    },
    {
      key: 'source',
      title: t('dashboard.conversationLogs.table.source'),
      width: 140,
      render: (row) => (
        <div className="flex min-w-0 flex-col items-start gap-[4px]">
          <ChannelBadge channel={row.channel} t={t} />
          <span className="max-w-full truncate text-[11px] text-[#a0a6b8]">
            {(row.session_display_name || row.session_username)
              ? <RawContent value={row.session_display_name || row.session_username || ''} />
              : t('dashboard.conversationLogs.placeholder.empty')}
          </span>
        </div>
      ),
    },
    {
      key: 'status',
      title: t('dashboard.conversationLogs.table.status'),
      width: 120,
      render: (row) => (
        <div className="flex flex-wrap gap-[4px]">
          {row.downFeedback && <StatusBadge tone="red">{t('dashboard.conversationLogs.status.down')}</StatusBadge>}
          {row.upFeedback && <StatusBadge tone="green">{t('dashboard.conversationLogs.status.up')}</StatusBadge>}
          {!row.upFeedback && !row.downFeedback && <StatusBadge tone="blue">{t('dashboard.conversationLogs.status.unrated')}</StatusBadge>}
        </div>
      ),
    },
    {
      key: 'attribution',
      title: t('dashboard.conversationLogs.table.attribution'),
      width: 130,
      render: (row) => (
        <span>
          {row.downFeedback
            ? feedbackBucketLabel(row.downFeedback.primary_bucket, feedbackTranslate)
            : t('dashboard.conversationLogs.bucket.none')}
        </span>
      ),
    },
    {
      key: 'latest',
      title: t('dashboard.conversationLogs.table.latest'),
      className: 'whitespace-normal',
      render: (row) => (
        <span className="line-clamp-1 wrap-break-word">
          <RawContent value={
            row.downFeedback?.latest_message ||
            row.upFeedback?.latest_message ||
            row.summary ||
            row.last_agent_question ||
            t('dashboard.conversationLogs.placeholder.empty')
          } />
        </span>
      ),
    },
    {
      key: 'updated',
      title: t('dashboard.conversationLogs.table.updatedAt'),
      width: 170,
      render: (row) => formatDateTime(row.updated_at),
    },
    {
      key: 'actions',
      title: t('dashboard.conversationLogs.table.actions'),
      width: 150,
      render: (row) => (
        <div className="flex items-center gap-[12px]">
          <UIButton
            variant="link"
            disabled={Boolean(exportingKey)}
            onClick={() => void exportSingleSession(row)}
            className="h-auto gap-[4px] p-0 text-[12px] font-normal text-[#1a71ff] hover:text-[#4a8dff] hover:no-underline disabled:text-[#c0c6d4]"
          >
            {exportingKey === row.id ? (
              <LoaderCircle className="size-[12px] animate-spin" />
            ) : (
              <Download className="size-[12px]" />
            )}
            JSON
          </UIButton>
          <UIButton
            variant="link"
            disabled={detailLoading}
            onClick={() => void openDetail(row)}
            className="h-auto p-0 text-[12px] font-normal text-[#1a71ff] hover:text-[#4a8dff] hover:no-underline disabled:text-[#c0c6d4]"
          >
            {t('dashboard.conversationLogs.actions.view')}
          </UIButton>
        </div>
      ),
    },
  ];

  const renderMobileCard = (row: ConversationLogRow) => (
    <article className={MOBILE_CARD_CLASS} key={row.id}>
      <div className="flex min-w-0 items-start justify-between gap-[10px]">
        <div className="flex min-w-0 items-start gap-[8px]">
          <Checkbox
            aria-label={t('dashboard.conversationLogs.aria.selectRow', { session: row.title || row.id })}
            checked={selectedSessionIds.has(row.id)}
            onCheckedChange={(checked) => toggleSessionSelection(row.id, checked === true)}
          />
          <strong className="min-w-0 wrap-break-word text-[14px] font-semibold text-[#18181a]">
            <RawContent value={row.title || row.summary || row.last_agent_question || row.id} />
          </strong>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-[4px]">
          {row.downFeedback && <StatusBadge tone="red">{t('dashboard.conversationLogs.status.down')}</StatusBadge>}
          {row.upFeedback && <StatusBadge tone="green">{t('dashboard.conversationLogs.status.up')}</StatusBadge>}
          {!row.upFeedback && !row.downFeedback && <StatusBadge tone="blue">{t('dashboard.conversationLogs.status.unrated')}</StatusBadge>}
        </div>
      </div>
      <p className="mt-[8px] line-clamp-2 text-[12px] leading-[1.55] text-[#858b9c]">
        <RawContent value={
          row.downFeedback?.latest_message ||
          row.upFeedback?.latest_message ||
          row.summary ||
          row.last_agent_question ||
          t('dashboard.conversationLogs.placeholder.empty')
        } />
      </p>
      <div className="mt-[10px] flex items-center justify-between gap-[10px] text-[12px] text-[#858b9c]">
        <span className="truncate" title={agentLabel(row)}><RawContent value={agentLabel(row)} /></span>
        <span className="shrink-0">{formatDateTime(row.updated_at)}</span>
      </div>
      <div className="mt-[8px] flex items-center gap-[8px] text-[12px] text-[#858b9c]">
        <ChannelBadge channel={row.channel} t={t} />
        <span className="truncate">
          {(row.session_display_name || row.session_username)
            ? <RawContent value={row.session_display_name || row.session_username || ''} />
            : t('dashboard.conversationLogs.placeholder.empty')}
        </span>
      </div>
      <div className="mt-[10px] flex justify-end gap-[12px]">
        <UIButton
          variant="link"
          disabled={Boolean(exportingKey)}
          onClick={() => void exportSingleSession(row)}
          className="h-auto gap-[4px] p-0 text-[12px] font-normal text-[#1a71ff] hover:text-[#4a8dff] hover:no-underline disabled:text-[#c0c6d4]"
        >
          {exportingKey === row.id ? (
            <LoaderCircle className="size-[12px] animate-spin" />
          ) : (
            <Download className="size-[12px]" />
          )}
          JSON
        </UIButton>
        <UIButton
          variant="link"
          disabled={detailLoading}
          onClick={() => void openDetail(row)}
          className="h-auto p-0 text-[12px] font-normal text-[#1a71ff] hover:text-[#4a8dff] hover:no-underline disabled:text-[#c0c6d4]"
        >
          {t('dashboard.conversationLogs.actions.view')}
        </UIButton>
      </div>
    </article>
  );

  return (
    <>
      <section
        aria-busy={loading}
        className="relative mt-[-2px] flex w-full min-w-0 max-w-full flex-col gap-[24px] overflow-hidden rounded-[18px] bg-white p-[14px] shadow-[0_20px_42px_rgba(21,26,38,0.045)] min-[521px]:p-[18px]"
      >
        <div className="flex items-center gap-[6px] px-[12px] text-[#757f9c]">
          <IconCalendar className="size-[14px] shrink-0" />
          <span className="text-[14px] font-normal leading-none">{t('dashboard.conversationLogs.title')}</span>
        </div>

        <div className="flex flex-wrap items-stretch gap-[20px]" aria-label={t('dashboard.conversationLogs.metrics.ariaLabel')}>
          <StatCard value={rows.length} label={t('dashboard.conversationLogs.metrics.conversations')} />
          <StatCard value={summary?.total_feedback ?? 0} label={t('dashboard.conversationLogs.metrics.feedback')} />
          <StatCard value={formatMetricPercent(dashboardMetrics.positiveRate, locale)} label={t('dashboard.conversationLogs.metrics.positiveRate')} tone="green" />
          <StatCard value={formatMetricPercent(dashboardMetrics.negativeRate, locale)} label={t('dashboard.conversationLogs.metrics.negativeRate')} tone="red" />
        </div>

        {summary && (aggregateSummary || summary.bucket_counts.length > 0) && (
          <div className="flex flex-col gap-[12px] rounded-[14px] border border-[#eef0f4] bg-[#fafbfc] px-[20px] py-[16px]">
            {aggregateSummary && (
              <p className="wrap-break-word text-[13px] leading-[1.7] text-[#464c5e]">
                <span>{feedbackTranslate(aggregateSummary.bucket.id)}</span>{' '}
                <span>{feedbackTranslate(aggregateSummary.count.id, aggregateSummary.count.values)}</span>
                {aggregateSummary.detail && (
                  <>
                    <span>{' · '}</span>
                    <RawContent value={aggregateSummary.detail} />
                  </>
                )}
              </p>
            )}
            {summary.bucket_counts.length > 0 && (
              <div className="flex flex-wrap gap-[6px]">
                {summary.bucket_counts.map((item) => {
                  const projection = feedbackBucketCountDescriptor(item);
                  if (!projection) return null;
                  return (
                    <StatusBadge key={item.bucket} tone={bucketTone(item.bucket)}>
                      {feedbackTranslate(projection.bucket.id)}{' '}
                      {feedbackTranslate(projection.count.id, projection.count.values)}
                    </StatusBadge>
                  );
                })}
              </div>
            )}
          </div>
        )}

        <div className="flex flex-col gap-[12px] min-[1100px]:flex-row min-[1100px]:items-center min-[1100px]:justify-between">
          <div className="min-w-0 overflow-x-auto">
            <UnderlineTabs
              aria-label={t('dashboard.conversationLogs.filter.ariaLabel')}
              variant="line"
              value={filter}
              onChange={setFilter}
              items={filterTabs}
            />
          </div>
          <div className="flex shrink-0 items-center gap-[8px] max-[1099px]:w-full max-[520px]:flex-col">
            <label className="flex h-[34px] w-[280px] shrink-0 items-center overflow-hidden rounded-[10px] border-[0.5px] border-[#e3e7f1] bg-white transition-colors focus-within:border-[#18181a] max-[1099px]:flex-1 max-[520px]:w-full">
              <span className="flex h-full w-[72px] shrink-0 items-center justify-center border-r-[0.5px] border-[#e3e7f1] bg-[#f6f6f6] text-[12px] text-[#858b9c]">
                {t('dashboard.conversationLogs.userFilter.label')}
              </span>
              <UISelect value={conversationUserId} onValueChange={setConversationUserId}>
                <SelectTrigger
                  aria-label={t('dashboard.conversationLogs.userFilter.ariaLabel')}
                  className={cn(
                    SELECT_TRIGGER_CLASS,
                    'h-full min-w-0 flex-1 rounded-none border-0 px-[12px] shadow-none focus-visible:border-0',
                  )}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_CONVERSATION_USERS}>
                    {t('dashboard.conversationLogs.userFilter.allUsers', { count: logFilterRows.length })}
                  </SelectItem>
                  {conversationUserOptions.map((option) => (
                    <SelectItem key={option.userId} value={option.userId}>
                      <RawContent value={option.label} /> ({option.count})
                    </SelectItem>
                  ))}
                </SelectContent>
              </UISelect>
            </label>
            <UIButton
              variant="outline"
              disabled={batchRows.length === 0 || Boolean(exportingKey)}
              onClick={() => void exportBatch()}
              className="h-[34px] shrink-0 gap-[6px] rounded-[10px] border-[0.5px] border-[#e3e7f1] bg-white px-[14px] text-[12px] font-normal text-[#464c5e] hover:border-[#cbd3e6] hover:bg-[#fafbfc] disabled:text-[#c0c6d4] max-[520px]:w-full"
            >
              {exportingKey === 'batch' ? (
                <LoaderCircle className="size-[14px] animate-spin" />
              ) : (
                <Download className="size-[14px]" />
              )}
              {selectedSessionIds.size
                ? t('dashboard.conversationLogs.actions.exportSelected', { count: batchRows.length })
                : t('dashboard.conversationLogs.actions.exportFiltered', { count: batchRows.length })}
            </UIButton>
          </div>
        </div>

        <div className="grid gap-[10px] md:hidden">
          {filteredRows.length ? (
            pagination.pagedItems.map(renderMobileCard)
          ) : (
            <div className="py-[40px] text-center text-[13px] text-[#858b9c]">{t('dashboard.conversationLogs.empty')}</div>
          )}
        </div>

        <div className="hidden md:block">
          <DataTable
            aria-label={t('dashboard.conversationLogs.table.ariaLabel')}
            columns={columns}
            data={pagination.pagedItems}
            rowKey={(row) => row.id}
            loading={loading}
            emptyText={t('dashboard.conversationLogs.empty')}
          />
        </div>

        {filteredRows.length > 0 && (
          <Paginator
            aria-label={t('dashboard.conversationLogs.pagination.ariaLabel')}
            className="mt-0 mb-[6px]"
            page={pagination.page}
            pageCount={pagination.pageCount}
            onChange={pagination.setPage}
          />
        )}
      </section>

      <FeedbackDetailDialog
        detail={detail}
        agentLabelFromId={agentLabelFromId}
        onClose={() => setDetail(null)}
        onReanalyze={reanalyzeFeedback}
        reanalyzingId={reanalyzingId}
        locale={locale}
        t={t}
        feedbackTranslate={feedbackTranslate}
      />
    </>
  );
}

function FeedbackDetailDialog({
  detail,
  agentLabelFromId,
  onClose,
  onReanalyze,
  reanalyzingId,
  locale,
  t,
  feedbackTranslate,
}: {
  detail: ConversationDetail | null;
  agentLabelFromId: (agentId?: string | null) => string;
  onClose: () => void;
  onReanalyze: (feedbackId: string) => void;
  reanalyzingId: string | null;
  locale: 'zh-CN' | 'en-US';
  t: (id: MessageId, values?: MessageValues) => string;
  feedbackTranslate: FeedbackTranslate;
}) {
  return (
    <Dialog open={Boolean(detail)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        aria-describedby={undefined}
        className="flex max-h-[calc(100dvh-3rem)] w-[calc(100%-2rem)] flex-col gap-[16px] overflow-hidden rounded-[14px] px-[20px] py-[16px] sm:max-w-[1180px]"
      >
        <div className="flex items-center gap-[6px] px-[12px] text-[#757f9c]">
          <Clock className="size-[14px] shrink-0" />
          <DialogTitle className="text-[14px] font-normal leading-none text-[#757f9c]">
            {t('dashboard.conversationLogs.detail.title')}
          </DialogTitle>
        </div>

        {detail && (
          <div className="flex min-h-0 flex-1 flex-col gap-[16px] overflow-y-auto px-[12px]">
            <div className="grid grid-cols-2 gap-[10px] max-[520px]:grid-cols-1">
              <DetailField label={t('dashboard.conversationLogs.detail.sessionId')}>
                <RawIdentifier value={String(detail.session.session_id || detail.session.id || t('dashboard.conversationLogs.placeholder.empty'))} />
              </DetailField>
              <DetailField label={t('dashboard.conversationLogs.detail.agent')}>
                <RawContent value={agentLabelFromId(String(detail.session.agent_id || ''))} />
              </DetailField>
              <DetailField label={t('dashboard.conversationLogs.detail.user')}>
                <RawContent value={displayUser(detail.session, t)} />
              </DetailField>
              <DetailField label={t('dashboard.conversationLogs.detail.status')}>
                {detail.session.status
                  ? <RawIdentifier value={String(detail.session.status)} />
                  : t('dashboard.conversationLogs.placeholder.empty')}
              </DetailField>
              <DetailField label={t('dashboard.conversationLogs.detail.feedback')} className="col-span-2 max-[520px]:col-span-1">
                <div className="flex flex-wrap gap-[6px]">
                  <StatusBadge tone="green">
                    {t('dashboard.conversationLogs.status.up')} {detail.feedback.filter((item) => item.rating === 'up').length}
                  </StatusBadge>
                  <StatusBadge tone="red">
                    {t('dashboard.conversationLogs.status.down')} {detail.feedback.filter((item) => item.rating === 'down').length}
                  </StatusBadge>
                  {detail.feedback
                    .filter((item) => item.rating === 'down')
                    .map((item) => item.analysis as FeedbackAnalysisRead | undefined)
                    .filter(Boolean)
                    .map((analysis, index) => (
                      <StatusBadge
                        key={`${analysis?.bucket || 'unknown'}_${index}`}
                        tone={bucketTone(analysis?.bucket)}
                      >
                        {feedbackBucketLabel(analysis?.bucket, feedbackTranslate)}
                      </StatusBadge>
                    ))}
                </div>
              </DetailField>
            </div>

            <div className="feedback-conversation">
              {conversationItems(detail).map(({ message: item, trace }) => (
                <FeedbackMessage
                  key={item.id}
                  item={item}
                  trace={trace}
                  userLabel={displayUser(detail.session, t)}
                  onReanalyze={onReanalyze}
                  reanalyzing={Boolean(item.feedback_id && item.feedback_id === reanalyzingId)}
                  locale={locale}
                  t={t}
                  feedbackTranslate={feedbackTranslate}
                />
              ))}
              {detail.messages.length === 0 && detail.traces.length > 0
                ? detail.traces.map((trace) => (
                    <div key={trace.turn_id} className="feedback-message-row assistant">
                      <div className="feedback-message-bubble trace-only">
                        <FeedbackTraceBlock trace={trace} locale={locale} t={t} />
                      </div>
                    </div>
                  ))
                : null}
            </div>

            <ModelCallLogSection events={detail.events} t={t} />

            <section className="rounded-[14px] border border-[#e3e7f1] bg-[#fafbfc] p-[14px]">
              <div className="flex flex-wrap items-center justify-between gap-[8px]">
                <div>
                  <strong className="text-[13px] font-semibold text-[#18181a]">{t('dashboard.conversationLogs.tools.title')}</strong>
                  <p className="m-0 mt-[3px] text-[11px] text-[#858b9c]">
                    {t('dashboard.conversationLogs.tools.description')}
                  </p>
                </div>
                <StatusBadge tone="blue">{t('dashboard.conversationLogs.tools.count', { count: detail.toolInvocations.length })}</StatusBadge>
              </div>

              {detail.toolInvocations.length > 0 && (
                <div className="mt-[12px] grid gap-[8px]">
                  {detail.toolInvocations.map((invocation) => (
                    <details key={invocation.id} className="rounded-[10px] border border-[#e6e9ef] bg-white px-[12px] py-[9px]">
                      <summary className="cursor-pointer text-[12px] font-medium text-[#464c5e]">
                        <RawIdentifier value={invocation.tool_name} /> · <RawIdentifier value={invocation.status} /> · {formatDateTime(invocation.started_at)}
                      </summary>
                      <pre className="mt-[10px] max-h-[360px] overflow-auto rounded-[8px] bg-[#18181a] p-[12px] text-[11px] leading-[1.55] text-[#d8e2f0]">
                        {JSON.stringify(invocation, null, 2)}
                      </pre>
                    </details>
                  ))}
                </div>
              )}

              <details className="mt-[10px] rounded-[10px] border border-[#e6e9ef] bg-white px-[12px] py-[9px]">
                <summary className="cursor-pointer text-[12px] font-medium text-[#464c5e]">{t('dashboard.conversationLogs.tools.fullJson')}</summary>
                <pre className="mt-[10px] max-h-[520px] overflow-auto rounded-[8px] bg-[#18181a] p-[12px] text-[11px] leading-[1.55] text-[#d8e2f0]">
                  {JSON.stringify({
                    session: detail.session,
                    messages: detail.messages,
                    feedback: detail.feedback,
                    traces: detail.traces,
                    events: detail.events,
                    tool_invocations: detail.toolInvocations,
                  }, null, 2)}
                </pre>
              </details>
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

type SessionEvent = EnterpriseSessionDetailRead['events'][number];

type ModelCallLog = {
  spanId: string;
  started?: SessionEvent;
  terminal?: SessionEvent;
};

function ModelCallLogSection({
  events,
  t,
}: {
  events: SessionEvent[];
  t: (id: MessageId, values?: MessageValues) => string;
}) {
  const calls = modelCallLogs(events);
  if (calls.length === 0) return null;

  return (
    <section className="rounded-[14px] border border-[#dce6f7] bg-[#f7faff] p-[14px]">
      <div className="flex flex-wrap items-center justify-between gap-[8px]">
        <div>
          <strong className="text-[13px] font-semibold text-[#18181a]">{t('dashboard.conversationLogs.modelLogs.title')}</strong>
          <p className="m-0 mt-[3px] text-[11px] text-[#75809a]">
            {t('dashboard.conversationLogs.modelLogs.description')}
          </p>
        </div>
        <StatusBadge tone="blue">{t('dashboard.conversationLogs.modelLogs.count', { count: calls.length })}</StatusBadge>
      </div>

      <div className="mt-[12px] grid gap-[8px]">
        {calls.map((call, index) => {
          const input = call.started?.payload || call.terminal?.payload || {};
          const output = call.terminal?.payload || {};
          const terminalType = call.terminal?.event_type || '';
          const failed = terminalType === 'llm_call_failed';
          const running = !call.terminal;
          const responseMessage = output.response_message && typeof output.response_message === 'object'
            ? output.response_message as Record<string, unknown>
            : {};
          const modelName = String(input.model_name || input.model || t('dashboard.conversationLogs.modelLogs.noModel'));
          const operation = String(input.operation || 'llm.request');
          return (
            <details
              key={call.spanId}
              className="rounded-[10px] border border-[#dfe6f1] bg-white px-[12px] py-[9px]"
            >
              <summary className="flex cursor-pointer list-none flex-wrap items-center gap-[6px] text-[12px] font-medium text-[#464c5e]">
                <span>
                  {t('dashboard.conversationLogs.modelLogs.summary', {
                    index: index + 1,
                    operation,
                    modelName,
                  })}
                </span>
                <StatusBadge tone={failed ? 'red' : running ? 'orange' : 'green'}>
                  {failed
                    ? t('dashboard.conversationLogs.modelLogs.status.failed')
                    : running
                      ? t('dashboard.conversationLogs.modelLogs.status.running')
                      : t('dashboard.conversationLogs.modelLogs.status.completed')}
                </StatusBadge>
                <span className="ml-auto text-[11px] font-normal text-[#8a91a2]">
                  {formatDateTime(call.started?.created_at || call.terminal?.created_at || '')}
                </span>
              </summary>
              <div className="mt-[10px] grid gap-[10px] lg:grid-cols-2">
                <ModelExchangePayload
                  title={t('dashboard.conversationLogs.modelLogs.input')}
                  value={{
                    provider_request: input.request_payload || {
                      messages: input.request_messages || [],
                      ...(input.request_parameters || {}),
                    },
                    normalized_messages: input.request_messages || [],
                    normalized_parameters: input.request_parameters || {},
                  }}
                />
                <ModelExchangePayload
                  title={failed
                    ? t('dashboard.conversationLogs.modelLogs.failedOutput')
                    : t('dashboard.conversationLogs.modelLogs.output')}
                  value={
                    failed
                      ? {
                          error_type: output.error_type,
                          error: output.error,
                          partial_response_text: output.partial_response_text || '',
                          partial_reasoning_content: output.partial_reasoning_content || '',
                          partial_tool_call_deltas: output.partial_tool_call_deltas || [],
                          partial_response_chunks: output.partial_response_chunks || [],
                        }
                      : {
                          response_message: output.response_message || {
                            role: 'assistant',
                            content: output.response_text || '',
                          },
                          reasoning_content: responseMessage.reasoning_content || '',
                          tool_calls: responseMessage.tool_calls || [],
                          tool_call_deltas: responseMessage.tool_call_deltas || [],
                          provider_response: output.response_payload || null,
                          provider_stream_chunks: output.response_chunks || [],
                        }
                  }
                />
              </div>
            </details>
          );
        })}
      </div>
    </section>
  );
}

function ModelExchangePayload({ title, value }: { title: string; value: unknown }) {
  return (
    <div className="min-w-0">
      <div className="mb-[5px] text-[11px] font-semibold text-[#69738b]">{title}</div>
      <pre className="m-0 max-h-[440px] overflow-auto whitespace-pre-wrap break-words rounded-[8px] bg-[#18181a] p-[12px] text-[11px] leading-[1.55] text-[#d8e2f0]">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

function modelCallLogs(events: SessionEvent[]): ModelCallLog[] {
  const calls = new Map<string, ModelCallLog>();
  events.forEach((event) => {
    if (!event.event_type.startsWith('llm_call_')) return;
    const spanId = String(event.payload?.span_id || event.id);
    const call = calls.get(spanId) || { spanId };
    if (event.event_type === 'llm_call_started') call.started = event;
    if (event.event_type === 'llm_call_finished' || event.event_type === 'llm_call_failed') {
      call.terminal = event;
    }
    calls.set(spanId, call);
  });
  return Array.from(calls.values()).sort((left, right) => {
    const leftTime = left.started?.created_at || left.terminal?.created_at || '';
    const rightTime = right.started?.created_at || right.terminal?.created_at || '';
    return leftTime.localeCompare(rightTime);
  });
}

function FeedbackMessage({
  item,
  trace,
  userLabel,
  onReanalyze,
  reanalyzing,
  locale,
  t,
  feedbackTranslate,
}: {
  item: FeedbackMessageRead;
  trace?: TurnTraceRead;
  userLabel: string;
  onReanalyze: (feedbackId: string) => void;
  reanalyzing: boolean;
  locale: 'zh-CN' | 'en-US';
  t: (id: MessageId, values?: MessageValues) => string;
  feedbackTranslate: FeedbackTranslate;
}) {
  const isUser = item.role === 'user';
  const isAssistant = item.role === 'assistant';
  const analysisFailed = item.feedback_analysis?.status === 'failed';
  const evidence = feedbackEvidenceContent(item.feedback_analysis);
  return (
    <div className={`feedback-message-row ${isUser ? 'user' : 'assistant'}`}>
      <div className="feedback-message-bubble">
        <div className="feedback-message-meta">
          <span>
            {isUser
              ? <RawContent value={userLabel} />
              : isAssistant
                ? t('dashboard.conversationLogs.role.employee')
                : <RawIdentifier value={item.role} />}
          </span>
          <span>{formatDateTime(item.created_at)}</span>
          {item.feedback_rating === 'down' && <StatusBadge tone="red">{t('dashboard.conversationLogs.status.down')}</StatusBadge>}
          {item.feedback_rating === 'up' && <StatusBadge tone="green">{t('dashboard.conversationLogs.status.up')}</StatusBadge>}
          {item.feedback_analysis &&
            (analysisFailed ? (
              <StatusBadge tone="red">{t('dashboard.conversationLogs.analysis.failed')}</StatusBadge>
            ) : (
              <StatusBadge tone={bucketTone(item.feedback_analysis.bucket)}>
                {feedbackBucketLabel(item.feedback_analysis.bucket, feedbackTranslate)}
              </StatusBadge>
            ))}
        </div>
        {trace && <FeedbackTraceBlock trace={trace} locale={locale} t={t} />}
        <div className="feedback-message-content">
          <MarkdownMessage content={item.content} />
        </div>
        {item.feedback_analysis && item.feedback_rating === 'down' && (
          <div className="feedback-analysis-box">
            <div>
              <strong>{t('dashboard.conversationLogs.analysis.statusLabel')}</strong>
              {analysisStatusLabel(
                item.feedback_analysis.status,
                feedbackStatusParams(item.feedback_analysis),
                feedbackTranslate,
              )}
              {item.feedback_analysis.status !== 'failed' &&
                typeof item.feedback_analysis.confidence === 'number' && (
                  <span> · {t('dashboard.conversationLogs.analysis.confidence', { value: Number((item.feedback_analysis.confidence * 100).toFixed(0)) })}</span>
                )}
            </div>
            {item.feedback_analysis.summary && (
              <div>
                <strong>{t('dashboard.conversationLogs.analysis.summaryLabel')}</strong>
                <RawContent value={item.feedback_analysis.summary} />
              </div>
            )}
            {item.feedback_analysis.reason && (
              <div>
                <strong>{t('dashboard.conversationLogs.analysis.reasonLabel')}</strong>
                <RawContent value={item.feedback_analysis.reason} />
              </div>
            )}
            {evidence.length > 0 && (
              <div>
                <strong>{t('dashboard.conversationLogs.analysis.evidenceLabel')}</strong>
                <ul>
                  {evidence.map((value, index) => (
                    <li key={`${item.id}-evidence-${index}`}>
                      <RawContent value={value} />
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {item.feedback_analysis.status === 'failed' && item.feedback_id && (
              <UIButton
                variant="outline"
                disabled={reanalyzing}
                onClick={() => onReanalyze(item.feedback_id as string)}
                className="mt-[8px] h-[30px] gap-[4px] rounded-[10px] border-[0.5px] border-[#e3e7f1] bg-white px-[14px] text-[12px] font-normal text-[#757f9c] hover:border-[#cbd3e6] hover:text-[#18181a]"
              >
                <RefreshCw className={cn('size-3.5', reanalyzing && 'animate-spin')} />
                {t('dashboard.conversationLogs.actions.reanalyze')}
              </UIButton>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function conversationItems(
  detail: ConversationDetail,
): Array<{ message: FeedbackMessageRead; trace?: TurnTraceRead }> {
  const tracesByUserMessage = new Map<string, TurnTraceRead>();
  const tracesByTurn = new Map<string, TurnTraceRead>();
  detail.traces.forEach((trace) => {
    if (trace.user_message_id) tracesByUserMessage.set(trace.user_message_id, trace);
    tracesByTurn.set(trace.turn_id, trace);
  });

  let currentUserMessageId = '';
  return detail.messages.map((messageItem) => {
    if (messageItem.role === 'user') {
      currentUserMessageId = messageItem.id;
      return { message: messageItem };
    }
    const trace =
      messageItem.role === 'assistant'
        ? tracesByUserMessage.get(currentUserMessageId) || tracesByTurn.get(currentUserMessageId)
        : undefined;
    return { message: messageItem, trace };
  });
}

function FeedbackTraceBlock({
  trace,
  locale,
  t,
}: {
  trace: TurnTraceRead;
  locale: 'zh-CN' | 'en-US';
  t: (id: MessageId, values?: MessageValues) => string;
}) {
  const lines = traceDetails(trace.lines);
  if (lines.length === 0) return null;
  return (
    <div className="feedback-trace-block">
      <div className="feedback-trace-header">
        <Workflow className="size-[14px]" />
        <span>{t('dashboard.conversationLogs.trace.title')}</span>
        <span className="feedback-trace-overall-timing">
          {timingText(
            trace.duration_ms,
            trace.model_duration_ms,
            trace.model_call_count,
            trace.model_names,
            locale,
            t,
            true,
          )}
        </span>
        <span className="feedback-trace-status">
          {trace.completed_at
            ? t('dashboard.conversationLogs.trace.status.completed')
            : t('dashboard.conversationLogs.trace.status.running')}
        </span>
      </div>
      <div className="feedback-trace-lines">
        {lines.map((line) => (
          <div
            key={line.id}
            className={`feedback-trace-line ${line.kind} ${line.state}`}
            style={line.depth ? { marginLeft: `${Math.min(line.depth, 3) * 22}px` } : undefined}
          >
            <span className="feedback-trace-icon">{traceLineIcon(line.kind)}</span>
            <span className="feedback-trace-content">
              <span className="feedback-trace-title-row">
                <span className="feedback-trace-text">
                  {traceLineText(line, t)}
                </span>
                {(typeof line.duration_ms === 'number' || typeof line.model_duration_ms === 'number') && (
                  <span className="feedback-trace-timing">
                    {timingText(
                      line.duration_ms,
                      line.model_duration_ms,
                      line.model_call_count,
                      line.model_names,
                      locale,
                      t,
                    )}
                  </span>
                )}
              </span>
              {line.detail && <span className="feedback-trace-detail"><RawContent value={line.detail} /></span>}
              {line.code && (
                <details className="feedback-trace-code">
                  <summary>{t('dashboard.conversationLogs.trace.viewCode')}</summary>
                  <pre>{line.code}</pre>
                </details>
              )}
              {line.output && (
                <details className="feedback-trace-code">
                  <summary>{line.outputTitle ? <RawContent value={line.outputTitle} /> : t('dashboard.conversationLogs.trace.viewOutput')}</summary>
                  <pre>{line.output}</pre>
                </details>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** trace 行优先使用 canonical event_code/params，缺失时才显式落到 raw 文本。 */
function traceLineText(
  line: TraceLineRead,
  translate: (id: MessageId, values?: MessageValues) => string,
): string | JSX.Element {
  if (line.event_code) {
    return backendEventMessage(line.event_code, line.params || {}, translate, 'dashboard.conversationLogs.trace.fallback');
  }
  return <RawContent value={line.text} />;
}

function traceDetails(lines: TraceLineRead[]): TraceLineRead[] {
  return lines.filter((line) => {
    if (line.kind === 'thinking' && line.state !== 'failed') return false;
    return true;
  });
}

function traceLineIcon(kind: TraceLineRead['kind']) {
  if (kind === 'skill') return <GitBranch className="size-[13px]" />;
  if (kind === 'tool') return <Wrench className="size-[13px]" />;
  if (kind === 'knowledge') return <FileSearch className="size-[13px]" />;
  return <Workflow className="size-[13px]" />;
}

/** 读取会话中的可见用户名称；未知时使用安全占位语义文本。 */
function displayUser(
  session: Record<string, unknown>,
  translate: (id: MessageId, values?: MessageValues) => string,
): string {
  return String(
    session.session_display_name ||
      session.display_name ||
      session.session_username ||
      session.username ||
      translate('dashboard.conversationLogs.user.unknown'),
  );
}

/** 将 trace 与模型耗时格式化为当前 locale 的简洁摘要。 */
function timingText(
  durationMs?: number | null,
  modelDurationMs?: number | null,
  modelCallCount?: number | null,
  modelNames?: string[] | null,
  locale?: 'zh-CN' | 'en-US',
  translate?: (id: MessageId, values?: MessageValues) => string,
  showMissingModel = false,
): string {
  const parts: string[] = [];
  if (typeof durationMs === 'number' && translate) {
    parts.push(translate('dashboard.conversationLogs.timing.total', { value: formatDuration(durationMs) }));
  }
  const names = Array.from(new Set((modelNames || []).filter(Boolean)));
  if (names.length > 0 && translate && locale) {
    const listText = new Intl.ListFormat(locale, {
      style: 'short',
      type: 'conjunction',
    }).format(names.slice(0, 2));
    parts.push(
      names.length <= 2
        ? listText
        : translate('dashboard.conversationLogs.timing.modelList', { names: listText, count: names.length }),
    );
  }
  if (typeof modelDurationMs === 'number' && translate) {
    parts.push(translate('dashboard.conversationLogs.timing.modelDuration', { value: formatDuration(modelDurationMs) }));
  }
  if (typeof modelCallCount === 'number' && modelCallCount > 0 && translate) {
    parts.push(translate('dashboard.conversationLogs.timing.modelCalls', { count: modelCallCount }));
  } else if (showMissingModel && typeof durationMs === 'number' && modelDurationMs == null && translate) {
    parts.push(translate('dashboard.conversationLogs.timing.noModelCalls'));
  }
  return parts.join(' · ');
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1) return '<1ms';
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  if (durationMs < 10_000) return `${(durationMs / 1000).toFixed(2)}s`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function ChannelBadge({
  channel,
  t,
}: {
  channel?: string | null;
  t: (id: MessageId, values?: MessageValues) => string;
}) {
  if (channel === 'wechat') return <StatusBadge tone="green">{t('dashboard.conversationLogs.channel.wechat')}</StatusBadge>;
  if (channel) return <StatusBadge tone="blue"><RawIdentifier value={channel} /></StatusBadge>;
  return <StatusBadge tone="gray">{t('dashboard.conversationLogs.channel.web')}</StatusBadge>;
}

function bucketTone(bucket?: string): BadgeTone {
  if (bucket === 'model_issue') return 'red';
  if (bucket === 'skill_issue') return 'orange';
  if (bucket === 'tool_or_system_issue') return 'blue';
  if (bucket === 'positive_or_resolved') return 'green';
  if (bucket === 'needs_model_analysis') return 'blue';
  return 'gray';
}

/** 反馈分析状态优先使用语义标签，未知状态保留稳定标识。 */
function downloadBlob(blob: Blob, filename: string): void {
  const objectUrl = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(objectUrl);
}

function safeFilenamePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'session';
}

function filenameTimestamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('');
}
