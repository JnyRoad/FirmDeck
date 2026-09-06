import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronRight, MessageCircle } from 'lucide-react';

import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  Input,
  Textarea,
} from '@/components/ui';
import { createToastNotifier } from '@/components/ui/app-toast';
import { createAppTranslator, useAppIntl, type AppLocale, type AppTranslator, type MessageId, type MessageValues } from '@/i18n';
import { createMessageDescriptor } from '@/i18n/descriptors';
import { RawContent, RawIdentifier } from '@/i18n/RawContent';

import IconPlus from '../assets/icons/plus.svg?react';
import IconTrash from '../assets/icons/trash.svg?react';

import { createTenantClient } from '../api/tenant-client';
import type { EnterpriseAuthUser } from '../auth';
import { useTenantSession } from '../contexts/TenantSessionContext';
import AppHeader from '../components/AppHeader';
import { ConfirmDialog } from '../components/ConfirmDialog';
import EmployeeAvatar from '../components/EmployeeAvatar';
import { EnterpriseRoute } from '../enums/routes';
import { getClientTimeZone, parseBackendDateTime } from '../lib/timezone';
import type { AgentProfileRead, KnowledgeBaseRead, TeamRead, TeamThreadRead } from '../types';

type TeamMessageId = MessageId;

export type TeamTranslate = (id: TeamMessageId, values?: MessageValues) => string;

/** 将受控 AppTranslator 扩展为本页面待补目录键的类型安全适配器；不改变 locale 状态。 */
function createTeamTranslator(translator: Pick<AppTranslator, 't'>): TeamTranslate {
  return (id, values) => translator.t(id, values);
}

/** 为页面外的纯格式化函数提供中文兼容 translator；组件内调用方应显式传入当前 locale。 */
function defaultTeamTranslator(): TeamTranslate {
  return createTeamTranslator(createAppTranslator('zh-CN'));
}

/** 将团队状态码投影为本地化产品文案；未知状态保持后端原始枚举以便诊断。 */
export function teamStatusLabel(status: string, translate: TeamTranslate = defaultTeamTranslator()): string {
  if (status === 'active') return translate('teamsPage.status.active');
  if (status === 'archived') return translate('teamsPage.status.archived');
  return status;
}

/** 将任务状态码投影为本地化产品文案；未知状态保持原始枚举而不猜测含义。 */
export function taskStatusLabel(status: string, translate: TeamTranslate = defaultTeamTranslator()): string {
  if (status === 'bidding') return translate('teamsPage.taskStatus.bidding');
  if (status === 'pending') return translate('teamsPage.taskStatus.pending');
  if (status === 'in_progress') return translate('teamsPage.taskStatus.inProgress');
  if (status === 'review') return translate('teamsPage.taskStatus.review');
  if (status === 'done') return translate('teamsPage.taskStatus.done');
  if (status === 'rework') return translate('teamsPage.taskStatus.rework');
  if (status === 'escalated') return translate('teamsPage.taskStatus.escalated');
  return status;
}

/** 按当前语言、客户端时区和注册消息格式化相对时间；无效输入返回空字符串。 */
export function relativeTimeLabel(
  iso: string,
  locale: AppLocale = 'zh-CN',
  translate: TeamTranslate = createTeamTranslator(createAppTranslator(locale)),
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

/** 读取团队项目领导的原始员工名；缺失时返回空值，由渲染层本地化占位文案。 */
export function teamLeaderName(team: TeamRead): string {
  const leader = (team.members || []).find((member) => member.role === 'leader');
  return leader?.agent_name || '';
}

export type TeamThreadTaskGroup = {
  taskId: string;
  title: string;
  status: string | null;
  latestAt: string;
  threads: TeamThreadRead[];
};

export type TeamThreadTree = {
  teamId: string;
  teamName: string;
  latestAt: string;
  tlThreads: TeamThreadRead[];
  tasks: TeamThreadTaskGroup[];
};

const THREAD_TASK_PREFIXES = ['团队任务验收:', '团队任务验收：', '团队任务:', '团队任务：', '团队竞标:', '团队竞标：'];

function stripThreadPrefix(title: string): string {
  for (const prefix of THREAD_TASK_PREFIXES) {
    if (title.startsWith(prefix)) return title.slice(prefix.length);
  }
  return title;
}

function latestOf(items: TeamThreadRead[]): string {
  return items.reduce((latest, item) => {
    const time = parseBackendDateTime(item.updated_at).getTime();
    return time > parseBackendDateTime(latest).getTime() ? item.updated_at : latest;
  }, items[0]?.updated_at ?? '');
}

/** 把平铺的团队线程组装成 团队 → 任务 → 线程 的树，供动态区树状展示。 */
export function buildThreadTree(threads: TeamThreadRead[]): TeamThreadTree[] {
  const byTeam = new Map<string, TeamThreadRead[]>();
  for (const thread of threads) {
    const list = byTeam.get(thread.team_id) || [];
    list.push(thread);
    byTeam.set(thread.team_id, list);
  }
  const tree: TeamThreadTree[] = [];
  for (const [teamId, teamThreads] of byTeam) {
    const tlThreads = teamThreads
      .filter((thread) => !thread.task_id)
      .sort((a, b) => parseBackendDateTime(b.updated_at).getTime() - parseBackendDateTime(a.updated_at).getTime());
    const byTask = new Map<string, TeamThreadRead[]>();
    for (const thread of teamThreads) {
      if (!thread.task_id) continue;
      const list = byTask.get(thread.task_id) || [];
      list.push(thread);
      byTask.set(thread.task_id, list);
    }
    const tasks: TeamThreadTaskGroup[] = [];
    for (const [taskId, taskThreads] of byTask) {
      taskThreads.sort(
        (a, b) => parseBackendDateTime(b.updated_at).getTime() - parseBackendDateTime(a.updated_at).getTime(),
      );
      const titled = taskThreads.find((thread) => thread.title.startsWith('团队任务')) || taskThreads[0];
      tasks.push({
        taskId,
        title: stripThreadPrefix(titled.title),
        status: taskThreads.find((thread) => thread.task_status)?.task_status ?? null,
        latestAt: latestOf(taskThreads),
        threads: taskThreads,
      });
    }
    tasks.sort((a, b) => parseBackendDateTime(b.latestAt).getTime() - parseBackendDateTime(a.latestAt).getTime());
    tree.push({
      teamId,
      teamName: teamThreads[0]?.team_name || teamId,
      latestAt: latestOf(teamThreads),
      tlThreads,
      tasks,
    });
  }
  tree.sort((a, b) => parseBackendDateTime(b.latestAt).getTime() - parseBackendDateTime(a.latestAt).getTime());
  return tree;
}

export default function TeamsPage({
  currentUser,
  onLogout,
}: {
  currentUser?: EnterpriseAuthUser;
  isAdmin?: boolean;
  onLogout?: () => void;
}) {
  const tenantContext = useTenantSession();
  const tenantApi = useMemo(() => createTenantClient(tenantContext), [tenantContext]);
  const [teams, setTeams] = useState<TeamRead[]>([]);
  const [threads, setThreads] = useState<TeamThreadRead[]>([]);
  const [agents, setAgents] = useState<AgentProfileRead[]>([]);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [sharedKnowledgeBases, setSharedKnowledgeBases] = useState<KnowledgeBaseRead[]>([]);
  const [selectedKnowledgeBaseIds, setSelectedKnowledgeBaseIds] = useState<string[]>([]);
  const [defaultKnowledgeSelection, setDefaultKnowledgeSelection] = useState('');
  const [newSharedKnowledgeName, setNewSharedKnowledgeName] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<TeamRead | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [startingTeamId, setStartingTeamId] = useState('');
  const [expandedTeams, setExpandedTeams] = useState<Set<string> | null>(null);
  const navigate = useNavigate();
  const { t: appT, locale } = useAppIntl();
  const t = useMemo(() => createTeamTranslator({ t: appT }), [appT]);
  const toast = useMemo(() => createToastNotifier({ t: appT }), [appT]);

  const threadTree = buildThreadTree(threads);
  const numberFormatter = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  // 每个团队的实时任务概况（threads 按 updated_at 倒序，同任务首次出现即最新状态）
  const teamTaskCounts = new Map<string, { active: number; attention: number }>();
  {
    const seen = new Set<string>();
    for (const thread of threads) {
      if (!thread.task_id || !thread.task_status) continue;
      const key = `${thread.team_id}:${thread.task_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const counts = teamTaskCounts.get(thread.team_id) || { active: 0, attention: 0 };
      if (['pending', 'bidding', 'in_progress'].includes(thread.task_status)) counts.active += 1;
      else if (thread.task_status === 'review' || thread.task_status === 'escalated') counts.attention += 1;
      teamTaskCounts.set(thread.team_id, counts);
    }
  }
  // 默认只展开最新动态的团队，避免动态刷屏
  const expanded = expandedTeams ?? new Set(threadTree.slice(0, 1).map((node) => node.teamId));

  /** 切换团队动态树节点的展开状态；只修改本地折叠状态。 */
  function toggleTeamExpand(teamId: string) {
    const next = new Set(expanded);
    if (next.has(teamId)) next.delete(teamId);
    else next.add(teamId);
    setExpandedTeams(next);
  }

  /** 渲染线程树中的一行；线程标题和团队数据保持原始内容。 */
  function renderThreadRow(thread: TeamThreadRead) {
    return (
      <button
        key={`${thread.kind}:${thread.session_id}:${thread.task_id || ''}`}
        type="button"
        onClick={() => openThread(thread)}
        className="flex w-full items-center gap-[8px] rounded-[10px] px-[10px] py-[8px] text-left transition-colors hover:bg-[#f6f7fa]"
      >
        <Badge
          variant="secondary"
          className={
            thread.kind === 'tl_chat'
              ? 'shrink-0 rounded-full bg-[#e8f0ff] text-[12px] font-normal text-[#1a71ff]'
              : 'shrink-0 rounded-full bg-[#f2f3f7] text-[12px] font-normal text-[#464c5e]'
          }
        >
          {thread.kind === 'tl_chat' ? t('teamsPage.activity.leaderChat') : t('teamsPage.activity.task')}
        </Badge>
        <span className="min-w-0 flex-1 truncate text-[13px] text-[#18181a]" title={thread.title}>
          <RawContent value={thread.title} />
        </span>
        <span className="shrink-0 text-[12px] text-[#a7adbb]">{relativeTimeLabel(thread.updated_at, locale, t)}</span>
      </button>
    );
  }

  async function load() {
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return;
    setLoading(true);
    try {
      const rows = await tenantApi.get<TeamRead[]>('/api/enterprise/teams');
      if (!context.isCurrentGeneration(generation)) return;
      setTeams(rows);
    } catch (error) {
      if (!context.isCurrentGeneration(generation)) return;
      toast.error(createMessageDescriptor('teamsPage.toast.loadFailed'));
    } finally {
      if (context.isCurrentGeneration(generation)) setLoading(false);
    }
  }

  useEffect(() => {
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return undefined;
    void load();
    void loadThreads();
    // 员工列表仅用于团队卡片的成员头像映射，失败不影响主流程
    tenantApi
      .get<AgentProfileRead[]>('/api/enterprise/agents')
      .then((rows) => {
        if (context.isCurrentGeneration(generation)) setAgents(rows);
      })
      .catch(() => {
        if (context.isCurrentGeneration(generation)) setAgents([]);
      });
    tenantApi
      .get<KnowledgeBaseRead[]>('/api/enterprise/knowledge-bases')
      .then((rows) => {
        if (context.isCurrentGeneration(generation)) {
          setSharedKnowledgeBases(rows.filter((row) => row.mode === 'shared'));
        }
      })
      .catch(() => {
        if (context.isCurrentGeneration(generation)) setSharedKnowledgeBases([]);
      });
    return undefined;
  }, [tenantApi, tenantContext, toast]);

  async function loadThreads() {
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return;
    try {
      const rows = await tenantApi.get<TeamThreadRead[]>('/api/enterprise/team-threads');
      if (!context.isCurrentGeneration(generation)) return;
      setThreads(rows);
    } catch {
      if (context.isCurrentGeneration(generation)) setThreads([]);
    }
  }

  function openThread(thread: TeamThreadRead) {
    if (thread.kind === 'tl_chat') {
      navigate(`${EnterpriseRoute.Chat}/${thread.session_id}`);
      return;
    }
    const base = `${EnterpriseRoute.Teams}/${thread.team_id}`;
    navigate(thread.task_id ? `${base}?task=${thread.task_id}` : base);
  }

  async function startTeamChat(team: TeamRead) {
    if (startingTeamId) return;
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return;
    setStartingTeamId(team.id);
    try {
      const result = await tenantApi.post<{ session_id: string }>(
        `/api/enterprise/teams/${team.id}/tl/session`,
      );
      if (!context.isCurrentGeneration(generation)) return;
      if (!result.session_id) throw new Error('TEAM_SESSION_MISSING');
      navigate(`${EnterpriseRoute.Chat}/${result.session_id}`);
    } catch (error) {
      if (!context.isCurrentGeneration(generation)) return;
      toast.error(createMessageDescriptor('teamsPage.toast.startFailed'));
    } finally {
      if (context.isCurrentGeneration(generation)) setStartingTeamId('');
    }
  }

  async function createTeam() {
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return;
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error(createMessageDescriptor('teamsPage.toast.createRequired'));
      return;
    }
    setCreating(true);
    try {
      const knowledgeBases: Array<{
        existing_knowledge_base_id?: string;
        create_shared?: { name: string };
        is_default: boolean;
      }> = selectedKnowledgeBaseIds.map((knowledgeBaseId) => ({
        existing_knowledge_base_id: knowledgeBaseId,
        is_default: defaultKnowledgeSelection === `existing:${knowledgeBaseId}`,
      }));
      const newSharedName = newSharedKnowledgeName.trim();
      if (newSharedName) {
        knowledgeBases.push({
          create_shared: { name: newSharedName },
          is_default: defaultKnowledgeSelection === 'new',
        });
      }
      await tenantApi.post<TeamRead>('/api/enterprise/teams', {
        name: trimmed,
        description: description.trim() || undefined,
        knowledge_bases: knowledgeBases,
      });
      if (!context.isCurrentGeneration(generation)) return;
      toast.success(createMessageDescriptor('teamsPage.toast.created'));
      setCreateOpen(false);
      setName('');
      setDescription('');
      setSelectedKnowledgeBaseIds([]);
      setDefaultKnowledgeSelection('');
      setNewSharedKnowledgeName('');
      await load();
    } catch (error) {
      if (!context.isCurrentGeneration(generation)) return;
      toast.error(createMessageDescriptor('teamsPage.toast.createFailed'));
    } finally {
      if (context.isCurrentGeneration(generation)) setCreating(false);
    }
  }

  async function confirmDelete() {
    const target = deleteTarget;
    if (!target) return;
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return;
    setDeleting(true);
    try {
      await tenantApi.delete(`/api/enterprise/teams/${target.id}`);
      if (!context.isCurrentGeneration(generation)) return;
      toast.success(createMessageDescriptor('teamsPage.toast.deleted'));
      setDeleteTarget(null);
      await load();
    } catch (error) {
      if (!context.isCurrentGeneration(generation)) return;
      toast.error(createMessageDescriptor('teamsPage.toast.deleteFailed'));
    } finally {
      if (context.isCurrentGeneration(generation)) setDeleting(false);
    }
  }

  return (
    <div className="min-h-full box-border px-[48px] pt-[32px] pb-[43px] max-[900px]:px-[16px]" aria-busy={loading}>
      <AppHeader
        onLogout={onLogout}
        userName={currentUser?.username}
        title={t('teamsPage.title')}
        description={t('teamsPage.description')}
      />

      {(() => {
        const totalMembers = teams.reduce((sum, team) => sum + (team.members || []).length, 0);
        // threads 按 updated_at 倒序，task 首次出现即最新状态
        const latestTaskStatus = new Map<string, string>();
        for (const thread of threads) {
          if (thread.task_id && thread.task_status && !latestTaskStatus.has(thread.task_id)) {
            latestTaskStatus.set(thread.task_id, thread.task_status);
          }
        }
        const statuses = [...latestTaskStatus.values()];
        const activeTasks = statuses.filter((status) => ['pending', 'bidding', 'in_progress'].includes(status)).length;
        const attentionTasks = statuses.filter((status) => status === 'review' || status === 'escalated').length;
        const summaryCardClass =
          'flex h-[100px] flex-1 basis-[220px] items-center gap-[16px] rounded-[20px] bg-[#f6f6f6] px-[32px] py-[20px] text-left transition-shadow';
        const summaryStats = [
          { key: 'all', value: teams.length, label: t('teamsPage.stats.total'), sub: t('teamsPage.stats.totalMembers', { count: totalMembers }) },
          { key: 'active', value: activeTasks, label: t('teamsPage.stats.activeTasks'), sub: t('teamsPage.stats.activeSubtitle') },
          { key: 'attention', value: attentionTasks, label: t('teamsPage.stats.attention'), sub: t('teamsPage.stats.attentionSubtitle') },
        ];
        return (
          <div className="my-[36px] flex flex-wrap items-stretch gap-[20px]" aria-label={t('teamsPage.statistics')}>
            {summaryStats.map((stat) => (
              <div key={stat.key} className={summaryCardClass}>
                <span className="shrink-0 text-[34px] font-semibold leading-none text-[#18181A]">{numberFormatter.format(stat.value)}</span>
                <span className="flex min-w-0 flex-col gap-[4px]">
                  <span className="whitespace-nowrap text-[14px] text-[#464C5E]">{stat.label}</span>
                  <span className="whitespace-nowrap text-[12px] text-[#757F9C]">{stat.sub}</span>
                </span>
              </div>
            ))}
            <button
              data-guide-target="teams-create"
              type="button"
              onClick={() => setCreateOpen(true)}
              className={`${summaryCardClass} hover:shadow-[0_16px_30px_0_rgba(0,0,0,0.10)]`}
            >
              <span className="grid size-[38px] shrink-0 place-items-center text-[#18181A]">
                <IconPlus className="size-[38px]" />
              </span>
              <span className="flex min-w-0 flex-col gap-[4px]">
                <span className="whitespace-nowrap text-[14px] text-[#464C5E]">{t('teamsPage.createCard.title')}</span>
                <span className="whitespace-nowrap text-[12px] text-[#757F9C]">{t('teamsPage.createCard.subtitle')}</span>
              </span>
            </button>
          </div>
        );
      })()}

      <div className="mt-[16px] grid grid-cols-1 content-start gap-[20px] sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
        {teams.map((team) => {
          const members = team.members || [];
          const leader = members.find((member) => member.role === 'leader') || null;
          const ordered = leader ? [leader, ...members.filter((member) => member.id !== leader.id)] : members;
          const stacked = ordered.slice(0, 4);
          const extraCount = members.length - stacked.length;
          const counts = teamTaskCounts.get(team.id) || { active: 0, attention: 0 };
          return (
            <div
              key={team.id}
              role="button"
              tabIndex={0}
              onClick={() => navigate(`${EnterpriseRoute.Teams}/${team.id}`)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  navigate(`${EnterpriseRoute.Teams}/${team.id}`);
                }
              }}
              className="group cursor-pointer rounded-[20px] bg-white p-[20px] shadow-[0_0_6px_rgba(0,0,0,0.05)] transition-all duration-200 hover:-translate-y-[2px] hover:shadow-[0_18px_36px_-12px_rgba(70,76,94,0.28)] active:translate-y-0 active:scale-[0.99]"
            >
              {/* 成员合影：项目领导居大带标记，悬浮时成员扇形散开 */}
              <div className="flex items-end justify-between">
                <div className="flex items-end">
                  {stacked.map((member, index) => {
                    const isLeader = leader?.id === member.id;
                    const memberAgent = agents.find((agent) => agent.id === member.agent_id) || null;
                    return (
                      <span
                        key={member.id}
                        className={index > 0 ? '-ml-[16px] transition-all duration-200 group-hover:-ml-[8px]' : ''}
                      >
                        <span className="relative block overflow-hidden rounded-full bg-[#f1f2f5] ring-[3px] ring-white">
                          <EmployeeAvatar agent={memberAgent} size={isLeader ? 64 : 44} />
                          {isLeader && (
                            <span className="absolute bottom-[2px] right-[2px] inline-flex h-[18px] items-center rounded-full bg-[#fff3d6] px-[5px] text-[10px] font-medium leading-none text-[#a16a00] ring-2 ring-white">
                              {t('teamsPage.role.leader')}
                            </span>
                          )}
                        </span>
                      </span>
                    );
                  })}
                  {extraCount > 0 && (
                    <span className="-ml-[16px] grid size-[44px] place-items-center rounded-full bg-[#f2f3f7] text-[12px] text-[#464c5e] ring-[3px] ring-white transition-all duration-200 group-hover:-ml-[8px]">
                      {`+${extraCount}`}
                    </span>
                  )}
                </div>
                <Badge
                  variant="secondary"
                  className="shrink-0 rounded-full bg-[#f2f3f7] text-[12px] font-normal text-[#464c5e]"
                >
                  {teamStatusLabel(team.status, t)}
                </Badge>
              </div>

              <div className="mt-[14px] flex flex-col gap-[10px]">
                <span className="min-w-0 truncate text-[16px] font-medium tracking-[-0.01em] text-[#18181a]" title={team.name}>
                  <RawIdentifier value={team.name} />
                </span>
                <p className="line-clamp-2 min-h-[34px] text-[12px] leading-[17px] text-[#757f9c]">
                  {team.description ? <RawContent value={team.description} /> : t('teamsPage.card.noDescription')}
                </p>
                <div className="flex flex-wrap items-center gap-[6px]">
                  <span className="rounded-full bg-[#f2f3f7] px-[8px] py-[3px] text-[11px] leading-none text-[#464c5e]">
                    {t('teamsPage.card.memberCount', { count: members.length })}
                  </span>
                  {counts.active > 0 && (
                    <span className="rounded-full bg-[#e8f0ff] px-[8px] py-[3px] text-[11px] leading-none text-[#1a71ff]">
                      {t('teamsPage.card.activeCount', { count: counts.active })}
                    </span>
                  )}
                  {counts.attention > 0 && (
                    <span className="rounded-full bg-[#fff3d6] px-[8px] py-[3px] text-[11px] leading-none text-[#a16a00]">
                      {t('teamsPage.card.attentionCount', { count: counts.attention })}
                    </span>
                  )}
                </div>
                <div className="flex items-center justify-between gap-[10px] border-t border-[#f2f4f8] pt-[10px]">
                  <span className="min-w-0 truncate text-[12px] text-[#757f9c]">
                    <span>
                      {t('teamsPage.card.leaderPrefix')}
                      {leader?.agent_name ? <RawIdentifier value={leader.agent_name} /> : t('teamsPage.card.noLeader')}
                    </span>
                  </span>
                  <div className="flex shrink-0 items-center gap-[4px]">
                    <button
                      type="button"
                      aria-label={t('teamsPage.action.startChatAria', { teamName: team.name })}
                      disabled={Boolean(startingTeamId)}
                      onClick={(event) => {
                        event.stopPropagation();
                        void startTeamChat(team);
                      }}
                      className="inline-flex h-[30px] items-center gap-[5px] rounded-[9px] bg-primary px-[10px] text-[11px] text-white transition-colors hover:bg-primary/80 disabled:cursor-wait disabled:opacity-50"
                    >
                      <MessageCircle className="size-[13px]" />
                      {startingTeamId === team.id ? t('teamsPage.action.startingChat') : t('teamsPage.action.startChat')}
                    </button>
                    <button
                      type="button"
                      aria-label={t('teamsPage.action.deleteAria', { teamName: team.name })}
                      onClick={(event) => {
                        event.stopPropagation();
                        setDeleteTarget(team);
                      }}
                      className="inline-grid size-[28px] shrink-0 place-items-center rounded-[8px] text-[#c3c9d6] transition-colors hover:bg-[#fce7e7] hover:text-[#f5483b]"
                    >
                      <IconTrash className="size-[14px]" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
        {!loading && teams.length === 0 && (
          <div className="col-span-full flex h-[200px] items-center justify-center rounded-[20px] border border-dashed border-[#e4e9f2] bg-[#fbfcfe] text-[14px] text-[#7f879a]">
            {t('teamsPage.empty')}
          </div>
        )}
      </div>

      <section aria-label={t('teamsPage.activity.title')} className="mt-[24px] rounded-[20px] bg-white p-[20px] shadow-[0_0_6px_rgba(0,0,0,0.05)]">
        <h2 className="mb-[12px] text-[16px] font-medium text-[#18181a]">{t('teamsPage.activity.title')}</h2>
        <div className="flex flex-col gap-[8px]">
          {threadTree.map((node) => {
            const isExpanded = expanded.has(node.teamId);
            const threadCount = node.tlThreads.length + node.tasks.reduce((sum, task) => sum + task.threads.length, 0);
            return (
              <div key={node.teamId} className="rounded-[12px] border border-[#eef1f6]">
                <div className="flex items-center gap-[8px] px-[12px] py-[10px]">
                  <button
                    type="button"
                    aria-label={isExpanded
                      ? t('teamsPage.activity.collapse', { teamName: node.teamName })
                      : t('teamsPage.activity.expand', { teamName: node.teamName })}
                    onClick={() => toggleTeamExpand(node.teamId)}
                    className="inline-grid size-[24px] shrink-0 place-items-center rounded-[8px] text-[#858b9c] transition-colors hover:bg-[#eef1f6]"
                  >
                    {isExpanded ? <ChevronDown className="size-[14px]" /> : <ChevronRight className="size-[14px]" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => navigate(`${EnterpriseRoute.Teams}/${node.teamId}`)}
                    className="min-w-0 flex-1 truncate text-left text-[14px] font-medium text-[#18181a] hover:text-[#1a71ff]"
                    title={node.teamName}
                  >
                    <RawIdentifier value={node.teamName} />
                  </button>
                  <Badge variant="secondary" className="shrink-0 rounded-full bg-[#f2f3f7] text-[12px] font-normal text-[#464c5e]">
                    {t('teamsPage.activity.counts', { taskCount: node.tasks.length, threadCount })}
                  </Badge>
                  <span className="shrink-0 text-[12px] text-[#a7adbb]">{relativeTimeLabel(node.latestAt, locale, t)}</span>
                </div>
                {isExpanded && (
                  <div className="flex flex-col gap-[4px] border-t border-[#f2f4f8] px-[12px] py-[8px]">
                    {node.tlThreads.map((thread) => renderThreadRow(thread))}
                    {node.tasks.map((task) => (
                      <div key={task.taskId} className="flex flex-col gap-[2px]">
                        <button
                          type="button"
                          onClick={() => navigate(`${EnterpriseRoute.Teams}/${node.teamId}?task=${task.taskId}`)}
                          className="flex w-full items-center gap-[8px] rounded-[10px] bg-[#fafbfd] px-[10px] py-[8px] text-left transition-colors hover:bg-[#f2f4f9]"
                        >
                          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[#464c5e]" title={task.title}>
                            <RawContent value={task.title} />
                          </span>
                          {task.status && (
                            <Badge variant="secondary" className="shrink-0 rounded-full bg-[#f2f3f7] text-[12px] font-normal text-[#464c5e]">
                              {taskStatusLabel(task.status, t)}
                            </Badge>
                          )}
                          <span className="shrink-0 text-[12px] text-[#a7adbb]">{relativeTimeLabel(task.latestAt, locale, t)}</span>
                        </button>
                        <div className="ml-[16px] flex flex-col gap-[2px] border-l border-[#eef1f6] pl-[8px]">
                          {task.threads.map((thread) => renderThreadRow(thread))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {threadTree.length === 0 && (
            <p className="py-[12px] text-center text-[12px] text-[#a7adbb]">{t('teamsPage.activity.empty')}</p>
          )}
        </div>
      </section>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="flex max-h-[calc(100dvh-32px)] w-[calc(100%-32px)] flex-col gap-0 overflow-hidden rounded-[16px] p-0 sm:max-w-[480px]">
          <DialogTitle className="shrink-0 px-[24px] py-[16px] text-[16px] font-semibold text-foreground">
            {t('teamsPage.dialog.createTitle')}
          </DialogTitle>
          <div className="flex min-h-0 flex-1 flex-col gap-[12px] overflow-y-auto px-[24px] pb-[16px]">
            <label className="flex flex-col gap-[6px] text-[12px] text-[#464c5e]">
              {t('teamsPage.dialog.teamNameLabel')}
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t('teamsPage.dialog.teamNamePlaceholder')}
                aria-label={t('teamsPage.dialog.teamNameLabel')}
              />
            </label>
            <section
              aria-label={t('teamsPage.dialog.knowledgeLabel')}
              className="rounded-[12px] border border-[#e7eaf1] bg-[#fafbfd] p-[12px]"
            >
              <div>
                <h3 className="text-[13px] font-medium text-[#18181a]">{t('teamsPage.dialog.knowledgeTitle')}</h3>
                <p className="mt-[2px] text-[11px] leading-[17px] text-[#858b9c]">
                  {t('teamsPage.dialog.knowledgeDescription')}
                </p>
              </div>
              <div className="mt-[10px] flex flex-col gap-[7px]">
                {sharedKnowledgeBases.map((knowledgeBase) => {
                  const selected = selectedKnowledgeBaseIds.includes(knowledgeBase.id);
                  return (
                    <div
                      key={knowledgeBase.id}
                      className="flex items-center justify-between gap-[10px] rounded-[9px] bg-white px-[9px] py-[7px]"
                    >
                      <label className="flex min-w-0 items-center gap-[7px] text-[12px] text-[#464c5e]">
                        <input
                          type="checkbox"
                          aria-label={t('teamsPage.dialog.selectKnowledge', { knowledgeBaseName: knowledgeBase.name })}
                          checked={selected}
                          onChange={(event) => {
                            setSelectedKnowledgeBaseIds((current) => (
                              event.target.checked
                                ? [...current, knowledgeBase.id]
                                : current.filter((id) => id !== knowledgeBase.id)
                            ));
                            if (!event.target.checked && defaultKnowledgeSelection === `existing:${knowledgeBase.id}`) {
                              setDefaultKnowledgeSelection('');
                            }
                          }}
                        />
                        <span className="truncate"><RawIdentifier value={knowledgeBase.name} /></span>
                      </label>
                      <label className="flex shrink-0 items-center gap-[5px] text-[11px] text-[#858b9c]">
                        <input
                          type="radio"
                          name="team-default-knowledge"
                          aria-label={t('teamsPage.dialog.defaultKnowledge', { knowledgeBaseName: knowledgeBase.name })}
                          checked={defaultKnowledgeSelection === `existing:${knowledgeBase.id}`}
                          disabled={!selected}
                          onChange={() => setDefaultKnowledgeSelection(`existing:${knowledgeBase.id}`)}
                        />
                        {t('teamsPage.dialog.default')}
                      </label>
                    </div>
                  );
                })}
                {sharedKnowledgeBases.length === 0 && (
                  <p className="py-[4px] text-center text-[11px] text-[#a7adbb]">{t('teamsPage.dialog.noKnowledge')}</p>
                )}
              </div>
              <div className="mt-[10px] flex items-center gap-[8px]">
                <Input
                  value={newSharedKnowledgeName}
                  onChange={(event) => {
                    setNewSharedKnowledgeName(event.target.value);
                    if (!event.target.value.trim() && defaultKnowledgeSelection === 'new') {
                      setDefaultKnowledgeSelection('');
                    }
                  }}
                  placeholder={t('teamsPage.dialog.newKnowledgePlaceholder')}
                  aria-label={t('teamsPage.dialog.newKnowledgeName')}
                  className="h-[32px] flex-1 text-[12px]"
                />
                <label className="flex shrink-0 items-center gap-[5px] text-[11px] text-[#858b9c]">
                  <input
                    type="radio"
                    name="team-default-knowledge"
                    aria-label={t('teamsPage.dialog.defaultNewKnowledge')}
                    checked={defaultKnowledgeSelection === 'new'}
                    disabled={!newSharedKnowledgeName.trim()}
                    onChange={() => setDefaultKnowledgeSelection('new')}
                  />
                  {t('teamsPage.dialog.default')}
                </label>
              </div>
            </section>
            <label className="flex flex-col gap-[6px] text-[12px] text-[#464c5e]">
              {t('teamsPage.dialog.descriptionLabel')}
              <Textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder={t('teamsPage.dialog.descriptionPlaceholder')}
                aria-label={t('teamsPage.dialog.descriptionLabel')}
                rows={3}
              />
            </label>
          </div>
          <div className="flex items-center justify-end gap-[8px] px-[24px] pb-[16px]">
            <Button
              type="button"
              variant="outline"
              disabled={creating}
              onClick={() => setCreateOpen(false)}
              className="h-[32px] rounded-[10px] border-[#e3e7f1] px-[16px] text-[14px] font-normal text-[#464c5e]"
            >
              {t('teamsPage.dialog.cancel')}
            </Button>
            <Button
              type="button"
              disabled={creating}
              onClick={() => void createTeam()}
              className="h-[32px] rounded-[10px] bg-primary px-[16px] text-[14px] font-normal text-white hover:bg-primary/80"
            >
              {creating ? t('teamsPage.dialog.creating') : t('teamsPage.dialog.create')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        loading={deleting}
        title={t('teamsPage.confirm.deleteTitle', { teamName: deleteTarget?.name || '' })}
        description={t('teamsPage.confirm.deleteDescription')}
        cancelText={t('common.action.cancel')}
        confirmText={t('teamsPage.confirm.delete')}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}
