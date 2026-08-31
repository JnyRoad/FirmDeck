// @vitest-environment jsdom

import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AppIntlProvider,
  createAppTranslator,
  useAppIntl,
  type AppLocale,
} from '@/i18n';

import type { ScheduledTaskRead, ScheduledTaskRunRead } from '../../types';
import {
  formatSchedule,
  formatTime,
  matchesRunFilter,
  runFilterTabs,
  runStatusBadge,
  scheduledTaskSopOptions,
  taskFilterTabs,
  taskStatusBadge,
  taskToFormValues,
  weekdayOptions,
} from './shared';

/** Build a complete persisted task whose title must never pass through a product catalog. */
function localizedTaskFixture(): ScheduledTaskRead {
  return {
    id: 'scheduled-locale-1',
    tenant_id: 'tenant-demo',
    agent_id: 'agent-1',
    created_by_user_id: 'user-1',
    title: '跨区日报',
    prompt: '汇总昨日业务数据',
    schedule_type: 'weekly',
    schedule: { time: '09:00', weekdays: [0, 2] },
    timezone: 'Asia/Shanghai',
    status: 'active',
    concurrency_policy: 'forbid',
    misfire_policy: 'coalesce',
    run_count: 0,
    metadata: {},
    created_at: '2026-08-01T12:00:00Z',
    updated_at: '2026-08-01T12:00:00Z',
  };
}

/** Exercise scheduled-task presentation helpers with the provider-owned semantic facade. */
function ScheduledSharedProbe({ task }: { task: ScheduledTaskRead }) {
  const i18n = useAppIntl();
  const taskTabs = taskFilterTabs(i18n);
  const runTabs = runFilterTabs(i18n);
  const weekdays = weekdayOptions(i18n);
  const taskStatus = taskStatusBadge(task.status, i18n);
  const runStatus = runStatusBadge('needs_input', i18n);

  return createElement(
    'section',
    { 'aria-label': 'scheduled-shared-probe' },
    createElement('span', { 'data-testid': 'task-title' }, task.title),
    createElement('span', { 'data-testid': 'task-filter' }, taskTabs[0]?.label),
    createElement('span', { 'data-testid': 'run-filter' }, runTabs[1]?.label),
    createElement('span', { 'data-testid': 'weekday' }, weekdays[0]?.label),
    createElement('span', { 'data-testid': 'task-status' }, taskStatus?.text),
    createElement('span', { 'data-testid': 'run-status' }, runStatus?.text),
    createElement(
      'span',
      { 'data-testid': 'schedule' },
      formatSchedule(task, i18n),
    ),
    createElement(
      'span',
      { 'data-testid': 'created-at' },
      formatTime(task.created_at, i18n),
    ),
  );
}

/** Render the pure presentation probe with no legacy locale observer. */
function renderScheduledSharedWithLocale(locale: AppLocale) {
  return render(
    createElement(
      AppIntlProvider,
      {
        locale,
        children: createElement(ScheduledSharedProbe, {
          task: localizedTaskFixture(),
        }),
      },
    ),
  );
}

afterEach(() => {
  cleanup();
});

function run(status: string): ScheduledTaskRunRead {
  return {
    id: `run-${status}`,
    tenant_id: 'tenant-demo',
    scheduled_task_id: 'scheduled-1',
    agent_id: 'agent-1',
    user_id: 'user-1',
    scheduled_for: '2026-08-01T09:00:00',
    status,
    trace: {},
    created_at: '2026-08-01T09:00:00',
    updated_at: '2026-08-01T09:00:00',
  };
}

describe('scheduled task Harness statuses', () => {
  it.each(['queued', 'running', 'needs_input', 'incomplete'])(
    'keeps %s in the pending filter',
    (status) => {
      expect(matchesRunFilter(run(status), 'pending')).toBe(true);
    },
  );

  it('presents non-terminal Harness outcomes explicitly', () => {
    const zh = createAppTranslator('zh-CN');
    expect(runStatusBadge('needs_input', zh).text).toBe('待补充信息');
    expect(runStatusBadge('incomplete', zh).text).toBe('未完成');
  });
});

describe('scheduled task SOP selection', () => {
  it('allows explicitly selected SOP-specific SOPs while excluding drafts', () => {
    const rows = [
      { id: 'general', status: 'published', capability_scope: 'general' },
      { id: 'specific', status: 'published', capability_scope: 'sop_specific' },
      { id: 'draft', status: 'draft', capability_scope: 'general' },
    ];

    expect(scheduledTaskSopOptions(rows).map((row) => row.id)).toEqual([
      'general',
      'specific',
    ]);
  });

  it('restores the pinned Harness v2 SOP from task metadata', () => {
    const task = {
      id: 'scheduled-1',
      tenant_id: 'tenant-demo',
      agent_id: 'agent-1',
      created_by_user_id: 'user-1',
      title: '日报',
      prompt: '生成日报',
      schedule_type: 'daily',
      schedule: { time: '09:00' },
      timezone: 'Asia/Shanghai',
      status: 'active',
      concurrency_policy: 'forbid',
      misfire_policy: 'coalesce',
      run_count: 0,
      metadata: {
        sop_id: 'daily_report_v2',
        sop_version_policy: 'pinned',
        sop_version: '1.0.0',
      },
      created_at: '2026-08-01T09:00:00',
      updated_at: '2026-08-01T09:00:00',
    } satisfies ScheduledTaskRead;

    expect(taskToFormValues(task).sop_id).toBe('daily_report_v2');
    expect(taskToFormValues(task).sop_version_policy).toBe('pinned');
  });

  it('defaults existing tasks to the latest published SOP policy', () => {
    const task = {
      id: 'scheduled-2',
      tenant_id: 'tenant-demo',
      agent_id: 'agent-1',
      created_by_user_id: 'user-1',
      title: '日报',
      prompt: '生成日报',
      schedule_type: 'daily',
      schedule: { time: '09:00' },
      timezone: 'Asia/Shanghai',
      status: 'active',
      concurrency_policy: 'forbid',
      misfire_policy: 'coalesce',
      run_count: 0,
      metadata: { sop_id: 'daily_report_v2' },
      created_at: '2026-08-01T09:00:00',
      updated_at: '2026-08-01T09:00:00',
    } satisfies ScheduledTaskRead;

    expect(taskToFormValues(task).sop_version_policy).toBe('latest');
  });
});

describe('scheduled task semantic locale presentation', () => {
  it.each([
    {
      locale: 'zh-CN',
      taskFilter: '全部',
      runFilter: '待完成',
      weekday: '周一',
      taskStatus: '启用',
      runStatus: '待补充信息',
      schedule: '每周 周一和周三 09:00',
      datePrefix: /^2026年8月1日/,
    },
    {
      locale: 'en-US',
      taskFilter: 'All',
      runFilter: 'Pending',
      weekday: 'Monday',
      taskStatus: 'Enabled',
      runStatus: 'Needs input',
      schedule: 'Weekly on Monday and Wednesday at 09:00',
      datePrefix: /^Aug 1, 2026/,
    },
  ] as const)(
    'localizes filters, statuses, schedules and dates in $locale without a legacy observer',
    ({
      locale,
      taskFilter,
      runFilter,
      weekday,
      taskStatus,
      runStatus,
      schedule,
      datePrefix,
    }) => {
      renderScheduledSharedWithLocale(locale);

      expect(screen.getByTestId('task-filter').textContent).toBe(taskFilter);
      expect(screen.getByTestId('run-filter').textContent).toBe(runFilter);
      expect(screen.getByTestId('weekday').textContent).toBe(weekday);
      expect(screen.getByTestId('task-status').textContent).toBe(taskStatus);
      expect(screen.getByTestId('run-status').textContent).toBe(runStatus);
      expect(screen.getByTestId('schedule').textContent).toBe(schedule);
      expect(screen.getByTestId('created-at').textContent).toMatch(datePrefix);
      expect(screen.getByTestId('task-title').textContent).toBe('跨区日报');
    },
  );
});
