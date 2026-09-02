// @vitest-environment jsdom

import type { ReactNode } from 'react';

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { AppIntlProvider, type AppLocale } from '@/i18n';

import { TaskRunResultBadge } from './StatusBadge';
import { TaskActionsMenu } from './TaskActionsMenu';
import { TaskSection } from './TaskSection';
import type { ScheduledTaskRead } from '../../types';

const taskFixture: ScheduledTaskRead = {
  id: 'scheduled-control-1',
  tenant_id: 'tenant-demo',
  agent_id: 'agent-1',
  created_by_user_id: 'user-1',
  title: '跨区日报',
  prompt: '汇总昨日业务数据',
  schedule_type: 'daily',
  schedule: { time: '09:00' },
  timezone: 'Asia/Shanghai',
  status: 'active',
  concurrency_policy: 'forbid',
  misfire_policy: 'coalesce',
  run_count: 0,
  metadata: {},
  created_at: '2026-08-01T12:00:00Z',
  updated_at: '2026-08-01T12:00:00Z',
};

/** Render a scheduled-task control with an explicit locale and no legacy observer. */
function renderWithLocale(locale: AppLocale, children: ReactNode) {
  return render(<AppIntlProvider locale={locale}>{children}</AppIntlProvider>);
}

afterEach(cleanup);

describe('scheduled-task shared controls', () => {
  it.each([
    {
      locale: 'zh-CN' as const,
      menu: '操作',
      viewRuns: '查看记录',
      filterAria: '任务筛选',
      paginationAria: '任务分页',
      empty: '暂无',
    },
    {
      locale: 'en-US' as const,
      menu: 'Actions',
      viewRuns: 'View runs',
      filterAria: 'Filter Tasks',
      paginationAria: 'Tasks pagination',
      empty: 'None',
    },
  ])(
    'localizes action, accessibility, and unknown-status chrome in $locale',
    async ({ locale, menu, viewRuns, filterAria, paginationAria, empty }) => {
      const user = userEvent.setup();
      const onViewRuns = () => undefined;
      renderWithLocale(
        locale,
        <>
          <TaskActionsMenu
            task={taskFixture}
            onViewRuns={onViewRuns}
            onEdit={() => undefined}
            onRunNow={() => undefined}
            onToggleStatus={() => undefined}
            onDelete={() => undefined}
          />
          <TaskSection
            icon={null}
            title={locale === 'zh-CN' ? '任务' : 'Tasks'}
            filterTabs={[{ value: 'all', label: locale === 'zh-CN' ? '全部' : 'All' }]}
            filter="all"
            onFilterChange={() => undefined}
            rows={[{ id: 'row-1', title: '跨区日报' }]}
            pagedRows={[{ id: 'row-1', title: '跨区日报' }]}
            columns={[{ key: 'title', title: 'Title', dataIndex: 'title' }]}
            rowKey={(row) => row.id}
            emptyText={empty}
            page={1}
            pageCount={2}
            onPageChange={() => undefined}
            renderMobileCard={(row) => <span key={row.id}>{row.title}</span>}
          />
          <TaskRunResultBadge status="" />
        </>,
      );

      const trigger = screen.getByRole('button', { name: menu });
      expect(trigger).toBeTruthy();
      expect(screen.getByRole('tablist', { name: filterAria })).toBeTruthy();
      expect(screen.getByRole('navigation', { name: paginationAria })).toBeTruthy();
      expect(screen.getByText(empty)).toBeTruthy();

      await user.click(trigger);
      expect(screen.getByRole('menuitem', { name: viewRuns })).toBeTruthy();
    },
  );
});
