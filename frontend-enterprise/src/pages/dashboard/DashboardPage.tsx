import { useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentType, ReactNode, SVGProps } from 'react';
import { useNavigate } from 'react-router-dom';

import { Badge, Button as UiButton, Tabs, TabsList, TabsTrigger, notify } from '@/components/ui';
import { RawContent, RawIdentifier } from '@/i18n/RawContent';
import { useAppIntl } from '@/i18n/useAppIntl';
import { apiErrorMessage } from '@/lib/apiErrorMessages';

import { createTenantClient } from '../../api/tenant-client';
import type { EnterpriseAuthUser } from '../../auth';
import { useTenantSession } from '../../contexts/TenantSessionContext';
import IconChat from '../../assets/icons/chat.svg?react';
import IconEdit from '../../assets/icons/edit.svg?react';
import IconProfileAlarm from '../../assets/icons/profile-alarm.svg?react';
import IconProfileCalendar from '../../assets/icons/profile-calendar.svg?react';
import IconProfileFile from '../../assets/icons/profile-file.svg?react';
import IconProfileHistory from '../../assets/icons/profile-history.svg?react';
import IconAccount from '../../assets/icons/sys-accounts.svg?react';
import AppHeader from '../../components/AppHeader';
import EmployeeAvatar from '../../components/EmployeeAvatar';
import EmployeeAvatarEditor from '../../components/EmployeeAvatarEditor';
import EmployeeProfileEditor from '../../components/EmployeeProfileEditor';
import StaffdeckIcon from '../../components/StaffdeckIcon';
import {
  agentResourceCount,
  canManageEmployeeAgent,
  canSelectCurrentEmployeeAgent,
  employeeCreatorName,
  employeeDisplayName,
  employeeProfile,
  preferredEmployeeAgent,
  staffdeckDisplayText,
} from '../../employee';
import { EnterpriseRoute } from '../../enums/routes';
import {
  emitAgentScopeChange,
  isTeamScope,
  persistSharedAgentScope,
  readEmployeeScope,
} from '../../lib/agent-scope-storage';
import { parseBackendDateTime } from '../../lib/timezone';
import type {
  AgentProfileRead,
  AgentWorkRecordEventRead,
  AgentWorkRecordRead,
  EnterpriseChatSessionRead,
  FeedbackSummaryRead,
  GeneralSkillRead,
  KnowledgeBaseRead,
  ModelConfigRead,
  ScheduledTaskRead,
  SkillRead,
  ToolRead,
} from '../../types';
import ConversationLogsTab from './ConversationLogsTab';
import EvolutionPanel from './EvolutionPanel';
import MemoriesTab from './MemoriesTab';
import ScheduledTasksTab from './ScheduledTasksTab';
import WorkRecordTab from './WorkRecordTab';
import { employeeDashboardMetrics } from './employeeDashboardMetrics';

type ProfileTabKey = 'work' | 'scheduled' | 'memories' | 'logs';

const PROFILE_TABS: {
  key: ProfileTabKey;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  route: EnterpriseRoute;
}[] = [
  { key: 'work', Icon: IconProfileFile, route: EnterpriseRoute.Dashboard },
  { key: 'scheduled', Icon: IconProfileAlarm, route: EnterpriseRoute.ScheduledTasks },
  { key: 'memories', Icon: IconProfileHistory, route: EnterpriseRoute.Memories },
  { key: 'logs', Icon: IconProfileCalendar, route: EnterpriseRoute.Feedback },
];

/** 将未知异常折叠为安全语义错误，避免把原始 Error.message 暴露到最终 UI。 */
function dashboardErrorMessage(error: unknown, fallback: string, genericMessage: string): string {
  const message = apiErrorMessage(error, 'common.error.generic');
  return message === genericMessage ? fallback : message;
}

/** 按 locale 格式化员工入职日期；无效时间统一回退为占位符。 */
function formatDashboardDate(value: string, locale: 'zh-CN' | 'en-US', emptyText: string): string {
  const date = parseBackendDateTime(value);
  if (Number.isNaN(date.getTime())) return emptyText;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(date);
}

/** 为缺少自定义简介的员工生成安全摘要，并保留原始岗位名作为插值。 */
function fallbackSystemSummary(translate: ReturnType<typeof useAppIntl>['t'], roleName: string): string {
  return translate('dashboard.page.summary.fallback', {
    role: roleName || translate('dashboard.page.value.none'),
  });
}

export default function DashboardPage({
  currentUser,
  isAdmin = false,
  profileTab = 'work',
  onLogout,
}: {
  currentUser?: EnterpriseAuthUser;
  isAdmin?: boolean;
  profileTab?: ProfileTabKey;
  onLogout?: () => void;
}) {
  const { locale, t } = useAppIntl();
  const navigate = useNavigate();
  const tenantContext = useTenantSession();
  const tenantClient = useMemo(() => createTenantClient(tenantContext), [tenantContext]);
  const tenantId = tenantContext?.tenantId || '';
  const userId = tenantContext?.userId || '';
  const tenantScopeKey = tenantContext
    ? `${tenantId}:${userId}:${tenantContext.generation}`
    : '';
  const scopeKeyRef = useRef('');
  const [scopeReady, setScopeReady] = useState(false);
  const [agents, setAgents] = useState<AgentProfileRead[]>([]);
  const [skills, setSkills] = useState<SkillRead[]>([]);
  const [generalSkills, setGeneralSkills] = useState<GeneralSkillRead[]>([]);
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBaseRead[]>([]);
  const [models, setModels] = useState<ModelConfigRead[]>([]);
  const [tools, setTools] = useState<ToolRead[]>([]);
  const [sessions, setSessions] = useState<EnterpriseChatSessionRead[]>([]);
  const [feedbackSummary, setFeedbackSummary] = useState<FeedbackSummaryRead | null>(null);
  const [scheduledTasks, setScheduledTasks] = useState<ScheduledTaskRead[]>([]);
  const [activityEvents, setActivityEvents] = useState<AgentWorkRecordEventRead[]>([]);
  const [agentId, setAgentId] = useState('');
  const [avatarEditorOpen, setAvatarEditorOpen] = useState(false);
  const [profileEditorOpen, setProfileEditorOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!tenantContext || !tenantId || !userId) {
      scopeKeyRef.current = '';
      setScopeReady(false);
      setAgentId('');
      return;
    }
    scopeKeyRef.current = tenantScopeKey;
    setAgentId(readEmployeeScope(tenantId, userId));
    setScopeReady(true);
  }, [tenantContext, tenantId, tenantScopeKey, userId]);

  useEffect(() => {
    const onScopeChange = (event: Event) => {
      const next = (event as CustomEvent<{ agentId?: string }>).detail?.agentId || '';
      if (!tenantContext || !tenantId || !userId || scopeKeyRef.current !== tenantScopeKey) return;
      setAgentId(next && !isTeamScope(next) ? next : readEmployeeScope(tenantId, userId));
    };
    window.addEventListener('ultrarag-enterprise-agent-scope-change', onScopeChange);
    return () => window.removeEventListener('ultrarag-enterprise-agent-scope-change', onScopeChange);
  }, [tenantContext, tenantId, tenantScopeKey, userId]);

  useEffect(() => {
    if (!tenantContext || !tenantId || !userId || !scopeReady || scopeKeyRef.current !== tenantScopeKey) return;
    const requestController = new AbortController();
    const generation = tenantContext.generation;
    const isCurrent = () => (
      !requestController.signal.aborted
      && tenantContext.isCurrentGeneration(generation)
      && scopeKeyRef.current === tenantScopeKey
    );
    let switchingAgent = false;
    setLoaded(false);
    setAgents([]);
    setSkills([]);
    setGeneralSkills([]);
    setKnowledgeBases([]);
    setModels([]);
    setTools([]);
    setSessions([]);
    setFeedbackSummary(null);
    setScheduledTasks([]);
    const agentQuery = agentId ? `?agent_id=${encodeURIComponent(agentId)}` : '';
    Promise.allSettled([
      tenantClient.get<AgentProfileRead[]>('/api/enterprise/agents', { signal: requestController.signal }),
      tenantClient.get<SkillRead[]>(`/api/enterprise/skills${agentQuery}`, { signal: requestController.signal }),
      tenantClient.get<GeneralSkillRead[]>(`/api/enterprise/general-skills${agentQuery}`, { signal: requestController.signal }),
      tenantClient.get<KnowledgeBaseRead[]>(`/api/enterprise/knowledge-bases${agentQuery}`, { signal: requestController.signal }),
      tenantClient.get<ModelConfigRead[]>('/api/enterprise/model-configs', { signal: requestController.signal }),
      tenantClient.get<ToolRead[]>(`/api/enterprise/tools${agentQuery}`, { signal: requestController.signal }),
      tenantClient.get<EnterpriseChatSessionRead[]>(`/api/enterprise/sessions${agentQuery}`, { signal: requestController.signal }),
      tenantClient.get<FeedbackSummaryRead>(`/api/enterprise/feedback/summary${agentQuery}`, { signal: requestController.signal }),
      tenantClient.get<ScheduledTaskRead[]>(`/api/enterprise/scheduled-tasks${agentQuery}`, { signal: requestController.signal }),
    ])
      .then(([agentResult, skillResult, generalSkillResult, kbResult, modelResult, toolResult, sessionResult, feedbackResult, taskResult]) => {
        if (!isCurrent()) return;
        const visibleAgents = agentResult.status === 'fulfilled'
          ? agentResult.value.filter((item) => canSelectCurrentEmployeeAgent(item, currentUser, {
          activeOnly: true,
          }))
          : [];
        setAgents(visibleAgents);
        if (modelResult.status === 'fulfilled') setModels(modelResult.value);
        if (agentResult.status === 'fulfilled' && (!agentId || !visibleAgents.some((item) => item.id === agentId))) {
          const manageableAgents = visibleAgents.filter((item) => canManageEmployeeAgent(item, currentUser));
          const next = isAdmin
            ? preferredEmployeeAgent(visibleAgents)?.id || ''
            : preferredEmployeeAgent(manageableAgents)?.id
              || preferredEmployeeAgent(visibleAgents)?.id
              || '';
          if (next) {
            switchingAgent = true;
            persistSharedAgentScope(next, tenantId, userId);
            emitAgentScopeChange(next);
            setAgentId(next);
            return;
          }
        }
        if (skillResult.status === 'fulfilled') setSkills(skillResult.value);
        if (generalSkillResult.status === 'fulfilled') setGeneralSkills(generalSkillResult.value);
        if (kbResult.status === 'fulfilled') setKnowledgeBases(kbResult.value);
        if (toolResult.status === 'fulfilled') setTools(toolResult.value);
        if (sessionResult.status === 'fulfilled') setSessions(sessionResult.value);
        if (feedbackResult.status === 'fulfilled') setFeedbackSummary(feedbackResult.value);
        if (taskResult.status === 'fulfilled') {
          setScheduledTasks(taskResult.value.filter((item) => item.status !== 'archived'));
        }
        const failure = [agentResult, skillResult, generalSkillResult, kbResult, modelResult, toolResult, sessionResult, feedbackResult, taskResult]
          .find((item) => item.status === 'rejected');
        if (failure) {
          notify.error(t('dashboard.page.toast.loadProfileFailed'));
        }
      })
      .finally(() => {
        if (isCurrent() && !switchingAgent) setLoaded(true);
      });
    return () => {
      requestController.abort();
    };
  }, [agentId, currentUser, isAdmin, scopeReady, t, tenantClient, tenantContext, tenantId, tenantScopeKey, userId]);

  const selectedAgent = agents.find((item) => item.id === agentId)
    || agents.find((item) => !item.is_overall)
    || null;
  const employeeSessions = selectedAgent?.is_overall
    ? sessions
    : sessions.filter((item) => item.agent_id === selectedAgent?.id);

  useEffect(() => {
    if (!tenantContext || !tenantId || !userId || !scopeReady || scopeKeyRef.current !== tenantScopeKey) return;
    const requestController = new AbortController();
    const generation = tenantContext.generation;
    const isCurrent = () => (
      !requestController.signal.aborted
      && tenantContext.isCurrentGeneration(generation)
      && scopeKeyRef.current === tenantScopeKey
    );
    async function loadWorkRecord() {
      if (!selectedAgent || selectedAgent.is_overall) {
        if (isCurrent()) setActivityEvents([]);
        return;
      }
      try {
        const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
        const workRecord = await tenantClient.get<AgentWorkRecordRead>(
          `/api/enterprise/agents/${encodeURIComponent(selectedAgent.id)}/work-record?timezone=${encodeURIComponent(timezone)}`,
          { signal: requestController.signal },
        );
        if (!isCurrent()) return;
        setActivityEvents(workRecord.events);
      } catch (error) {
        if (!isCurrent()) return;
        setActivityEvents([]);
        notify.error(dashboardErrorMessage(error, t('dashboard.page.toast.loadWorkRecordFailed'), t('common.error.generic')));
      }
    }
    void loadWorkRecord();
    return () => {
      requestController.abort();
    };
  }, [scopeReady, selectedAgent?.id, selectedAgent?.is_overall, t, tenantClient, tenantContext, tenantId, tenantScopeKey, userId]);

  const defaultModel = models.find((item) => item.is_default);
  const totalCalls = skills.reduce((sum, item) => sum + (item.total_call_count || item.call_count || 0), 0);
  const positiveFeedback = skills.reduce((sum, item) => sum + (item.total_positive_feedback_count || 0), 0);
  const negativeFeedback = skills.reduce((sum, item) => sum + (item.total_negative_feedback_count || 0), 0);
  const visibleKnowledgeBases = knowledgeBases.filter((item) => !isEmptyDefaultKnowledgeBase(item));

  // Avoid flashing the marketplace or permission empty state before the agent list resolves.
  if (!loaded && agents.length === 0) {
    return <div className="page dashboard-page" />;
  }

  if (!selectedAgent && !isAdmin) {
    return (
      <div className="page dashboard-page">
        <div className="empty-workspace-card p-[24px]">
          <h3 className="m-0 text-[20px] font-semibold text-foreground">{t('dashboard.page.empty.title')}</h3>
          <p className="mt-[8px] text-[14px] text-muted-foreground">{t('dashboard.page.empty.description')}</p>
          <div className="mt-[16px] flex gap-[8px]">
            <UiButton onClick={() => navigate('/enterprise/agents')}>{t('dashboard.page.empty.viewEmployees')}</UiButton>
            <UiButton variant="outline" onClick={() => navigate('/enterprise/feedback')}>{t('dashboard.page.empty.viewLogs')}</UiButton>
          </div>
        </div>
      </div>
    );
  }

  if (!selectedAgent || selectedAgent.is_overall) {
    return (
      <div className="page dashboard-page">
        <div className="page-title">
          <h3>{t('dashboard.page.marketplace.title')}</h3>
        </div>
        <section className="employee-hero org-hero">
          <div>
            <span className="section-kicker">{t('dashboard.page.marketplace.title')}</span>
            <h2 className="ui-typography">{t('dashboard.page.marketplace.title')}</h2>
            <p className="ui-typography">{t('dashboard.page.marketplace.description')}</p>
          </div>
          <div className="employee-hero-metrics">
            <MetricTile label={t('dashboard.page.metric.employees')} value={agents.filter((item) => !item.is_overall).length} />
            <MetricTile label={t('dashboard.page.metric.conversations')} value={sessions.length} />
            <MetricTile label={t('dashboard.page.metric.feedback')} value={feedbackSummary?.total_feedback || 0} />
          </div>
        </section>
        <div className="org-dashboard-grid">
          <DashboardStat title={t('dashboard.page.stat.sop')} value={skills.length} icon={<StaffdeckIcon name="filter" />} />
          <DashboardStat title={t('dashboard.page.stat.skills')} value={generalSkills.length} icon={<StaffdeckIcon name="spark" />} />
          <DashboardStat title={t('dashboard.page.stat.knowledge')} value={visibleKnowledgeBases.length} icon={<StaffdeckIcon name="file" />} />
          <DashboardStat title={t('dashboard.page.stat.tools')} value={tools.filter((item) => item.enabled).length} icon={<StaffdeckIcon name="tool" />} />
          <DashboardStat title={t('dashboard.page.stat.sopCalls')} value={totalCalls} icon={<StaffdeckIcon name="chat" />} />
          <DashboardStat title={t('dashboard.page.stat.positive')} value={positiveFeedback || feedbackSummary?.up_count || 0} icon={<StaffdeckIcon name="chat" />} />
          <DashboardStat title={t('dashboard.page.stat.negative')} value={negativeFeedback || feedbackSummary?.down_count || 0} icon={<StaffdeckIcon name="chat" />} />
          <div className="org-dashboard-card">
            <div className="ui-card-body p-[24px]">
              <span className="org-dashboard-icon"><StaffdeckIcon name="model" /></span>
              <span className="text-[13px] text-muted-foreground">{t('dashboard.page.defaultModel.label')}</span>
              <span className="text-[15px] text-foreground">
                {defaultModel
                  ? (
                    <>
                      <RawContent value={defaultModel.name} /> / <RawIdentifier value={defaultModel.model} />
                    </>
                  )
                  : t('dashboard.page.defaultModel.missing')}
              </span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const employee = employeeProfile(selectedAgent);
  const employeeCreator = employeeCreatorName(selectedAgent);
  const canEditSelectedAgent = canManageEmployeeAgent(selectedAgent, currentUser);
  const activeSkills = skills.filter((item) => item.status === 'published' && item.branch_status !== 'inactive');
  const activeGeneralSkills = generalSkills.filter((item) => item.status === 'published');
  const activeKnowledge = visibleKnowledgeBases.filter((item) => item.status === 'active');
  const activeTools = tools.filter((item) => item.enabled);
  const selectedKnowledgeCount = visibleKnowledgeBases.length;
  const selectedGeneralSkillCount = agentResourceCount(selectedAgent, 'general_skill');
  const selectedSkillCount = agentResourceCount(selectedAgent, 'skill');
  const employeeScheduledTasks = scheduledTasks.filter((item) => item.agent_id === selectedAgent.id && item.status !== 'archived');
  const activeScheduledTasks = employeeScheduledTasks.filter((item) => item.status === 'active');
  const dashboardMetrics = employeeDashboardMetrics(employeeSessions, feedbackSummary);
  const systemPromptSummary = typeof selectedAgent.metadata?.system_prompt_summary === 'string'
    ? selectedAgent.metadata.system_prompt_summary
    : '';
  const systemSummary = compactSummary(
    staffdeckDisplayText(
      selectedAgent.persona_prompt
      || systemPromptSummary
      || selectedAgent.description
      || fallbackSystemSummary(t, employee.roleName),
    ),
    132,
  );

  const heroActionButtonClass = 'inline-flex items-center justify-center gap-[4px] py-[8px] px-[12px] rounded-[14px] border-[0.5px] border-[#e3e7f1] bg-white text-[12px] font-normal text-[#858b9c] shadow-[0px_6px_6px_rgba(0,0,0,0.05)] hover:bg-[#f6f6f6] hover:text-[#858b9c]';
  const heroAvatar = (
    <EmployeeAvatar
      agent={selectedAgent}
      width={136}
      height={160}
      radius={0}
      fit="contain"
      objectPosition="center bottom"
      style={{ background: 'transparent', border: 'none', boxShadow: 'none', overflow: 'visible' }}
    />
  );

  return (
    <div className="min-h-full w-full min-w-0 max-w-full box-border px-[48px] pt-[32px] pb-[43px] max-[900px]:px-[16px]">
      <AppHeader
        onLogout={onLogout}
        userName={currentUser?.username}
        left={(
          <div className="flex flex-wrap items-center gap-x-9 gap-y-6 pt-1 pl-1">
            <div className="flex shrink-0 flex-col items-center">
              {canEditSelectedAgent ? (
                <button
                  type="button"
                  onClick={() => setAvatarEditorOpen(true)}
                  aria-label={t('dashboard.page.action.replaceAvatar')}
                  className="group relative block cursor-pointer border-0 bg-transparent p-0"
                >
                  {heroAvatar}
                  <span className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-center gap-1 bg-black/45 py-1 text-[11px] text-white opacity-0 transition-opacity group-hover:opacity-100">
                    <IconAccount className="size-3" />
                    {t('dashboard.page.action.replaceAvatar')}
                  </span>
                </button>
              ) : (
                heroAvatar
              )}
              <div className="flex items-center gap-4">
                <UiButton
                  variant="outline"
                  className={heroActionButtonClass}
                  onClick={() => { window.location.href = '/workspace/chat'; }}
                >
                  <IconChat className="size-[14px]" />
                  {t('dashboard.page.action.openChat')}
                </UiButton>
                {canEditSelectedAgent && (
                  <UiButton
                    variant="outline"
                    className={heroActionButtonClass}
                    onClick={() => setProfileEditorOpen(true)}
                  >
                    <IconEdit className="size-[14px]" />
                    {t('dashboard.page.action.editProfile')}
                  </UiButton>
                )}
              </div>
            </div>

            <div className="flex min-w-[280px] flex-1 flex-col gap-2">
              <div className="flex items-end gap-2">
                <h2 className="m-0 text-[22px] leading-none font-semibold text-[#18181a]">
                  <RawContent value={employeeDisplayName(selectedAgent)} />
                </h2>
                <span className="text-[13px] leading-none text-[#757f9c]">
                  <RawContent value={employee.roleName || employeeDisplayName(selectedAgent)} />
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-4">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-[#f6f6f6] px-2.5 py-0.5">
                  <span
                    className="size-1.5 rounded-full ring-[1.5px] ring-white"
                    style={{ background: selectedAgent.status === 'active' ? '#22c55e' : '#c4c9d4' }}
                  />
                  <span className="text-[12px] text-[#757f9c]">
                    {selectedAgent.status === 'active'
                      ? t('dashboard.page.status.online')
                      : t('dashboard.page.status.offline')}
                  </span>
                </span>
                <span className="text-[12px] text-[#757f9c]">
                  {t('dashboard.page.meta.createdBy', {
                    value: employeeCreator || t('dashboard.page.value.none'),
                  })}
                </span>
                <span className="text-[12px] text-[#757f9c]">
                  {t('dashboard.page.meta.onboardedAt', {
                    value: formatDashboardDate(employee.onboardedAt, locale, t('dashboard.page.value.none')),
                  })}
                </span>
                <div className="flex flex-wrap items-center gap-3">
                  {employee.workStyles.slice(0, 3).map((item) => (
                    <Badge
                      key={item}
                      variant="outline"
                      className="h-auto rounded-[10px] border-[0.5px] border-[#e3e7f1] px-4 py-1 text-[12px] font-normal text-[#757f9c]"
                    >
                      <RawContent value={item} />
                    </Badge>
                  ))}
                </div>
              </div>

              <p className="m-0 line-clamp-2 max-w-[720px] text-[14px] leading-[22px] text-[#757f9c]">
                <RawContent value={systemSummary} />
              </p>

              <div className="flex w-full max-w-[514px] gap-3">
                <HeroMetric value={selectedKnowledgeCount} label={t('dashboard.page.hero.knowledge')} />
                <HeroMetric value={selectedGeneralSkillCount} label={t('dashboard.page.hero.skills')} />
                <HeroMetric value={selectedSkillCount} label={t('dashboard.page.hero.sop')} />
                <HeroMetric value={activeScheduledTasks.length} label={t('dashboard.page.hero.scheduled')} />
              </div>
            </div>
          </div>
        )}
      />
      <EmployeeProfileTabs activeKey={profileTab} />
      {profileTab === 'work' && (
        <>
          <WorkRecordTab
            selectedAgent={selectedAgent}
            activeKnowledge={activeKnowledge}
            activeGeneralSkills={activeGeneralSkills}
            activeSkills={activeSkills}
            activeTools={activeTools}
            activeScheduledTasks={activeScheduledTasks}
            employeeSessions={employeeSessions}
            conversationCount={dashboardMetrics.conversationCount}
            activityEvents={activityEvents}
            feedbackCount={dashboardMetrics.feedbackCount}
            positiveRate={dashboardMetrics.positiveRate}
            negativeRate={dashboardMetrics.negativeRate}
          />
          {canEditSelectedAgent && <EvolutionPanel agentId={selectedAgent.id} />}
        </>
      )}
      {profileTab === 'scheduled' && <ScheduledTasksTab />}
      {profileTab === 'memories' && <MemoriesTab currentUser={currentUser} agent={selectedAgent} />}
      {profileTab === 'logs' && <ConversationLogsTab />}
      <EmployeeAvatarEditor
        agent={selectedAgent}
        open={avatarEditorOpen}
        onClose={() => setAvatarEditorOpen(false)}
        onSaved={(saved) => setAgents((current) => current.map((item) => (item.id === saved.id ? saved : item)))}
      />
      <EmployeeProfileEditor
        agent={selectedAgent}
        open={profileEditorOpen}
        currentUser={currentUser}
        onClose={() => setProfileEditorOpen(false)}
        onSaved={(saved) => setAgents((current) => current.map((item) => (item.id === saved.id ? saved : item)))}
      />
    </div>
  );
}

function DashboardStat({ title, value, icon }: { title: ReactNode; value: number; icon: ReactNode }) {
  return (
    <div className="org-dashboard-card">
      <div className="ui-card-body p-[24px]">
        <span className="org-dashboard-icon">{icon}</span>
        <span className="text-[13px] text-muted-foreground">{title}</span>
        <strong>{value}</strong>
      </div>
    </div>
  );
}

function isEmptyDefaultKnowledgeBase(item: KnowledgeBaseRead): boolean {
  const hasRuntimeKnowledge = item.document_count > 0 || item.bucket_count > 0 || item.chunk_count > 0;
  if (!hasRuntimeKnowledge && item.metadata?.created_from_document_upload && !item.metadata?.source_document_id) {
    return true;
  }
  return (
    item.name === '默认知识库'
    && item.document_count === 0
    && item.bucket_count === 0
    && item.chunk_count === 0
  );
}

function MetricTile({ label, value }: { label: ReactNode; value: number }) {
  return (
    <div className="employee-metric-tile">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

/** 为员工仪表盘 tabs 注入当前 locale 的语义标签，保持路由和 chrome 一致。 */
function EmployeeProfileTabs({ activeKey = 'work' }: { activeKey?: ProfileTabKey }) {
  const { t } = useAppIntl();
  const navigate = useNavigate();
  const labels: Record<ProfileTabKey, string> = {
    work: t('dashboard.page.tab.work'),
    scheduled: t('dashboard.page.tab.scheduled'),
    memories: t('dashboard.page.tab.memories'),
    logs: t('dashboard.page.tab.logs'),
  };
  return (
    <Tabs
      value={activeKey}
      onValueChange={(value) => {
        const tab = PROFILE_TABS.find((item) => item.key === value);
        if (tab && value !== activeKey) navigate(tab.route);
      }}
      className="flex w-full flex-col items-center"
    >
      <TabsList
        aria-label={t('dashboard.page.profileSections')}
        className="h-[35px]! w-[504px] max-w-full gap-2 rounded-none bg-transparent p-0"
      >
        {PROFILE_TABS.map(({ key, Icon }) => (
          <TabsTrigger
            key={key}
            value={key}
            className="h-[35px] flex-1 gap-[7px] rounded-t-lg rounded-b-none border-0 text-[14px] font-bold text-[#8b94aa] hover:text-[#202226] data-[state=active]:bg-white data-[state=active]:text-[#202226] data-[state=active]:shadow-[0_-12px_28px_rgba(21,26,38,0.04)] in-data-[theme=dark]:text-[#8f98aa] in-data-[theme=dark]:hover:text-[#f0f2f6] in-data-[theme=dark]:data-[state=active]:bg-[#202126] in-data-[theme=dark]:data-[state=active]:text-[#c5ccd8] in-data-[theme=dark]:data-[state=active]:shadow-none"
          >
            <Icon />
            {labels[key]}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

function HeroMetric({ label, value }: { label: ReactNode; value: number }) {
  return (
    <div className="flex flex-1 items-end gap-1 rounded-[10px] bg-[#f6f6f6] px-5 py-2">
      <strong className="text-[14px] leading-none font-medium text-[#18181a]">{value}</strong>
      <span className="text-[12px] leading-none text-[#464c5e]">{label}</span>
    </div>
  );
}

/** 规整员工简介摘要，避免长原文撑破档案头部布局。 */
function compactSummary(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
}
