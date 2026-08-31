// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppIntlProvider, type AppLocale } from '@/i18n';
import type { TraceSummary } from '@/types';

import TracesPage from './TracesPage';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  notifyError: vi.fn(),
  notifySuccess: vi.fn(),
}));

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    api: { ...actual.api, get: mocks.get },
    TENANT_ID: 'tenant_demo',
  };
});

vi.mock('@/components/ui/app-toast', () => ({
  notify: {
    error: mocks.notifyError,
    success: mocks.notifySuccess,
  },
  createToastNotifier: () => ({
    error: mocks.notifyError,
    success: mocks.notifySuccess,
  }),
}));

const copy = {
  'zh-CN': {
    pageTitle: '执行记录',
    refresh: '刷新',
    cardTitle: '对话日志',
    tableAria: '对话日志',
    empty: '暂无',
    pagination: '对话日志分页',
    detailTitle: '执行报告',
    session: '会话',
    user: '操作者 ID',
    skill: '技能 ID',
    step: '节点 ID',
    tool: '展示工具调用',
    status: '状态',
    updated: '最近更新',
    actions: '操作',
    view: '详情',
  },
  'en-US': {
    pageTitle: 'Execution record',
    refresh: 'Refresh',
    cardTitle: 'Conversation Logs',
    tableAria: 'Conversation Logs',
    empty: 'None',
    pagination: 'Conversation Logs pagination',
    detailTitle: 'Execution report',
    session: 'Session',
    user: 'Actor ID',
    skill: 'Skill ID',
    step: 'Node ID',
    tool: 'Show tool calls',
    status: 'Status',
    updated: 'Updated at',
    actions: 'Actions',
    view: 'Details',
  },
} as const satisfies Record<AppLocale, Record<string, string>>;

const row: TraceSummary = {
  session_id: 'session/raw-中文-42',
  user_id: 'user/raw-中文-7',
  active_skill_id: 'skill/raw-中文',
  active_step_id: 'step/raw-中文',
  tool_call_count: 3,
  status: 'provider_status_RAW',
  updated_at: '2026-08-30T08:44:47Z',
};

beforeEach(() => {
  mocks.get.mockReset();
  mocks.notifyError.mockReset();
  mocks.notifySuccess.mockReset();
});

afterEach(() => {
  cleanup();
});

/** 在指定 UI locale 下渲染 trace 列表，测试只观察产品 chrome 和 raw 数据边界。 */
function renderTraces(locale: AppLocale) {
  return render(
    <AppIntlProvider locale={locale}>
      <TracesPage />
    </AppIntlProvider>,
  );
}

describe('TracesPage semantic locale matrix', () => {
  it.each(['zh-CN', 'en-US'] as const)(
    'localizes table chrome and accessible names in %s while preserving raw rows',
    async (locale) => {
      const text = copy[locale];
      mocks.get.mockResolvedValue([row]);
      renderTraces(locale);

      expect(screen.getByRole('heading', { name: text.pageTitle })).toBeTruthy();
      expect(screen.getByRole('button', { name: text.refresh })).toBeTruthy();
      expect(screen.getByText(text.cardTitle)).toBeTruthy();
      expect(screen.getByRole('table', { name: text.tableAria })).toBeTruthy();
      expect(await screen.findByText(row.session_id)).toBeTruthy();
      expect(screen.getByText(String(row.user_id))).toBeTruthy();
      expect(screen.getByText(String(row.active_skill_id))).toBeTruthy();
      expect(screen.getByText(String(row.active_step_id))).toBeTruthy();
      expect(screen.getByText(row.status)).toBeTruthy();
      expect(screen.getByText(row.updated_at)).toBeTruthy();
      expect(screen.getByRole('button', { name: text.view })).toBeTruthy();

      const headers = [...screen.getAllByRole('columnheader')].map((header) => header.textContent);
      expect(headers).toEqual([
        text.session,
        text.user,
        text.skill,
        text.step,
        text.tool,
        text.status,
        text.updated,
        text.actions,
      ]);
    },
  );

  it('uses a localized stable descriptor for trace load failures without exposing error.message', async () => {
    const rawProviderError = 'provider body secret: connection refused';
    mocks.get.mockRejectedValue(new Error(rawProviderError));
    renderTraces('en-US');

    await waitFor(() => {
      expect(mocks.notifyError).toHaveBeenCalledWith({ id: 'chat.error.traceLoad' });
    });
    expect(JSON.stringify(mocks.notifyError.mock.calls)).not.toContain(rawProviderError);
  });

  it('keeps trace payload raw when the detail view is opened', async () => {
    const user = userEvent.setup();
    const rawTracePayload = 'provider stdout: raw trace payload 中文';
    mocks.get.mockImplementation((path: string) => (
      path.includes(row.session_id)
        ? Promise.resolve({ trace_payload: rawTracePayload, stderr: 'provider stderr raw' })
        : Promise.resolve([row])
    ));
    const view = renderTraces('zh-CN');

    await user.click(await screen.findByRole('button', { name: copy['zh-CN'].view }));
    await waitFor(() => expect(document.querySelector('[data-i18n-raw-kind="content"]')).toBeTruthy());
    const rawNodes = [...document.querySelectorAll('[data-i18n-raw-kind="content"]')];
    expect(rawNodes.some((node) => node.textContent?.includes(rawTracePayload))).toBe(true);
    expect(rawNodes.some((node) => node.textContent?.includes('provider stderr raw'))).toBe(true);
    expect(screen.getByText(copy['zh-CN'].detailTitle)).toBeTruthy();
  });
});
