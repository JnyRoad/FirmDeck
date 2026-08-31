// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppIntlProvider, type AppLocale } from '@/i18n';

import type { ChatTurnResponse } from '../types';
import DebugPage from './DebugPage';

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  notifyError: vi.fn(),
  notifySuccess: vi.fn(),
}));

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    api: { ...actual.api, post: mocks.post },
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
    title: '检索调试',
    session: '会话',
    input: '输入消息，按 Enter 发送…',
    send: '发送',
    snapshot: '执行记录',
    router: '判断意图',
    step: '决定下一步',
    tool: '查看工具结果',
    sessionState: '上下文摘要',
  },
  'en-US': {
    title: 'Search debug',
    session: 'Session',
    input: 'Type a message and press Enter to send…',
    send: 'Send',
    snapshot: 'Execution record',
    router: 'Determine intent',
    step: 'Deciding next step',
    tool: 'View tool result',
    sessionState: 'Context summary',
  },
} as const satisfies Record<AppLocale, Record<string, string>>;

beforeEach(() => {
  mocks.post.mockReset();
  mocks.notifyError.mockReset();
  mocks.notifySuccess.mockReset();
});

afterEach(() => {
  cleanup();
});

/** 在指定 UI locale 下渲染调试页，验证语义 Provider 而不是 legacy observer。 */
function renderDebug(locale: AppLocale) {
  return render(
    <AppIntlProvider locale={locale}>
      <DebugPage />
    </AppIntlProvider>,
  );
}

/** 构造成功 turn，保留回复、会话标识和诊断对象作为 raw 数据。 */
function successfulTurn(reply: string, sessionId: string): ChatTurnResponse {
  return {
    reply,
    session_id: sessionId,
    router_decision: { raw_provider_trace: 'provider stdout: keep verbatim' },
    step_result: { raw_step_output: 'step output: keep verbatim' },
    tool_result: { raw_tool_output: 'tool output: keep verbatim' },
    session_state: { raw_session_state: 'session state: keep verbatim' },
  };
}

describe('DebugPage semantic locale matrix', () => {
  it.each(['zh-CN', 'en-US'] as const)(
    'localizes product chrome and accessible names in %s',
    async (locale) => {
      const text = copy[locale];
      const user = userEvent.setup();
      renderDebug(locale);

      expect(screen.getByRole('heading', { name: text.title })).toBeTruthy();
      expect(screen.getByPlaceholderText(text.session)).toBeTruthy();
      expect(screen.getByPlaceholderText(text.input)).toBeTruthy();
      expect(screen.getByRole('button', { name: text.send })).toBeTruthy();
      expect(screen.getByText(text.snapshot)).toBeTruthy();
      expect(screen.getByRole('button', { name: text.router })).toBeTruthy();
      expect(screen.getByRole('button', { name: text.step })).toBeTruthy();
      expect(screen.getByRole('button', { name: text.tool })).toBeTruthy();
      expect(screen.getByRole('button', { name: text.sessionState })).toBeTruthy();

      await user.click(screen.getByRole('button', { name: text.send }));
    },
  );

  it('projects a failed turn to a stable descriptor without exposing the raw exception', async () => {
    const user = userEvent.setup();
    const rawProviderError = 'provider secret: connection refused at 10.0.0.8';
    mocks.post.mockRejectedValue(new Error(rawProviderError));
    renderDebug('en-US');

    await user.type(screen.getByPlaceholderText(copy['en-US'].input), 'probe');
    await user.click(screen.getByRole('button', { name: copy['en-US'].send }));

    await waitFor(() => {
      expect(mocks.notifyError).toHaveBeenCalledWith({ id: 'chat.error.replyFailed' });
    });
    expect(JSON.stringify(mocks.notifyError.mock.calls)).not.toContain(rawProviderError);
  });

  it('keeps session identifiers and turn diagnostics verbatim in both locales', async () => {
    const user = userEvent.setup();
    const rawReply = 'Agent raw output: 中文业务内容 / keep verbatim';
    const rawSessionId = 'session/raw-中文-42';
    mocks.post.mockResolvedValue(successfulTurn(rawReply, rawSessionId));

    for (const locale of ['zh-CN', 'en-US'] as const) {
      const view = renderDebug(locale);
      await user.type(screen.getByPlaceholderText(copy[locale].input), '用户原始输入');
      await user.click(screen.getByRole('button', { name: copy[locale].send }));

      await waitFor(() => expect(screen.getByDisplayValue(rawSessionId)).toBeTruthy());
      expect(screen.getByText(rawReply)).toBeTruthy();
      await user.click(screen.getByRole('button', { name: copy[locale].step }));
      await user.click(screen.getByRole('button', { name: copy[locale].tool }));
      const rawNodes = [...document.querySelectorAll('[data-i18n-raw-kind="content"]')];
      expect(rawNodes.some((node) => node.textContent?.includes('provider stdout: keep verbatim'))).toBe(true);
      expect(rawNodes.some((node) => node.textContent?.includes('step output: keep verbatim'))).toBe(true);
      expect(rawNodes.some((node) => node.textContent?.includes('tool output: keep verbatim'))).toBe(true);
      expect(rawNodes.some((node) => node.textContent?.includes('session state: keep verbatim'))).toBe(true);
      view.unmount();
    }
  });
});
