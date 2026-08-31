import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { ConfirmDialog } from '@/components/ConfirmDialog';
import { DataTable, type DataTableColumn } from '@/components/DataTable';
import { Paginator } from '@/components/Paginator';
import { StatCard } from '@/components/StatCard';
import { Button as UIButton } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui';
import type { UnderlineTabItem } from '@/components/ui';
import { createToastNotifier } from '@/components/ui/app-toast';
import { createMessageDescriptor } from '@/i18n/descriptors';
import { useAppIntl, type AppLocale, type AppTranslator, type MessageId, type MessageValues } from '@/i18n';
import { RawContent } from '@/i18n/RawContent';
import { MOBILE_CARD_CLASS } from '@/lib/enterprise-ui';

import { api, TENANT_ID } from '../../api/client';
import IconAdd from '../../assets/icons/add.svg?react';
import IconAlignJustify from '../../assets/icons/align-justify.svg?react';
import IconAlarm from '../../assets/icons/profile-alarm.svg?react';
import IconSearch from '../../assets/icons/search.svg?react';
import { useClientPagination } from '../../hooks/useClientPagination';
import type { AgentProfileRead, ScheduledTaskRead, ScheduledTaskRunRead } from '../../types';
import { StatusBadge } from '../scheduled-tasks/StatusBadge';
import { TaskActionsMenu } from '../scheduled-tasks/TaskActionsMenu';
import { TaskSection } from '../scheduled-tasks/TaskSection';
import {
  TASK_PAGE_SIZE,
  matchesRunFilter,
  matchesTaskFilter,
  type RunListFilter,
  type TaskListFilter,
} from '../scheduled-tasks/shared';
import { isTeamScope, readEmployeeScope } from '../../lib/agent-scope-storage';
import { getClientTimeZone, parseBackendDateTime } from '../../lib/timezone';

export {
  ScheduledTaskEditPage,
  ScheduledTaskNewPage,
  type ScheduledTaskPageProps,
} from '../scheduled-tasks/ScheduledTaskEditorPage';

const MOBILE_CARD_HEAD_CLASS = 'flex min-w-0 items-start justify-between gap-[10px]';
const MOBILE_META_CLASS =
  'mt-[12px] grid grid-cols-2 gap-[8px] max-[520px]:grid-cols-1 [&>span]:min-w-0 [&>span]:rounded-[10px] [&>span]:border [&>span]:border-[#eef0f4] [&>span]:bg-[#fafbfc] [&>span]:px-[10px] [&>span]:py-[9px] [&>span]:text-[12px] [&>span]:leading-[1.45] [&>span]:text-[#18181a] [&>span]:[overflow-wrap:anywhere] [&_b]:mb-[3px] [&_b]:block [&_b]:text-[11px] [&_b]:font-semibold [&_b]:text-[#858b9c]';
const MOBILE_TITLE_CLASS =
  'min-w-0 wrap-break-word text-[14px] font-semibold text-[#18181a]';
const MOBILE_SUMMARY_CLASS = 'mt-[8px] line-clamp-2 text-[12px] leading-[1.55] text-[#858b9c]';

type ScheduledTasksMessageId = MessageId;

type ScheduledTasksTranslate = (id: ScheduledTasksMessageId, values?: MessageValues) => string;

/** 将受控 translator 扩展为本页面待补目录键的适配器；locale 仍由 AppIntlProvider 负责。 */
function createScheduledTasksTranslator(translator: Pick<AppTranslator, 't'>): ScheduledTasksTranslate {
  return (id, values) => translator.t(id, values);
}

/** 将定时任务或执行记录状态码投影为本地化徽标；未知状态保持原始枚举值。 */
function LocalizedTaskStatusBadge({ status, translate }: { status: string; translate: ScheduledTasksTranslate }) {
  const presets: Record<string, { tone: 'blue' | 'orange' | 'green' | 'red' | 'gray'; id: ScheduledTasksMessageId }> = {
    active: { tone: 'blue', id: 'scheduledTasksPage.status.active' },
    paused: { tone: 'orange', id: 'scheduledTasksPage.status.paused' },
    completed: { tone: 'green', id: 'scheduledTasksPage.status.completed' },
    archived: { tone: 'gray', id: 'scheduledTasksPage.status.archived' },
  };
  const preset = presets[status];
  return <StatusBadge tone={preset?.tone || 'gray'}>{preset ? translate(preset.id) : status}</StatusBadge>;
}

/** 将执行结果状态码投影为本地化徽标；provider 或未知状态原样保留。 */
function LocalizedRunResultBadge({ status, translate }: { status: string; translate: ScheduledTasksTranslate }) {
  const presets: Record<string, { tone: 'blue' | 'orange' | 'green' | 'red' | 'gray'; id: ScheduledTasksMessageId }> = {
    succeeded: { tone: 'green', id: 'scheduledTasksPage.status.succeeded' },
    failed: { tone: 'red', id: 'scheduledTasksPage.status.failed' },
    running: { tone: 'blue', id: 'scheduledTasksPage.status.running' },
    needs_input: { tone: 'orange', id: 'scheduledTasksPage.status.needsInput' },
    incomplete: { tone: 'orange', id: 'scheduledTasksPage.status.incomplete' },
    skipped: { tone: 'gray', id: 'scheduledTasksPage.status.skipped' },
  };
  const preset = presets[status];
  return <StatusBadge tone={preset?.tone || 'gray'}>{preset ? translate(preset.id) : status}</StatusBadge>;
}

/** 以当前语言和浏览器时区格式化后端时间；无效时间使用受控空值文案。 */
function formatScheduledTime(value: string | undefined, locale: AppLocale, translate: ScheduledTasksTranslate): string {
  if (!value) return translate('scheduledTasksPage.empty.none');
  const date = parseBackendDateTime(value);
  if (Number.isNaN(date.getTime())) return translate('scheduledTasksPage.empty.none');
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    hour12: false,
    timeZone: getClientTimeZone(),
  }).format(date);
}

/** 以 locale-aware 列表和 ICU 模板展示计划规则，不拼接自然语言。 */
function formatScheduledSchedule(
  row: ScheduledTaskRead,
  locale: AppLocale,
  translate: ScheduledTasksTranslate,
): string {
  const schedule = row.schedule || {};
  const scheduleType = row.schedule_type === 'once'
    || row.schedule_type === 'weekly'
    || row.schedule_type === 'monthly'
    || row.schedule_type === 'daily'
    ? row.schedule_type
    : 'daily';
  if (scheduleType === 'once') {
    return translate('scheduledTasksPage.schedule.once', {
      time: formatScheduledTime(String(schedule.run_at || row.next_run_at || ''), locale, translate),
    });
  }
  if (scheduleType === 'weekly') {
    const weekdayIds: ScheduledTasksMessageId[] = [
      'scheduledTasksPage.schedule.weekday.monday',
      'scheduledTasksPage.schedule.weekday.tuesday',
      'scheduledTasksPage.schedule.weekday.wednesday',
      'scheduledTasksPage.schedule.weekday.thursday',
      'scheduledTasksPage.schedule.weekday.friday',
      'scheduledTasksPage.schedule.weekday.saturday',
      'scheduledTasksPage.schedule.weekday.sunday',
    ];
    const weekdays = Array.isArray(schedule.weekdays)
      ? schedule.weekdays
        .map((item) => Number(item))
        .filter((item) => Number.isInteger(item) && item >= 0 && item < weekdayIds.length)
        .map((item) => translate(weekdayIds[item]))
      : [];
    return translate('scheduledTasksPage.schedule.weekly', {
      weekdays: new Intl.ListFormat(locale, { type: 'conjunction' }).format(
        weekdays.length ? weekdays : [translate(weekdayIds[0])],
      ),
      time: String(schedule.time || '09:00'),
    });
  }
  if (scheduleType === 'monthly') {
    return translate('scheduledTasksPage.schedule.monthly', {
      day: Number(schedule.day_of_month || 1),
      time: String(schedule.time || '09:00'),
    });
  }
  return translate('scheduledTasksPage.schedule.daily', { time: String(schedule.time || '09:00') });
}

/** 渲染定时任务与执行记录；产品 chrome 随当前 UI locale 本地化，任务/结果正文保留 raw。 */
export default function ScheduledTasksTab() {
  const [rows, setRows] = useState<ScheduledTaskRead[]>([]);
  const [agents, setAgents] = useState<AgentProfileRead[]>([]);
  const [agentId, setAgentId] = useState(readEmployeeScope);
  const [loading, setLoading] = useState(false);
  const [runsOpen, setRunsOpen] = useState(false);
  const [runRows, setRunRows] = useState<ScheduledTaskRunRead[]>([]);
  const [allRunRows, setAllRunRows] = useState<ScheduledTaskRunRead[]>([]);
  const [taskFilter, setTaskFilter] = useState<TaskListFilter>('all');
  const [runFilter, setRunFilter] = useState<RunListFilter>('all');
  const [runLoading, setRunLoading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ScheduledTaskRead | null>(null);
  const [deleting, setDeleting] = useState(false);
  const navigate = useNavigate();
  const { t: appT, locale } = useAppIntl();
  const translate = createScheduledTasksTranslator({ t: appT });
  const toast = createToastNotifier({ t: appT });

  const taskFilterTabs: UnderlineTabItem<TaskListFilter>[] = [
    { label: translate('scheduledTasksPage.filter.all'), value: 'all' },
    { label: translate('scheduledTasksPage.filter.pending'), value: 'pending' },
    { label: translate('scheduledTasksPage.filter.completed'), value: 'completed' },
    { label: translate('scheduledTasksPage.filter.paused'), value: 'paused' },
  ];
  const runFilterTabs: UnderlineTabItem<RunListFilter>[] = [
    { label: translate('scheduledTasksPage.filter.all'), value: 'all' },
    { label: translate('scheduledTasksPage.filter.pending'), value: 'pending' },
    { label: translate('scheduledTasksPage.filter.completed'), value: 'completed' },
    { label: translate('scheduledTasksPage.filter.failed'), value: 'failed' },
  ];

  const selectedAgent = agents.find((item) => item.id === agentId) || null;
  const createDisabled = !agentId || Boolean(selectedAgent?.is_overall);

  useEffect(() => {
    const onScopeChange = (event: Event) => {
      const next = (event as CustomEvent<{ agentId?: string }>).detail?.agentId || '';
      setAgentId(next && !isTeamScope(next) ? next : readEmployeeScope());
    };
    window.addEventListener('ultrarag-enterprise-agent-scope-change', onScopeChange);
    return () => window.removeEventListener('ultrarag-enterprise-agent-scope-change', onScopeChange);
  }, []);

  useEffect(() => {
    void loadAgents();
  }, []);

  useEffect(() => {
    if (agentId) void load();
  }, [agentId]);

  /** 加载可选数字员工；员工名称和标识仅作为业务数据使用。 */
  async function loadAgents() {
    try {
      const result = await api.get<AgentProfileRead[]>(`/api/enterprise/agents?tenant_id=${TENANT_ID}`);
      setAgents(result);
    } catch {
      setAgents([]);
    }
  }

  /** 加载当前员工的定时任务及执行记录；异常只产生稳定产品 toast。 */
  async function load() {
    setLoading(true);
    try {
      const [result, runResult] = await Promise.all([
        api.get<ScheduledTaskRead[]>(
          `/api/enterprise/scheduled-tasks?tenant_id=${TENANT_ID}&agent_id=${encodeURIComponent(agentId)}`,
        ),
        api.get<ScheduledTaskRunRead[]>(
          `/api/enterprise/scheduled-tasks/runs?tenant_id=${TENANT_ID}&agent_id=${encodeURIComponent(agentId)}&limit=200`,
        ),
      ]);
      setRows(result);
      setAllRunRows(runResult);
    } catch (error) {
      toast.error(createMessageDescriptor('scheduledTasksPage.toast.loadFailed'));
    } finally {
      setLoading(false);
    }
  }

  /** 切换定时任务状态；后端状态码映射为当前 locale 的产品提示。 */
  async function toggleStatus(row: ScheduledTaskRead) {
    if (row.status === 'archived') {
      toast.warning(createMessageDescriptor('scheduledTasksPage.toast.archivedCannotToggle'));
      return;
    }
    if (row.status === 'completed') {
      toast.warning(createMessageDescriptor('scheduledTasksPage.toast.completedCannotToggle'));
      return;
    }
    const nextStatus = row.status === 'active' ? 'paused' : 'active';
    try {
      await api.put<ScheduledTaskRead>(`/api/enterprise/scheduled-tasks/${row.id}`, {
        tenant_id: TENANT_ID,
        status: nextStatus,
      });
      toast.success(createMessageDescriptor(
        nextStatus === 'active'
          ? 'scheduledTasksPage.toast.enabled'
          : 'scheduledTasksPage.toast.paused',
      ));
      await load();
    } catch (error) {
      toast.error(createMessageDescriptor('scheduledTasksPage.toast.toggleFailed'));
    }
  }

  /** 立即触发定时任务；运行结果正文不作为产品提示透传。 */
  async function runNow(row: ScheduledTaskRead) {
    if (row.status === 'archived') {
      toast.warning(createMessageDescriptor('scheduledTasksPage.toast.archivedCannotRun'));
      return;
    }
    try {
      const run = await api.post<ScheduledTaskRunRead>(
        `/api/enterprise/scheduled-tasks/${row.id}/run-now?tenant_id=${TENANT_ID}`,
      );
      toast.success(createMessageDescriptor(
        run.session_id
          ? 'scheduledTasksPage.toast.runCreated'
          : 'scheduledTasksPage.toast.runTriggered',
      ));
      await load();
    } catch (error) {
      toast.error(createMessageDescriptor('scheduledTasksPage.toast.runNowFailed'));
    }
  }

  /** 打开删除确认框；任务标题仅作为业务原文参数显示。 */
  function remove(row: ScheduledTaskRead) {
    setDeleteTarget(row);
  }

  /** 删除定时任务并保留服务端历史执行记录；提示使用稳定语义键。 */
  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.delete(`/api/enterprise/scheduled-tasks/${deleteTarget.id}?tenant_id=${TENANT_ID}`);
      toast.success(createMessageDescriptor('scheduledTasksPage.toast.deleted'));
      setDeleteTarget(null);
      await load();
    } catch (error) {
      toast.error(createMessageDescriptor('scheduledTasksPage.toast.deleteFailed'));
    } finally {
      setDeleting(false);
    }
  }

  /** 打开单任务执行记录；服务端错误不直接展示异常正文。 */
  async function openRuns(row: ScheduledTaskRead) {
    setRunsOpen(true);
    setRunLoading(true);
    try {
      const result = await api.get<ScheduledTaskRunRead[]>(
        `/api/enterprise/scheduled-tasks/${row.id}/runs?tenant_id=${TENANT_ID}`,
      );
      setRunRows(result);
    } catch (error) {
      toast.error(createMessageDescriptor('scheduledTasksPage.toast.runsLoadFailed'));
    } finally {
      setRunLoading(false);
    }
  }

  /** 打开执行会话；sessionId 是路由标识而非待翻译文案。 */
  function openChatSession(sessionId?: string) {
    if (!sessionId) return;
    window.open(`/workspace/chat/${sessionId}`, '_blank', 'noopener,noreferrer');
  }

  const activeRows = rows.filter((item) => item.status === 'active');
  const taskRows = rows.filter((item) => item.status !== 'archived');
  const completedCount = taskRows.filter((item) => item.status === 'completed').length;
  const visibleRows = taskRows.filter((item) => matchesTaskFilter(item, taskFilter));
  const visibleRunRows = allRunRows.filter((item) => matchesRunFilter(item, runFilter));

  const taskPagination = useClientPagination(visibleRows, TASK_PAGE_SIZE, taskFilter);
  const runPagination = useClientPagination(visibleRunRows, TASK_PAGE_SIZE, runFilter);
  const runsModalPagination = useClientPagination(runRows, TASK_PAGE_SIZE, runRows);

  const renderTaskActions = (row: ScheduledTaskRead) => (
    <TaskActionsMenu
      task={row}
      onViewRuns={openRuns}
      onEdit={(task) => navigate(`/enterprise/scheduled-tasks/${task.id}/edit`)}
      onRunNow={runNow}
      onToggleStatus={toggleStatus}
      onDelete={remove}
    />
  );

  const taskColumns: DataTableColumn<ScheduledTaskRead>[] = [
    {
      key: 'title',
          title: translate('scheduledTasksPage.column.task'),
      className: 'whitespace-normal',
      render: (row) => (
        <div className="flex min-w-0 flex-col gap-[4px]">
          <span className="font-medium leading-[18px] text-[#18181a]"><RawContent value={row.title} /></span>
          <span className="truncate"><RawContent value={row.prompt} /></span>
        </div>
      ),
    },
    {
      key: 'schedule',
      title: translate('scheduledTasksPage.column.schedule'),
      width: 200,
      className: 'whitespace-normal [overflow-wrap:anywhere]',
      render: (row) => formatScheduledSchedule(row, locale, translate),
    },
    { key: 'status', title: translate('scheduledTasksPage.column.status'), width: 120, render: (row) => <LocalizedTaskStatusBadge status={row.status} translate={translate} /> },
    { key: 'next', title: translate('scheduledTasksPage.column.nextRun'), width: 160, render: (row) => formatScheduledTime(row.next_run_at, locale, translate) },
    { key: 'runCount', title: translate('scheduledTasksPage.column.runCount'), width: 120, render: (row) => translate('scheduledTasksPage.value.runCount', { count: row.run_count || 0 }) },
    {
      key: 'lastResult',
      title: translate('scheduledTasksPage.column.latestResult'),
      width: 120,
      render: (row) =>
        row.last_status ? (
          <LocalizedRunResultBadge status={row.last_status} translate={translate} />
        ) : (
          <span>{translate('scheduledTasksPage.empty.none')}</span>
        ),
    },
    { key: 'actions', title: translate('scheduledTasksPage.column.actions'), width: 100, render: renderTaskActions },
  ];

  const runColumns: DataTableColumn<ScheduledTaskRunRead>[] = [
    {
      key: 'task',
      title: translate('scheduledTasksPage.column.task'),
      width: 240,
      className: 'whitespace-normal',
      render: (row) => (
        <div className="flex min-w-0 flex-col gap-[2px]">
          <span className="truncate"><RawContent value={row.task_title || row.scheduled_task_id} /></span>
          {row.task_status === 'archived' && <ArchivedTag translate={translate} />}
        </div>
      ),
    },
    { key: 'status', title: translate('scheduledTasksPage.column.status'), width: 120, render: (row) => <LocalizedRunResultBadge status={row.status} translate={translate} /> },
    {
      key: 'scheduled',
      title: translate('scheduledTasksPage.column.scheduledFor'),
      width: 160,
      render: (row) => formatScheduledTime(row.scheduled_for, locale, translate),
    },
    {
      key: 'finished',
      title: translate('scheduledTasksPage.column.finishedAt'),
      width: 160,
      render: (row) => formatScheduledTime(row.finished_at, locale, translate),
    },
    {
      key: 'result',
      title: translate('scheduledTasksPage.column.result'),
      className: 'whitespace-normal',
      render: (row) => (
        <span className="wrap-break-word">
          {row.result_summary || row.error
            ? <RawContent value={row.result_summary || row.error || ''} />
            : translate('scheduledTasksPage.empty.none')}
        </span>
      ),
    },
    {
      key: 'actions',
      title: translate('scheduledTasksPage.column.actions'),
      width: 100,
      render: (row) => (
        <UIButton
          variant="link"
          disabled={!row.session_id}
          onClick={() => openChatSession(row.session_id)}
          className="h-auto p-0 text-[12px] font-normal text-[#1a71ff] hover:text-[#4a8dff] hover:no-underline disabled:text-[#c0c6d4]"
        >
          {translate('scheduledTasksPage.action.viewSession')}
        </UIButton>
      ),
    },
  ];

  const runModalColumns: DataTableColumn<ScheduledTaskRunRead>[] = [
    {
      key: 'scheduled',
      title: translate('scheduledTasksPage.column.scheduledFor'),
      width: 170,
      render: (row) => formatScheduledTime(row.scheduled_for, locale, translate),
    },
    { key: 'status', title: translate('scheduledTasksPage.column.status'), width: 100, render: (row) => <LocalizedRunResultBadge status={row.status} translate={translate} /> },
    {
      key: 'session',
      title: translate('scheduledTasksPage.column.session'),
      width: 200,
      className: 'whitespace-normal',
      render: (row) =>
        row.session_id ? (
          <button
            type="button"
            onClick={() => openChatSession(row.session_id)}
            className="max-w-full truncate text-left text-[#1a71ff] transition-colors hover:text-[#4a8dff]"
          >
            {row.session_id}
          </button>
        ) : (
          translate('scheduledTasksPage.empty.session')
        ),
    },
    {
      key: 'result',
      title: translate('scheduledTasksPage.column.result'),
      className: 'whitespace-normal',
      render: (row) => (
        <span className="wrap-break-word">
          {row.result_summary || row.error
            ? <RawContent value={row.result_summary || row.error || ''} />
            : translate('scheduledTasksPage.empty.none')}
        </span>
      ),
    },
  ];

  /** Render one scheduled-task card for narrow viewports; titles and prompts remain raw content. */
  const renderTaskMobileCard = (row: ScheduledTaskRead) => (
    <article className={MOBILE_CARD_CLASS} key={row.id}>
      <div className={MOBILE_CARD_HEAD_CLASS}>
        <strong className={MOBILE_TITLE_CLASS}><RawContent value={row.title} /></strong>
        <LocalizedTaskStatusBadge status={row.status} translate={translate} />
      </div>
      <p className={MOBILE_SUMMARY_CLASS}><RawContent value={row.prompt} /></p>
      <div className={MOBILE_META_CLASS}>
        <span>
          <b>{translate('scheduledTasksPage.mobile.schedule')}</b>
          {formatScheduledSchedule(row, locale, translate)}
        </span>
        <span>
          <b>{translate('scheduledTasksPage.mobile.nextRun')}</b>
          {formatScheduledTime(row.next_run_at, locale, translate)}
        </span>
        <span>
          <b>{translate('scheduledTasksPage.mobile.runCount')}</b>
          {translate('scheduledTasksPage.value.runCount', { count: row.run_count || 0 })}
        </span>
        <span>
          <b>{translate('scheduledTasksPage.mobile.latest')}</b>
          {row.last_status
            ? <LocalizedRunResultBadge status={row.last_status} translate={translate} />
            : translate('scheduledTasksPage.empty.none')}
        </span>
      </div>
      <div className="mt-[12px] flex justify-end">{renderTaskActions(row)}</div>
    </article>
  );

  /** Render one execution record card for narrow viewports; result text is raw server output. */
  const renderRunMobileCard = (row: ScheduledTaskRunRead) => (
    <article className={MOBILE_CARD_CLASS} key={row.id}>
      <div className={MOBILE_CARD_HEAD_CLASS}>
        <strong className={MOBILE_TITLE_CLASS}><RawContent value={row.task_title || row.scheduled_task_id} /></strong>
        <LocalizedRunResultBadge status={row.status} translate={translate} />
      </div>
      {row.task_status === 'archived' && (
        <div className="mt-[10px]">
          <ArchivedTag translate={translate} />
        </div>
      )}
      <div className={MOBILE_META_CLASS}>
        <span>
          <b>{translate('scheduledTasksPage.column.scheduledFor')}</b>
          {formatScheduledTime(row.scheduled_for, locale, translate)}
        </span>
        <span>
          <b>{translate('scheduledTasksPage.column.finishedAt')}</b>
          {formatScheduledTime(row.finished_at, locale, translate)}
        </span>
      </div>
      <p className={MOBILE_SUMMARY_CLASS}>
        {row.result_summary || row.error
          ? <RawContent value={row.result_summary || row.error || ''} />
          : translate('scheduledTasksPage.empty.result')}
      </p>
      <div className="mt-[12px] flex justify-end">
        <UIButton
          variant="link"
          disabled={!row.session_id}
          onClick={() => openChatSession(row.session_id)}
          className="h-auto gap-1 p-0 text-[12px] font-normal text-[#1a71ff] hover:text-[#4a8dff] hover:no-underline disabled:text-[#c0c6d4]"
        >
          <IconSearch className="size-3.5" />
          {translate('scheduledTasksPage.action.viewSession')}
        </UIButton>
      </div>
    </article>
  );

  const actionButtons = (
    <div className="flex justify-end gap-[16px]">
      <UIButton
        data-guide-target="scheduled-task-create"
        onClick={() => navigate('/enterprise/scheduled-tasks/new')}
        disabled={createDisabled}
        className="h-8 w-[100px] gap-1 rounded-[10px] bg-[#18181a] px-5 text-[12px] font-normal text-white hover:bg-[#303030]"
      >
        <IconAdd className="size-3.5" />
        {translate('scheduledTasksPage.action.create')}
      </UIButton>
    </div>
  );

  const scheduledBody = selectedAgent?.is_overall ? (
    <div className="flex min-h-[200px] items-center justify-center rounded-[14px] bg-[#f6f6f6] text-[13px] text-[#858b9c]">
      {translate('scheduledTasksPage.action.selectEmployee')}
    </div>
  ) : (
    <>
      <div className="flex flex-wrap items-stretch gap-[20px]" aria-label={translate('scheduledTasksPage.section.statistics')}>
        <StatCard label={translate('scheduledTasksPage.stats.pending')} value={new Intl.NumberFormat(locale).format(activeRows.length)} className="basis-[220px]" />
        <StatCard label={translate('scheduledTasksPage.stats.completed')} value={new Intl.NumberFormat(locale).format(completedCount)} className="basis-[220px]" />
        <StatCard label={translate('scheduledTasksPage.stats.runs')} value={new Intl.NumberFormat(locale).format(allRunRows.length)} className="basis-[220px]" />
      </div>

      <div className="flex flex-col gap-[24px]">
        <TaskSection
          icon={<IconAlarm className="size-[14px] shrink-0" />}
          title={translate('scheduledTasksPage.section.taskList')}
          filterTabs={taskFilterTabs}
          filter={taskFilter}
          onFilterChange={setTaskFilter}
          rows={visibleRows}
          pagedRows={taskPagination.pagedItems}
          columns={taskColumns}
          rowKey={(row) => row.id}
          loading={loading}
          emptyText={translate('scheduledTasksPage.empty.tasks')}
          page={taskPagination.page}
          pageCount={taskPagination.pageCount}
          onPageChange={taskPagination.setPage}
          renderMobileCard={renderTaskMobileCard}
        />

        <TaskSection
          icon={<IconAlignJustify className="size-[14px] shrink-0" />}
          title={translate('scheduledTasksPage.section.runs')}
          filterTabs={runFilterTabs}
          filter={runFilter}
          onFilterChange={setRunFilter}
          rows={visibleRunRows}
          pagedRows={runPagination.pagedItems}
          columns={runColumns}
          rowKey={(row) => row.id}
          loading={loading}
          emptyText={translate('scheduledTasksPage.empty.runs')}
          tableSize="compact"
          striped
          bordered
          page={runPagination.page}
          pageCount={runPagination.pageCount}
          onPageChange={runPagination.setPage}
          renderMobileCard={renderRunMobileCard}
        />
      </div>
    </>
  );

  return (
    <>
      <section
        aria-busy={loading}
        className="relative mt-[-2px] flex w-full min-w-0 max-w-full flex-col gap-[24px] overflow-hidden rounded-[18px] bg-white p-[14px] shadow-[0_20px_42px_rgba(21,26,38,0.045)] *:min-w-0 min-[521px]:p-[18px]"
      >
        {actionButtons}
        {scheduledBody}
      </section>

      <Dialog open={runsOpen} onOpenChange={setRunsOpen}>
        <DialogContent
          aria-describedby={undefined}
          className="flex max-h-[calc(100dvh-4rem)] w-[calc(100%-2rem)] flex-col gap-[16px] overflow-hidden rounded-[14px] px-[20px] py-[16px] sm:max-w-[920px]"
        >
          <div className="flex items-center gap-[6px] px-[12px] text-[#757f9c]">
            <IconAlignJustify className="size-[14px] shrink-0" />
            <DialogTitle className="text-[14px] font-normal leading-none text-[#757f9c]">
              {translate('scheduledTasksPage.section.runs')}
            </DialogTitle>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <DataTable
              aria-label={translate('scheduledTasksPage.section.runs')}
              columns={runModalColumns}
              data={runsModalPagination.pagedItems}
              rowKey={(row) => row.id}
              loading={runLoading}
              emptyText={translate('scheduledTasksPage.empty.runs')}
              size="compact"
              striped
              bordered
            />
          </div>
          {runRows.length > 0 && (
            <Paginator
              aria-label={translate('scheduledTasksPage.section.runsPagination')}
              className="mt-0"
              page={runsModalPagination.page}
              pageCount={runsModalPagination.pageCount}
              onChange={runsModalPagination.setPage}
            />
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        loading={deleting}
        title={translate('scheduledTasksPage.confirm.deleteTitle', { taskTitle: deleteTarget?.title ?? '' })}
        description={translate('scheduledTasksPage.confirm.deleteDescription')}
        confirmText={translate('scheduledTasksPage.confirm.delete')}
        cancelText={translate('scheduledTasksPage.confirm.cancel')}
        onConfirm={() => void confirmDelete()}
      />
    </>
  );
}

/** 标记已归档任务；状态文案由当前 locale translator 提供。 */
function ArchivedTag({ translate }: { translate: ScheduledTasksTranslate }) {
  return (
    <StatusBadge tone="gray">{translate('scheduledTasksPage.status.archived')}</StatusBadge>
  );
}
