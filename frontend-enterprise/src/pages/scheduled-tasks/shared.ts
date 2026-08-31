import type { UnderlineTabItem } from '@/components/ui';
import { createAppTranslator, type AppTranslator, type MessageId } from '@/i18n';
import { getClientTimeZone, parseBackendDateTime } from '@/lib/timezone';
import type { ScheduledTaskRead, ScheduledTaskRunRead } from '../../types';

export const ENTERPRISE_AGENT_STORAGE_KEY = 'ultrarag_enterprise_agent_scope';
export const TASK_PAGE_SIZE = 10;

export type ScheduledTasksIntl = Pick<AppTranslator, 'locale' | 't'>;
type ScheduledTasksMessageId = MessageId;

const WEEKDAY_MESSAGE_IDS: readonly ScheduledTasksMessageId[] = [
  'scheduledTasksPage.schedule.weekday.monday',
  'scheduledTasksPage.schedule.weekday.tuesday',
  'scheduledTasksPage.schedule.weekday.wednesday',
  'scheduledTasksPage.schedule.weekday.thursday',
  'scheduledTasksPage.schedule.weekday.friday',
  'scheduledTasksPage.schedule.weekday.saturday',
  'scheduledTasksPage.schedule.weekday.sunday',
];

export type TaskFormValues = {
  title: string;
  prompt: string;
  description?: string;
  schedule_type: 'once' | 'daily' | 'weekly' | 'monthly';
  time: string;
  run_at: string;
  weekdays: number[];
  day_of_month: number;
  status: 'active' | 'paused';
  max_runs?: number;
  sop_id?: string;
  sop_version_policy: 'latest' | 'pinned';
};

export const INITIAL_VALUES: TaskFormValues = {
  title: '',
  prompt: '',
  description: '',
  schedule_type: 'daily',
  time: '09:00',
  run_at: '',
  weekdays: [0],
  day_of_month: 1,
  status: 'active',
  max_runs: undefined,
  sop_id: '',
  sop_version_policy: 'latest',
};

export type TaskListFilter = 'all' | 'pending' | 'completed' | 'paused';
export type RunListFilter = 'all' | 'pending' | 'completed' | 'failed';

const TASK_FILTER_VALUES: readonly TaskListFilter[] = ['all', 'pending', 'completed', 'paused'];
const RUN_FILTER_VALUES: readonly RunListFilter[] = ['all', 'pending', 'completed', 'failed'];
const TASK_FILTER_MESSAGE_IDS: Record<TaskListFilter, ScheduledTasksMessageId> = {
  all: 'scheduledTasksPage.filter.all',
  pending: 'scheduledTasksPage.filter.pending',
  completed: 'scheduledTasksPage.filter.completed',
  paused: 'scheduledTasksPage.filter.paused',
};
const RUN_FILTER_MESSAGE_IDS: Record<RunListFilter, ScheduledTasksMessageId> = {
  all: 'scheduledTasksPage.filter.all',
  pending: 'scheduledTasksPage.filter.pending',
  completed: 'scheduledTasksPage.filter.completed',
  failed: 'scheduledTasksPage.filter.failed',
};

/** Create the explicit default translator for pure scheduled-task helpers. */
function defaultScheduledTasksIntl(): ScheduledTasksIntl {
  return createAppTranslator('zh-CN');
}

/** Build task filter tabs from the active UI locale; filter values remain stable protocol enums. */
export function taskFilterTabs(
  intl: ScheduledTasksIntl = defaultScheduledTasksIntl(),
): UnderlineTabItem<TaskListFilter>[] {
  return TASK_FILTER_VALUES.map((value) => ({
    label: intl.t(TASK_FILTER_MESSAGE_IDS[value]),
    value,
  }));
}

/** Build execution filter tabs from the active UI locale; filter values remain stable protocol enums. */
export function runFilterTabs(
  intl: ScheduledTasksIntl = defaultScheduledTasksIntl(),
): UnderlineTabItem<RunListFilter>[] {
  return RUN_FILTER_VALUES.map((value) => ({
    label: intl.t(RUN_FILTER_MESSAGE_IDS[value]),
    value,
  }));
}

/** Build weekday choices from the active UI locale without embedding translated labels in code. */
export function weekdayOptions(
  intl: ScheduledTasksIntl = defaultScheduledTasksIntl(),
): { label: string; value: number }[] {
  return WEEKDAY_MESSAGE_IDS.map((messageId, value) => ({
    label: intl.t(messageId),
    value,
  }));
}

const TASK_FILTERS: Record<TaskListFilter, (row: ScheduledTaskRead) => boolean> = {
  all: () => true,
  pending: (row) => row.status === 'active',
  paused: (row) => row.status === 'paused',
  completed: (row) => row.status === 'completed',
};
const RUN_FILTERS: Record<RunListFilter, (row: ScheduledTaskRunRead) => boolean> = {
  all: () => true,
  pending: (row) =>
    row.status === 'queued' ||
    row.status === 'running' ||
    row.status === 'needs_input' ||
    row.status === 'incomplete',
  failed: (row) => row.status === 'failed' || row.status === 'skipped',
  completed: (row) => row.status === 'succeeded',
};

export function matchesTaskFilter(row: ScheduledTaskRead, filter: TaskListFilter): boolean {
  return TASK_FILTERS[filter](row);
}

export function matchesRunFilter(row: ScheduledTaskRunRead, filter: RunListFilter): boolean {
  return RUN_FILTERS[filter](row);
}

export function scheduledTaskSopOptions<T extends { status: string }>(rows: T[]): T[] {
  // Explicitly selecting an SOP authorizes SOP-specific resources for this
  // scheduled task; only unpublished entries must stay unavailable.
  return rows.filter((row) => row.status === 'published');
}

export type BadgeTone = 'blue' | 'orange' | 'green' | 'red' | 'gray';
export const BADGE_TONE_CLASS: Record<BadgeTone, string> = {
  blue: 'bg-[#e8f0ff] text-[#1a71ff]',
  orange: 'bg-[#fff2e5] text-[#ff7f00]',
  green: 'bg-[#e9f7ef] text-[#2cb360]',
  red: 'bg-[#fce7e7] text-[#d20b0b]',
  gray: 'bg-[#f2f3f7] text-[#858b9c]',
};
export const TASK_STATUS_BADGE: Record<string, { tone: BadgeTone; messageId: ScheduledTasksMessageId }> = {
  active: { tone: 'blue', messageId: 'scheduledTasksPage.status.active' },
  paused: { tone: 'orange', messageId: 'scheduledTasksPage.status.paused' },
  completed: { tone: 'green', messageId: 'scheduledTasksPage.status.completed' },
  archived: { tone: 'gray', messageId: 'scheduledTasksPage.status.archived' },
};
export const RUN_STATUS_BADGE: Record<string, { tone: BadgeTone; messageId: ScheduledTasksMessageId }> = {
  succeeded: { tone: 'green', messageId: 'scheduledTasksPage.status.succeeded' },
  failed: { tone: 'red', messageId: 'scheduledTasksPage.status.failed' },
  running: { tone: 'blue', messageId: 'scheduledTasksPage.status.running' },
  needs_input: { tone: 'orange', messageId: 'scheduledTasksPage.status.needsInput' },
  incomplete: { tone: 'orange', messageId: 'scheduledTasksPage.status.incomplete' },
  skipped: { tone: 'gray', messageId: 'scheduledTasksPage.status.skipped' },
};

/** Localize a task status badge while preserving unknown status codes for diagnostics. */
export function taskStatusBadge(
  status: string,
  intl: ScheduledTasksIntl = defaultScheduledTasksIntl(),
): { tone: BadgeTone; text: string } {
  const preset = TASK_STATUS_BADGE[status] || TASK_STATUS_BADGE.archived;
  return { tone: preset.tone, text: intl.t(preset.messageId) };
}

/** Localize a run status badge while preserving unknown provider status codes for diagnostics. */
export function runStatusBadge(
  status: string,
  intl: ScheduledTasksIntl = defaultScheduledTasksIntl(),
): { tone: BadgeTone; text: string } {
  const preset = RUN_STATUS_BADGE[status];
  return {
    tone: preset?.tone || 'gray',
    text: preset ? intl.t(preset.messageId) : status || intl.t('scheduledTasksPage.empty.none'),
  };
}

const SCHEDULE_TYPES = new Set<TaskFormValues['schedule_type']>(['once', 'daily', 'weekly', 'monthly']);
const SCHEDULE_BUILDERS: Record<
  TaskFormValues['schedule_type'],
  (values: TaskFormValues) => Record<string, unknown>
> = {
  once: (values) => ({ run_at: values.run_at }),
  weekly: (values) => ({
    time: values.time || '09:00',
    weekdays: values.weekdays?.length ? values.weekdays : [0],
  }),
  monthly: (values) => ({
    time: values.time || '09:00',
    day_of_month: values.day_of_month || 1,
  }),
  daily: (values) => ({ time: values.time || '09:00' }),
};
export function buildSchedule(values: TaskFormValues): Record<string, unknown> {
  return SCHEDULE_BUILDERS[values.schedule_type](values);
}

export function taskToFormValues(row: ScheduledTaskRead): TaskFormValues {
  const schedule = row.schedule || {};
  return {
    title: row.title,
    prompt: row.prompt,
    description: row.description || '',
    schedule_type: normalizeScheduleType(row.schedule_type),
    time: String(schedule.time || '09:00'),
    run_at: toDatetimeLocal(String(schedule.run_at || row.next_run_at || '')),
    weekdays: Array.isArray(schedule.weekdays) ? schedule.weekdays.map((item) => Number(item)) : [0],
    day_of_month: Number(schedule.day_of_month || 1),
    status: row.status === 'active' ? 'active' : 'paused',
    max_runs: row.max_runs,
    sop_id: typeof row.metadata?.sop_id === 'string' ? row.metadata.sop_id : '',
    sop_version_policy: row.metadata?.sop_version_policy === 'pinned' ? 'pinned' : 'latest',
  };
}

export function normalizeScheduleType(value: string): TaskFormValues['schedule_type'] {
  const scheduleType = value as TaskFormValues['schedule_type'];
  return SCHEDULE_TYPES.has(scheduleType) ? scheduleType : 'daily';
}

export function toDatetimeLocal(value: string): string {
  if (!value) return '';
  const date = parseBackendDateTime(value);
  if (Number.isNaN(date.getTime())) return '';
  const offset = date.getTimezoneOffset();
  const local = new Date(date.getTime() - offset * 60000);
  return local.toISOString().slice(0, 16);
}

/** Format a persisted schedule with locale-aware weekday lists and semantic message templates. */
export function formatSchedule(
  row: ScheduledTaskRead,
  intl: ScheduledTasksIntl = defaultScheduledTasksIntl(),
): string {
  const schedule = row.schedule || {};
  const scheduleType = normalizeScheduleType(row.schedule_type);
  if (scheduleType === 'once') {
    return intl.t('scheduledTasksPage.schedule.once', {
      time: formatTime(String(schedule.run_at || row.next_run_at || ''), intl),
    });
  }
  if (scheduleType === 'weekly') {
    const days = Array.isArray(schedule.weekdays)
      ? schedule.weekdays
        .map((item) => Number(item))
        .filter((item) => Number.isInteger(item) && item >= 0 && item < WEEKDAY_MESSAGE_IDS.length)
        .map((item) => intl.t(WEEKDAY_MESSAGE_IDS[item]))
      : [];
    return intl.t('scheduledTasksPage.schedule.weekly', {
      weekdays: new Intl.ListFormat(intl.locale, { type: 'conjunction' }).format(
        days.length ? days : [intl.t(WEEKDAY_MESSAGE_IDS[0])],
      ),
      time: String(schedule.time || '09:00'),
    });
  }
  if (scheduleType === 'monthly') {
    return intl.t('scheduledTasksPage.schedule.monthly', {
      day: Number(schedule.day_of_month || 1),
      time: String(schedule.time || '09:00'),
    });
  }
  return intl.t('scheduledTasksPage.schedule.daily', { time: String(schedule.time || '09:00') });
}

/** Format a backend timestamp using the active locale and browser timezone; invalid values use a catalog key. */
export function formatTime(
  value: string | undefined,
  intl: ScheduledTasksIntl = defaultScheduledTasksIntl(),
): string {
  if (!value) return intl.t('scheduledTasksPage.empty.none');
  const date = parseBackendDateTime(value);
  if (Number.isNaN(date.getTime())) return intl.t('scheduledTasksPage.empty.none');
  return new Intl.DateTimeFormat(intl.locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    hour12: false,
    timeZone: getClientTimeZone(),
  }).format(date);
}
