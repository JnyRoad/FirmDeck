// @vitest-environment jsdom

import { cleanup, render as rtlRender, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReactElement } from 'react';
import { AppIntlProvider, type AppLocale } from '@/i18n';
import { getClientTimeZone } from '@/lib/timezone';
import type { ScheduledTaskDraftRead } from '@/types';

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

import ScheduledDraftCard from './ScheduledDraftCard';

const draft: ScheduledTaskDraftRead = {
  should_create: true,
  tenant_id: 'tenant-demo',
  agent_id: 'agent-demo',
  title: 'Daily price check',
  prompt: 'Check and summarize the A1 price',
  description: 'Remains actionable after refresh',
  schedule_type: 'daily',
  schedule: { time: '09:00' },
  timezone: 'Asia/Shanghai',
  confidence: 1,
};

afterEach(cleanup);

/** 为排程卡片行为测试提供显式语义 i18n runtime，避免依赖 legacy observer。 */
function render(ui: ReactElement, locale: AppLocale = 'zh-CN') {
  return rtlRender(<AppIntlProvider initialLocale={locale}>{ui}</AppIntlProvider>);
}

const copy = {
  'zh-CN': {
    preview: '定时任务草案',
    scheduleType: '计划类型',
    schedule: '计划',
    timezone: '时区',
    content: '执行内容',
    description: '说明',
    edit: '编辑',
    dismiss: '忽略',
    create: '确认创建',
  },
  'en-US': {
    preview: 'Scheduled task draft',
    scheduleType: 'Schedule type',
    schedule: 'Schedule',
    timezone: 'Time zone',
    content: 'Execution content',
    description: 'Description',
    edit: 'Edit',
    dismiss: 'Ignore',
    create: 'Create scheduled task',
  },
} as const satisfies Record<AppLocale, Record<string, string>>;

beforeEach(() => {
  mocks.notifyError.mockReset();
  mocks.notifySuccess.mockReset();
  mocks.notifyWarning.mockReset();
});

describe('ScheduledDraftCard actions', () => {
  it('confirms the complete persisted draft', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <ScheduledDraftCard draft={draft} onConfirm={onConfirm} onDismiss={vi.fn()} />,
    );

    expect(screen.getByText('Daily price check')).toBeTruthy();
    expect(screen.getByText('Check and summarize the A1 price')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '确认创建' }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(draft);
  });

  it('dismisses without confirming', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onDismiss = vi.fn();
    render(
      <ScheduledDraftCard draft={draft} onConfirm={onConfirm} onDismiss={onDismiss} />,
    );

    await user.click(screen.getByRole('button', { name: '忽略' }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('ScheduledDraftCard semantic locale matrix', () => {
  it.each(['zh-CN', 'en-US'] as const)(
    'localizes draft chrome in %s while preserving raw task content',
    async (locale) => {
      const user = userEvent.setup();
      const text = copy[locale];
      render(<ScheduledDraftCard draft={draft} onConfirm={vi.fn()} onDismiss={vi.fn()} />, locale);

      expect(screen.getByText(text.preview)).toBeTruthy();
      expect(screen.getByText(text.schedule)).toBeTruthy();
      expect(screen.getByText(text.timezone)).toBeTruthy();
      expect(screen.getByText(text.content)).toBeTruthy();
      expect(screen.getByText(text.description)).toBeTruthy();
      expect(screen.getByText(draft.title)).toBeTruthy();
      expect(screen.getByText(draft.prompt)).toBeTruthy();
      expect(screen.getByText(draft.description || '')).toBeTruthy();

      await user.click(screen.getByRole('button', { name: text.edit }));
      expect(screen.getByText(text.scheduleType)).toBeTruthy();
      expect(screen.getByRole('button', { name: text.dismiss })).toBeTruthy();
      expect(screen.getByRole('button', { name: text.create })).toBeTruthy();
    },
  );

  it('formats a one-time placeholder with the active timezone and no fixed +08:00 example', async () => {
    const user = userEvent.setup();
    const onceDraft: ScheduledTaskDraftRead = {
      ...draft,
      schedule_type: 'once',
      schedule: { run_at: '2026-08-30T09:00:00Z' },
    };
    render(<ScheduledDraftCard draft={onceDraft} onConfirm={vi.fn()} onDismiss={vi.fn()} />, 'en-US');

    await user.click(screen.getByRole('button', { name: copy['en-US'].edit }));
    const scheduleInput = screen.getAllByRole('textbox')[1];
    expect(scheduleInput.getAttribute('placeholder')).not.toContain('+08:00');
    expect(scheduleInput.getAttribute('placeholder')).toContain(getClientTimeZone());
  });

  it('sends validation through a stable descriptor and never exposes raw validation prose', async () => {
    const user = userEvent.setup();
    render(
      <ScheduledDraftCard
        draft={{ ...draft, title: '' }}
        onConfirm={vi.fn()}
        onDismiss={vi.fn()}
      />,
      'en-US',
    );

    await user.click(screen.getByRole('button', { name: copy['en-US'].create }));

    expect(mocks.notifyWarning).toHaveBeenCalledWith({ id: 'chat.draft.titleRequired' });
    expect(JSON.stringify(mocks.notifyWarning.mock.calls)).not.toContain('请输入定时任务名称');
  });
});
