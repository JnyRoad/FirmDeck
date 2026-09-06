import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, CircleAlert, LoaderCircle, SendHorizontal } from 'lucide-react';

import { createTenantClient } from '@/api/tenant-client';
import EmployeeAvatar from '@/components/EmployeeAvatar';
import { useTenantSession } from '@/contexts/TenantSessionContext';
import { firmdeckDisplayText } from '@/employee';
import { RawContent, RawIdentifier } from '@/i18n/RawContent';
import { useAppIntl } from '@/i18n/useAppIntl';
import { cn } from '@/lib/utils';
import type {
  AgentProfileRead,
  ChatMessage,
  KnowledgeCitation,
  TeamConversationMessageRead,
  TeamConversationRead,
  TeamConversationStreamRead,
  TeamConversationsResponse,
  TeamRead,
  TurnTraceRead,
} from '@/types';
import {
  MarkdownMessage,
  harnessWorkspaceArtifacts,
  knowledgeCitations,
  stripTrailingCitationSummary,
  traceDetails,
  traceSummary,
} from '../chatHelpers';
import type { TraceLine, TurnTrace } from '../chatTypes';
import ExecutionRecord from './ExecutionRecord';
import HarnessArtifactDownloads from './HarnessArtifactDownloads';
import KnowledgeCitationList from './KnowledgeCitationList';

function collaborationTrace(rows: TurnTraceRead[]): { turnId: string; trace: TurnTrace } | null {
  const ordered = [...rows].sort(
    (left, right) => Date.parse(left.started_at) - Date.parse(right.started_at),
  );
  const latest = ordered[ordered.length - 1];
  if (!latest) return null;
  const lines: TraceLine[] = latest.lines.map((line) => ({
    id: line.id,
    kind: line.kind,
    text: line.text,
    detail: line.detail || undefined,
    code: line.code || undefined,
    language: line.language || undefined,
    output: line.output || undefined,
    outputLanguage: line.outputLanguage || undefined,
    outputTitle: line.outputTitle || undefined,
    state: line.state,
    collapsible: Boolean(line.collapsible || line.code || line.output),
    depth: typeof line.depth === 'number' ? line.depth : undefined,
  }));
  return {
    turnId: latest.turn_id,
    trace: {
      lines,
      startedAt: Date.parse(latest.started_at) || Date.now(),
      completedAt: latest.completed_at ? Date.parse(latest.completed_at) : undefined,
    },
  };
}

/** 从团队会话标题中移除协议前缀；返回的标题属于业务数据，不进行翻译。 */
function conversationTitle(conversation: TeamConversationRead): string {
  return firmdeckDisplayText(conversation.title)
    .replace(/^团队任务验收:/, '')
    .replace(/^团队竞标(?:打分|裁决)?:/, '')
    .replace(/^团队任务:/, '')
    .trim();
}

/** Return structured question data; the caller formats product chrome via a stable ICU message. */
export function collaborationQuestion(conversation: TeamConversationRead): {
  messageId: 'chat.team.memberBidPromptTail' | 'chat.team.memberTaskPromptTail';
  memberName: string;
  title: string;
} {
  return {
    messageId: conversation.kind === 'member_bid'
      ? 'chat.team.memberBidPromptTail'
      : 'chat.team.memberTaskPromptTail',
    memberName: conversation.agent_name || '',
    title: conversationTitle(conversation),
  };
}

function conversationTimestamp(conversation: TeamConversationRead): number {
  const createdAt = Date.parse(conversation.created_at);
  if (Number.isFinite(createdAt)) return createdAt;
  const updatedAt = Date.parse(conversation.updated_at);
  return Number.isFinite(updatedAt) ? updatedAt : Number.POSITIVE_INFINITY;
}

export type TeamChatTimelineEntry =
  | { kind: 'message'; message: ChatMessage; messageIndex: number }
  | { kind: 'collaboration'; conversation: TeamConversationRead };

export function mergeTeamChatTimeline(
  messages: ChatMessage[],
  conversations: TeamConversationRead[],
): TeamChatTimelineEntry[] {
  const buckets = Array.from(
    { length: messages.length + 1 },
    () => [] as TeamConversationRead[],
  );

  [...conversations]
    .sort((left, right) => conversationTimestamp(left) - conversationTimestamp(right))
    .forEach((conversation) => {
      const timestamp = conversationTimestamp(conversation);
      const nextMessageIndex = messages.findIndex((message) => {
        const messageTimestamp = Date.parse(message.created_at);
        return Number.isFinite(messageTimestamp) && messageTimestamp > timestamp;
      });
      buckets[nextMessageIndex < 0 ? messages.length : nextMessageIndex].push(conversation);
    });

  const timeline: TeamChatTimelineEntry[] = [];
  buckets[0].forEach((conversation) => timeline.push({ kind: 'collaboration', conversation }));
  messages.forEach((message, messageIndex) => {
    timeline.push({ kind: 'message', message, messageIndex });
    buckets[messageIndex + 1].forEach((conversation) => (
      timeline.push({ kind: 'collaboration', conversation })
    ));
  });
  return timeline;
}

export function useTeamCollaborations(team?: TeamRead | null): TeamConversationRead[] {
  const [conversations, setConversations] = useState<TeamConversationRead[]>([]);
  const leaderAgentId = team?.members.find((member) => member.role === 'leader')?.agent_id;
  const tenantContext = useTenantSession();
  const tenantClient = useMemo(() => createTenantClient(tenantContext), [tenantContext]);

  useEffect(() => {
    let cancelled = false;
    if (!team || !tenantContext) {
      setConversations([]);
      return () => {
        cancelled = true;
      };
    }
    const controller = new AbortController();
    const onTenantAbort = () => controller.abort();
    tenantContext.signal.addEventListener('abort', onTenantAbort, { once: true });
    setConversations([]);
    const loadConversations = async () => {
      try {
        const response = await tenantClient.get<TeamConversationsResponse>(
          `/api/enterprise/teams/${team.id}/conversations`,
          { signal: controller.signal },
        );
        if (cancelled || controller.signal.aborted) return;
        const seen = new Set<string>();
        const latest = response.conversations.filter((conversation) => {
          if (conversation.kind !== 'member_task' && conversation.kind !== 'member_bid') return false;
          if (conversation.agent_id === leaderAgentId) return false;
          const key = `${conversation.agent_id || ''}:${conversation.kind}:${conversationTitle(conversation)}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        }).slice(0, 4);
        setConversations(latest.sort(
          (left, right) => conversationTimestamp(left) - conversationTimestamp(right),
        ));
      } catch {
        // Keep the last successful snapshot during a transient polling error.
      }
    };
    void loadConversations();
    const pollTimer = window.setInterval(() => void loadConversations(), 2_000);
    return () => {
      cancelled = true;
      tenantContext.signal.removeEventListener('abort', onTenantAbort);
      controller.abort();
      window.clearInterval(pollTimer);
    };
  }, [leaderAgentId, team?.id, tenantClient, tenantContext]);

  return conversations;
}

export default function TeamCollaborationPanel({
  team,
  agents,
  conversation,
  onOpenCitation,
}: {
  team: TeamRead;
  agents: AgentProfileRead[];
  conversation?: TeamConversationRead;
  onOpenCitation?: (citation: KnowledgeCitation) => void;
}) {
  const { t } = useAppIntl();
  const tenantContext = useTenantSession();
  const tenantClient = useMemo(() => createTenantClient(tenantContext), [tenantContext]);
  const requestControllersRef = useRef(new Set<AbortController>());
  const loadedConversations = useTeamCollaborations(conversation ? undefined : team);
  const conversations = conversation ? [conversation] : loadedConversations;
  const [expandedSessionId, setExpandedSessionId] = useState('');
  const [messagesBySession, setMessagesBySession] = useState<Record<string, TeamConversationMessageRead[]>>({});
  const [streamBySession, setStreamBySession] = useState<Record<string, TeamConversationStreamRead>>({});
  const [tracesBySession, setTracesBySession] = useState<Record<string, TurnTraceRead[]>>({});
  const [expandedTraceIds, setExpandedTraceIds] = useState<string[]>([]);
  const [loadingSessionId, setLoadingSessionId] = useState('');
  const [answerByTaskId, setAnswerByTaskId] = useState<Record<string, string>>({});
  const [submittingTaskId, setSubmittingTaskId] = useState('');
  const [submittedTaskIds, setSubmittedTaskIds] = useState<string[]>([]);
  const [submitErrorByTaskId, setSubmitErrorByTaskId] = useState<Record<string, string>>({});
  const agentById = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent])),
    [agents],
  );
  const leaderMember = team.members.find((member) => member.role === 'leader');
  const leaderAgent = leaderMember ? agentById.get(leaderMember.agent_id) : undefined;

  const beginScopedRequest = () => {
    const controller = new AbortController();
    requestControllersRef.current.add(controller);
    const onTenantAbort = () => controller.abort();
    tenantContext?.signal.addEventListener('abort', onTenantAbort, { once: true });
    return {
      controller,
      cleanup: () => {
        tenantContext?.signal.removeEventListener('abort', onTenantAbort);
        requestControllersRef.current.delete(controller);
      },
    };
  };

  useEffect(() => () => {
    requestControllersRef.current.forEach((controller) => controller.abort());
    requestControllersRef.current.clear();
  }, []);

  useEffect(() => {
    if (!expandedSessionId || !tenantContext) return undefined;
    let cancelled = false;
    let refreshing = false;
    let pollTimer: number | undefined;
    const scopedRequest = beginScopedRequest();
    const { controller } = scopedRequest;
    const refreshStream = async () => {
      if (refreshing || cancelled || controller.signal.aborted) return;
      refreshing = true;
      try {
        const [stream, traces] = await Promise.all([
          tenantClient.get<TeamConversationStreamRead>(
            `/api/enterprise/teams/${team.id}/conversations/${expandedSessionId}/stream`,
            { signal: controller.signal },
          ),
          tenantClient.get<TurnTraceRead[]>(
            `/api/chat/sessions/${expandedSessionId}/trace`,
            { signal: controller.signal },
          ).catch(() => []),
        ]);
        if (cancelled || controller.signal.aborted) return;
        setStreamBySession((current) => ({ ...current, [expandedSessionId]: stream }));
        setTracesBySession((current) => ({
          ...current,
          [expandedSessionId]: Array.isArray(traces) ? traces : [],
        }));
        if (stream.status === 'completed' || stream.status === 'failed') {
          const rows = await tenantClient.get<TeamConversationMessageRead[]>(
            `/api/enterprise/teams/${team.id}/conversations/${expandedSessionId}/messages`,
            { signal: controller.signal },
          );
          if (!cancelled && !controller.signal.aborted) {
            setMessagesBySession((current) => ({ ...current, [expandedSessionId]: rows }));
            if (pollTimer !== undefined) window.clearInterval(pollTimer);
          }
        }
      } catch {
        // Preserve the last stream snapshot and retry while the reply stays expanded.
      } finally {
        refreshing = false;
      }
    };
    pollTimer = window.setInterval(() => void refreshStream(), 400);
    void refreshStream();
    return () => {
      cancelled = true;
      scopedRequest.cleanup();
      controller.abort();
      if (pollTimer !== undefined) window.clearInterval(pollTimer);
    };
  }, [expandedSessionId, team.id, tenantClient, tenantContext]);

  async function toggleReply(conversation: TeamConversationRead) {
    if (!tenantContext) return;
    if (expandedSessionId === conversation.session_id) {
      setExpandedSessionId('');
      return;
    }
    setExpandedSessionId(conversation.session_id);
    if (messagesBySession[conversation.session_id] && tracesBySession[conversation.session_id]) return;
    setLoadingSessionId(conversation.session_id);
    const scopedRequest = beginScopedRequest();
    const { controller } = scopedRequest;
    try {
      const [rows, traces] = await Promise.all([
        tenantClient.get<TeamConversationMessageRead[]>(
          `/api/enterprise/teams/${team.id}/conversations/${conversation.session_id}/messages`,
          { signal: controller.signal },
        ),
        tenantClient.get<TurnTraceRead[]>(
          `/api/chat/sessions/${conversation.session_id}/trace`,
          { signal: controller.signal },
        ).catch(() => []),
      ]);
      if (controller.signal.aborted) return;
      setMessagesBySession((current) => ({ ...current, [conversation.session_id]: rows }));
      setTracesBySession((current) => ({
        ...current,
        [conversation.session_id]: Array.isArray(traces) ? traces : [],
      }));
    } catch {
      if (controller.signal.aborted) return;
      setMessagesBySession((current) => ({ ...current, [conversation.session_id]: [] }));
      setTracesBySession((current) => ({ ...current, [conversation.session_id]: [] }));
    } finally {
      scopedRequest.cleanup();
      setLoadingSessionId('');
    }
  }

  /** 提交人工补充信息并恢复同一团队任务；技术异常仅记录日志，界面展示稳定错误消息。 */
  async function resumeTask(conversation: TeamConversationRead) {
    const taskId = conversation.task_id;
    const answer = taskId ? (answerByTaskId[taskId] || '').trim() : '';
    if (!taskId || !answer || submittingTaskId) return;
    setSubmittingTaskId(taskId);
    setSubmitErrorByTaskId((current) => ({ ...current, [taskId]: '' }));
    if (!tenantContext) {
      setSubmittingTaskId('');
      return;
    }
    const scopedRequest = beginScopedRequest();
    const { controller } = scopedRequest;
    try {
      await tenantClient.post(
        `/api/enterprise/teams/${team.id}/tasks/${taskId}/resume`,
        { answer },
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      setSubmittedTaskIds((current) => (
        current.includes(taskId) ? current : [...current, taskId]
      ));
    } catch (error) {
      if (controller.signal.aborted) return;
      console.error('[team-chat] resume task failed', error);
      setSubmitErrorByTaskId((current) => ({
        ...current,
        [taskId]: t('chat.error.replyFailed'),
      }));
    } finally {
      scopedRequest.cleanup();
      setSubmittingTaskId('');
    }
  }

  if (conversations.length === 0) return null;

  return conversations.map((conversation) => {
    const memberAgent = conversation.agent_id
      ? agentById.get(conversation.agent_id)
      : undefined;
    const rawMemberName = conversation.agent_name || '';
    const memberName = rawMemberName || t('chat.team.memberFallback');
    const title = conversationTitle(conversation) || t('chat.team.taskFallback');
    const expanded = expandedSessionId === conversation.session_id;
    const loading = loadingSessionId === conversation.session_id;
    const memberReplies = (messagesBySession[conversation.session_id] || [])
      .filter((message) => message.role === 'assistant');
    const stream = streamBySession[conversation.session_id];
    const traceSnapshot = collaborationTrace(tracesBySession[conversation.session_id] || []);
    const traceLines = traceSnapshot?.trace.lines || [];
    const traceLineDetails = traceDetails(traceLines);
    const traceLineSummary = traceSnapshot
      ? traceSummary(traceSnapshot.trace, traceLines, t)
      : null;
    const streamReply = firmdeckDisplayText(stream?.content || '');
    const showStreamReply = Boolean(
      streamReply
      && memberReplies.length === 0,
    );
    const preview = firmdeckDisplayText(conversation.preview || '');
    const taskId = conversation.task_id || '';
    const waitingForInput = Boolean(conversation.needs_input && taskId);
    const submitted = Boolean(taskId && submittedTaskIds.includes(taskId));
    const pendingQuestion = firmdeckDisplayText(conversation.pending_question || conversation.preview || '');
    const taskAnswer = taskId ? (answerByTaskId[taskId] || '') : '';
    const submitError = taskId ? submitErrorByTaskId[taskId] : '';

    return (
      <div
        key={conversation.session_id}
        aria-label={t('chat.team.label', { memberName })}
        className="relative flex min-w-0 flex-col gap-[10px]"
      >
        <div className="flex min-w-0 items-start gap-[10px]">
          <EmployeeAvatar agent={leaderAgent} size={36} radius={10} />
          <div className="flex min-w-0 max-w-[680px] flex-1 flex-col gap-[5px]">
            <div className="flex items-center gap-[6px] px-[2px]">
              <span className="text-[11px] font-medium text-[#757f9c]">
                {leaderMember?.agent_name
                  ? <RawIdentifier value={leaderMember.agent_name} />
                  : t('chat.team.projectLead')}
              </span>
              <span className="rounded-full bg-[#edf3ff] px-[6px] py-px text-[9px] font-medium text-[#1a71ff]">
                {t('chat.team.projectLead')}
              </span>
            </div>
            <div className="rounded-[14px] border border-[#d9e5ff] bg-[#f6f9ff] px-[14px] py-[10px] text-[13px] leading-[20px] text-[#18181a]">
              <span
                className="font-medium text-[#1a71ff]"
                translate="no"
                data-i18n-raw-kind="identifier"
              >
                @{memberName}
              </span>
              {conversation.kind === 'member_bid'
                ? t('chat.team.memberBidPromptTail', { title })
                : t('chat.team.memberTaskPromptTail', { title })}
            </div>
          </div>
        </div>

        <div className="ml-[18px] h-[8px] w-px bg-[#dbe3f1]" />

        <div className="flex min-w-0 items-start gap-[10px]">
          <EmployeeAvatar agent={memberAgent} size={36} radius={10} />
          <div className="flex min-w-0 max-w-[680px] flex-1 flex-col gap-[5px]">
            <span className="px-[2px] text-[11px] font-medium text-[#757f9c]">
              {rawMemberName ? <RawIdentifier value={rawMemberName} /> : memberName}
            </span>
            {waitingForInput ? (
              <div className="w-full rounded-[16px] border border-[#f0d8a8] bg-[#fffdf7] px-[14px] py-[12px] shadow-[0_8px_24px_rgba(90,61,8,0.06)]">
                <div className="flex items-center gap-[7px] text-[11px] font-medium text-[#9a6811]">
                  <CircleAlert className="size-[14px]" />
                  <span>{t('chat.team.needsInfo', { memberName })}</span>
                  <span className="rounded-full bg-[#fff0c8] px-[7px] py-[2px] text-[9px] text-[#8a5b0a]">
                    {t('chat.team.waitingForReply')}
                  </span>
                </div>
                <p className="mt-[8px] whitespace-pre-wrap text-[13px] leading-[21px] text-[#34302a]">
                  <RawContent value={pendingQuestion} />
                </p>
                {submitted ? (
                  <div className="mt-[11px] rounded-[10px] bg-[#eef8f3] px-[11px] py-[9px] text-[12px] text-[#277657]">
                    {t('chat.team.submitted')}
                  </div>
                ) : (
                  <div className="mt-[11px] flex items-end gap-[8px]">
                    <textarea
                      aria-label={t('chat.team.replyQuestion', { memberName })}
                      value={taskAnswer}
                      onChange={(event) => setAnswerByTaskId((current) => ({
                        ...current,
                        [taskId]: event.target.value,
                      }))}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && !event.shiftKey) {
                          event.preventDefault();
                          void resumeTask(conversation);
                        }
                      }}
                      rows={2}
                      placeholder={t('chat.team.replyPlaceholder')}
                      className="min-h-[58px] min-w-0 flex-1 resize-none rounded-[11px] border border-[#e5d7b7] bg-white px-[11px] py-[8px] text-[12px] leading-[18px] text-[#18181a] outline-none transition focus:border-[#c99838] focus:ring-2 focus:ring-[#efdba8]/60"
                    />
                    <button
                      type="button"
                      aria-label={t('chat.team.continueAction')}
                      disabled={!taskAnswer.trim() || submittingTaskId === taskId}
                      onClick={() => void resumeTask(conversation)}
                      className="flex h-[36px] shrink-0 items-center gap-[5px] rounded-[10px] bg-[#18181a] px-[12px] text-[11px] font-medium text-white transition hover:bg-[#343437] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {submittingTaskId === taskId
                        ? <LoaderCircle className="size-[13px] animate-spin" />
                        : <SendHorizontal className="size-[13px]" />}
                      {t('chat.team.resume')}
                    </button>
                  </div>
                )}
                {submitError && (
                  <p className="mt-[7px] text-[11px] text-[#c13e35]">{submitError}</p>
                )}
              </div>
            ) : (
              <div
                className="group w-full rounded-[14px] border border-[#e3e7f1] bg-white px-[14px] py-[11px] text-left shadow-[0_1px_2px_rgba(24,24,26,0.03)] transition-colors hover:border-[#cfd6e3]"
              >
                <button
                  type="button"
                  aria-label={t(
                    expanded ? 'chat.team.collapseReply' : 'chat.team.expandReply',
                    { memberName },
                  )}
                  aria-expanded={expanded}
                  onClick={() => void toggleReply(conversation)}
                  className="flex w-full items-center gap-[8px] text-left"
                >
                  <span className="min-w-0 flex-1 truncate text-[12px] text-[#464c5e]">
                    {t('chat.team.replyPrefix', { memberName, preview })}
                  </span>
                  {loading ? (
                    <LoaderCircle className="size-[13px] shrink-0 animate-spin text-[#858b9c]" />
                  ) : (
                    <ChevronDown className={cn(
                      'size-[14px] shrink-0 text-[#858b9c] transition-transform',
                      expanded && 'rotate-180',
                    )} />
                  )}
                </button>
              {expanded && !loading && (
                <div className="mt-[10px] border-t border-[#eef1f6] pt-[10px]">
                  {traceSnapshot && traceLineSummary && traceLines.length > 0 && (
                    <div className="mb-[10px]">
                      <ExecutionRecord
                        traceTurnId={traceSnapshot.turnId}
                        summary={traceLineSummary}
                        details={traceLineDetails}
                        expanded={expandedTraceIds.includes(traceSnapshot.turnId)}
                        onToggle={(turnId, isExpanded) => setExpandedTraceIds((current) => (
                          isExpanded
                            ? current.filter((item) => item !== turnId)
                            : [...current.filter((item) => item !== turnId), turnId]
                        ))}
                      />
                    </div>
                  )}
                  {memberReplies.map((message) => {
                    const chatMessage: ChatMessage = {
                      ...message,
                      role: 'assistant',
                    };
                    const visibleContent = stripTrailingCitationSummary(
                      firmdeckDisplayText(message.content),
                    );
                    const citations = knowledgeCitations(chatMessage, visibleContent);
                    const artifacts = harnessWorkspaceArtifacts(chatMessage);
                    return (
                      <div
                        key={message.id}
                        className="mb-[10px] text-[13px] leading-[21px] text-[#18181a] last:mb-0"
                      >
                        <div translate="no" data-i18n-raw-kind="content">
                          <MarkdownMessage content={visibleContent} />
                        </div>
                        <HarnessArtifactDownloads
                          artifacts={artifacts}
                          tenantId={tenantContext?.tenantId || ''}
                          sessionId={conversation.session_id}
                        />
                        <KnowledgeCitationList
                          citations={citations}
                          onOpen={(citation) => onOpenCitation?.(citation)}
                        />
                      </div>
                    );
                  })}
                  {showStreamReply && (
                    <div
                      className="mb-[8px] block text-[13px] leading-[21px] text-[#18181a] last:mb-0"
                      aria-live="polite"
                    >
                      <div translate="no" data-i18n-raw-kind="content">
                        <MarkdownMessage content={streamReply} />
                      </div>
                      {stream?.status === 'running' && (
                        <span className="ml-[3px] inline-block h-[14px] w-[2px] animate-pulse rounded-full bg-[#1a71ff] align-[-2px]" />
                      )}
                    </div>
                  )}
                  {memberReplies.length === 0 && !showStreamReply && (
                    <span className="flex items-center gap-[6px] text-[12px] text-[#a7adbb]">
                      {stream?.status === 'running' && (
                        <LoaderCircle className="size-[12px] animate-spin" />
                      )}
                      {stream?.phase
                        ? <RawIdentifier value={stream.phase} />
                        : t('chat.team.processing')}
                    </span>
                  )}
                </div>
              )}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  });
}
