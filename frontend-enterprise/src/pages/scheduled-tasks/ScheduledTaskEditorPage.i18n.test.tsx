// @vitest-environment jsdom

import type { ReactNode } from 'react';

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppIntlProvider, type AppLocale } from '@/i18n';

const mocks = vi.hoisted(() => ({
  notifyError: vi.fn(),
  notifySuccess: vi.fn(),
  notifyWarning: vi.fn(),
}));

vi.mock('@/components/ui/app-toast', () => ({
  notify: {
    error: mocks.notifyError,
    success: mocks.notifySuccess,
    warning: mocks.notifyWarning,
  },
  createToastNotifier: () => ({
    error: mocks.notifyError,
    success: mocks.notifySuccess,
    warning: mocks.notifyWarning,
  }),
}));

vi.mock('@/components/AppHeader', () => ({
  default: ({ title, description }: { title?: ReactNode; description?: ReactNode }) => (
    <header>
      <h1>{title}</h1>
      <p>{description}</p>
    </header>
  ),
}));

import { api } from '../../api/client';
import { ScheduledTaskNewPage } from './ScheduledTaskEditorPage';

const copy = {
  'zh-CN': {
    title: '新建空白定时任务',
    description: '保存后到点会拉起一个新的执行记录，并交给当前员工按 SOP、技能、资料和工具执行。',
    back: '返回定时任务',
    save: '保存',
    taskSection: '任务说明',
    wakeSection: '唤醒计划',
    taskName: '任务名称',
    taskNamePlaceholder: '例如：每日交付质量复盘',
    prompt: '每次执行时交给员工的任务',
    promptPlaceholder: '描述员工每次执行时需要做什么，可以包含拆解要求、输出格式和注意事项。',
    sop: '指定 SOP',
    sopAuto: '由 Harness v2 自动判断',
    internalNote: '内部备注',
    internalNotePlaceholder: '可选，用于说明这个定时任务的来源和目的',
    status: '启用状态',
    enabled: '启用',
    scheduleType: '调度类型',
    daily: '每天',
    weekly: '每周',
    monthly: '每月',
    once: '一次性',
    executionTime: '执行时间',
    maxRuns: '最大运行次数',
    maxRunsPlaceholder: '不填为无限制',
    concurrency: '默认使用 forbid 并发策略：上一轮未结束时跳过本次唤醒，避免同一员工重复处理同一批任务。',
  },
  'en-US': {
    title: 'New blank scheduled task',
    description: 'At the scheduled time, a new execution record is created and run by the current employee using its SOPs, skills, knowledge, and tools.',
    back: 'Back to scheduled tasks',
    save: 'Save',
    taskSection: 'Task details',
    wakeSection: 'Wake-up schedule',
    taskName: 'Task name',
    taskNamePlaceholder: 'For example: Daily delivery quality review',
    prompt: 'Task given to the employee on each run',
    promptPlaceholder: 'Describe what the employee should do on each run, including steps, output format, and cautions.',
    sop: 'Assign SOP',
    sopAuto: 'Let Harness v2 decide automatically',
    internalNote: 'Internal note',
    internalNotePlaceholder: 'Optional note about this scheduled task’s source and purpose',
    status: 'Enabled status',
    enabled: 'Enabled',
    scheduleType: 'Schedule type',
    daily: 'Daily',
    weekly: 'Weekly',
    monthly: 'Monthly',
    once: 'Once',
    executionTime: 'Execution time',
    maxRuns: 'Maximum runs',
    maxRunsPlaceholder: 'Leave blank for no limit',
    concurrency: 'The default forbid concurrency policy skips a wake-up while the previous run is still in progress, so one employee does not process the same task batch twice.',
  },
} as const satisfies Record<AppLocale, Record<string, string>>;

/** 在指定 UI locale 下渲染编辑器，隔离全局 legacy observer。 */
function renderEditor(locale: AppLocale): void {
  render(
    <AppIntlProvider locale={locale}>
      <MemoryRouter>
        <ScheduledTaskNewPage />
      </MemoryRouter>
    </AppIntlProvider>,
  );
}

beforeEach(() => {
  mocks.notifyError.mockReset();
  mocks.notifySuccess.mockReset();
  mocks.notifyWarning.mockReset();
  window.localStorage.clear();
  vi.spyOn(api, 'get').mockResolvedValue([] as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('ScheduledTaskEditorPage semantic locale matrix', () => {
  it.each(['zh-CN', 'en-US'] as const)(
    'localizes editor chrome and placeholders in %s while leaving raw input fields available',
    async (locale) => {
      const user = userEvent.setup();
      const text = copy[locale];
      renderEditor(locale);

      expect(screen.getByRole('heading', { name: text.title })).toBeTruthy();
      expect(screen.getByText(text.description)).toBeTruthy();
      expect(screen.getByRole('button', { name: text.back })).toBeTruthy();
      expect(screen.getByRole('button', { name: text.save })).toBeTruthy();
      expect(screen.getByText(text.taskSection)).toBeTruthy();
      expect(screen.getByText(text.wakeSection)).toBeTruthy();
      expect(screen.getByText(text.taskName)).toBeTruthy();
      expect(screen.getByPlaceholderText(text.taskNamePlaceholder)).toBeTruthy();
      expect(screen.getByText(text.prompt)).toBeTruthy();
      expect(screen.getByPlaceholderText(text.promptPlaceholder)).toBeTruthy();
      expect(screen.getByText(text.sop)).toBeTruthy();
      await user.click(screen.getByRole('combobox', { name: text.sop }));
      expect(screen.getByRole('option', { name: text.sopAuto })).toBeTruthy();
      await user.keyboard('{Escape}');
      expect(screen.getByText(text.internalNote)).toBeTruthy();
      expect(screen.getByPlaceholderText(text.internalNotePlaceholder)).toBeTruthy();
      expect(screen.getByText(text.status)).toBeTruthy();
      expect(screen.getByText(text.enabled)).toBeTruthy();
      expect(screen.getByText(text.scheduleType)).toBeTruthy();
      expect(screen.getByText(text.daily)).toBeTruthy();
      expect(screen.getByText(text.maxRuns)).toBeTruthy();
      expect(screen.getByPlaceholderText(text.maxRunsPlaceholder)).toBeTruthy();
      expect(screen.getByText(text.concurrency)).toBeTruthy();
    },
  );

  it('uses a stable descriptor for missing employee selection instead of raw UI text', async () => {
    const user = userEvent.setup();
    renderEditor('en-US');

    await user.type(
      screen.getByPlaceholderText(copy['en-US'].taskNamePlaceholder),
      'Raw task title',
    );
    await user.type(
      screen.getByPlaceholderText(copy['en-US'].promptPlaceholder),
      'Raw task prompt',
    );
    await user.click(screen.getByRole('button', { name: copy['en-US'].save }));

    expect(mocks.notifyError).toHaveBeenCalledWith({
      id: 'scheduledTasksPage.editor.validation.agentRequired',
    });
    expect(JSON.stringify(mocks.notifyError.mock.calls)).not.toContain('请先选择员工');
  });
});
