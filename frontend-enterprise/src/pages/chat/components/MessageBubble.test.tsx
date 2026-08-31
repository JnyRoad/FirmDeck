// @vitest-environment jsdom

import { StrictMode, type ReactElement } from 'react';
import { act, cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppIntlProvider } from '@/i18n';
import type { AppLocale } from '@/i18n/locales';
import type { AgentProfileRead, ChatMessage, ChatSlashCommand, TeamRead } from '@/types';

import type { UseChatSession } from '../useChatSession';
import MessageBubble, { type MessageRender } from './MessageBubble';

const copyTextToClipboardMock = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/clipboard', () => ({
  copyTextToClipboard: (text: string) => copyTextToClipboardMock(text),
}));

afterEach(() => {
  cleanup();
});

/** 为既有消息行为测试提供明确的语义 i18n runtime，避免回退到 legacy observer。 */
function render(
  ui: ReactElement,
  options?: Parameters<typeof rtlRender>[1],
  locale: AppLocale = 'zh-CN',
) {
  return rtlRender(
    <AppIntlProvider initialLocale={locale}>{ui}</AppIntlProvider>,
    options,
  );
}

const weatherCommand: ChatSlashCommand = {
  kind: 'skill',
  target: 'weather',
  label: 'weather',
  description: '查询天气',
  command: '/skill weather',
};

function renderSlashMessage(content: string, slashCommands: ChatSlashCommand[] = [weatherCommand]) {
  const item: ChatMessage = {
    id: 'message-1',
    role: 'user',
    content,
    created_at: '2026-08-09T00:00:00Z',
  };
  const messageRender: MessageRender = {
    traceTurnId: 'turn-1',
    summary: null,
    details: [],
    expanded: false,
    showInlineTrace: false,
    visibleContent: content,
    citations: [],
    scheduledDraft: null,
    scheduledTaskPrompt: false,
    attachments: [],
    harnessArtifacts: [],
    statusOnly: false,
  };
  const chat = {
    slashCommands,
    toggleTrace: vi.fn(),
    rateMessage: vi.fn(),
    setActiveCitation: vi.fn(),
    confirmScheduledTask: vi.fn(),
    dismissScheduledTaskDraft: vi.fn(),
    removeQueuedTurn: vi.fn(),
    tenantId: 'tenant_demo',
    activeConversationId: 'session-1',
  } as unknown as UseChatSession;
  return render(<MessageBubble chat={chat} item={item} render={messageRender} />);
}

describe('MessageBubble slash command card', () => {
  it('renders a sent slash command as a card beside its request text', () => {
    renderSlashMessage('/skill weather 北京天气如何');

    expect(screen.getByRole('group', { name: '技能 weather' })).toBeTruthy();
    expect(screen.getByText('北京天气如何')).toBeTruthy();
    expect(screen.queryByText('/skill weather 北京天气如何')).toBeNull();
  });

  it('keeps the card when the referenced resource is no longer listed', () => {
    renderSlashMessage('/skill archived_weather 北京天气如何', []);

    expect(screen.getByRole('group', { name: '技能 archived_weather' })).toBeTruthy();
  });
});

describe('MessageBubble responsive sizing', () => {
  it('keeps a short user message out of a shrink-to-fit wrapper', () => {
    renderSlashMessage('确认', []);

    const message = screen.getByText('确认');
    const bubble = message.parentElement?.parentElement;
    expect(bubble?.parentElement?.classList.contains('contents')).toBe(true);
  });
});

describe('MessageBubble team group identity', () => {
  it('shows the project leader avatar and name beside assistant messages', () => {
    const item: ChatMessage = {
      id: 'message-team-1',
      role: 'assistant',
      content: '团队回复',
      created_at: '2026-08-15T00:00:00Z',
    };
    const messageRender: MessageRender = {
      traceTurnId: 'turn-team-1',
      summary: null,
      details: [],
      expanded: false,
      showInlineTrace: false,
      visibleContent: item.content,
      citations: [],
      scheduledDraft: null,
      scheduledTaskPrompt: false,
      attachments: [],
      harnessArtifacts: [],
      statusOnly: false,
    };
    const leader = {
      id: 'agent-leader',
      tenant_id: 'tenant_demo',
      name: '人事',
      is_overall: false,
      status: 'active',
      metadata: { employee_profile: { avatar_text: '人', avatar_preset: 'ops-grid' } },
      resources: [],
      created_at: '2026-08-15T00:00:00Z',
      updated_at: '2026-08-15T00:00:00Z',
    } as AgentProfileRead;
    const chat = {
      displayedTeam: { id: 'team-1', name: '项目组' } as TeamRead,
      displayedAgent: leader,
      slashCommands: [],
      toggleTrace: vi.fn(),
      rateMessage: vi.fn(),
      setActiveCitation: vi.fn(),
      confirmScheduledTask: vi.fn(),
      dismissScheduledTaskDraft: vi.fn(),
      removeQueuedTurn: vi.fn(),
      tenantId: 'tenant_demo',
      activeConversationId: 'session-team-1',
    } as unknown as UseChatSession;

    render(<MessageBubble chat={chat} item={item} render={messageRender} />);

    expect(screen.getByLabelText(/员工头像/)).toBeTruthy();
    expect(screen.getByText('人事')).toBeTruthy();
    expect(screen.getByText('项目领导')).toBeTruthy();
    expect(screen.getByText('团队回复')).toBeTruthy();
  });

  it.each([
    ['zh-CN', '已收到全部 2 项成员回复，正在整理答案。'],
    ['en-US', 'Received all 2 member replies. Organizing the answer.'],
  ] as const)('localizes canonical live team progress in %s and hides raw status text', (locale, expected) => {
    const item: ChatMessage = {
      id: 'message-team-progress',
      role: 'assistant',
      content: 'Split and dispatched 2 team tasks.',
      metadata: {
        team_run_id: 'team-run-1',
        team_progress: {
          phase: 'synthesizing',
          completed_tasks: 2,
          total_tasks: 2,
          event_code: 'team.run.progress.synthesizing',
          params: { total_tasks: 2 },
          status_text: 'LEGACY_STATUS_MUST_NOT_DRIVE_UI',
        },
      },
      created_at: '2026-08-15T00:00:00Z',
    };
    const messageRender: MessageRender = {
      traceTurnId: 'turn-team-progress',
      summary: null,
      details: [],
      expanded: false,
      showInlineTrace: false,
      visibleContent: item.content,
      citations: [],
      scheduledDraft: null,
      scheduledTaskPrompt: false,
      attachments: [],
      harnessArtifacts: [],
      statusOnly: false,
    };
    const chat = {
      displayedTeam: { id: 'team-1', name: '项目组' } as TeamRead,
      slashCommands: [],
      toggleTrace: vi.fn(),
      rateMessage: vi.fn(),
      setActiveCitation: vi.fn(),
      confirmScheduledTask: vi.fn(),
      dismissScheduledTaskDraft: vi.fn(),
      removeQueuedTurn: vi.fn(),
      tenantId: 'tenant_demo',
      activeConversationId: 'session-team-1',
    } as unknown as UseChatSession;

    const { container } = render(
      <MessageBubble chat={chat} item={item} render={messageRender} />,
      undefined,
      locale,
    );

    expect(screen.getByText('Split and dispatched 2 team tasks.')).toBeTruthy();
    expect(screen.getByRole('status', { name: expected })).toBeTruthy();
    expect(screen.queryByText('LEGACY_STATUS_MUST_NOT_DRIVE_UI')).toBeNull();
    expect(container.querySelector('button[aria-label="点赞"]')).toBeNull();
  });

  it('fails closed for malformed canonical team progress instead of displaying raw text', () => {
    const item: ChatMessage = {
      id: 'message-team-progress-malformed',
      role: 'assistant',
      content: 'Raw assistant reply remains unchanged.',
      metadata: {
        team_run_id: 'team-run-1',
        team_progress: {
          phase: 'collecting',
          event_code: 'team.run.progress.collecting',
          params: { completed_tasks: 'one', total_tasks: 2 },
          status_text: 'RAW_STATUS_MUST_NOT_RENDER',
        },
      },
      created_at: '2026-08-15T00:00:00Z',
    };
    const messageRender: MessageRender = {
      traceTurnId: 'turn-team-progress-malformed',
      summary: null,
      details: [],
      expanded: false,
      showInlineTrace: false,
      visibleContent: item.content,
      citations: [],
      scheduledDraft: null,
      scheduledTaskPrompt: false,
      attachments: [],
      harnessArtifacts: [],
      statusOnly: false,
    };
    const chat = {
      displayedTeam: { id: 'team-1', name: 'Project Team' } as TeamRead,
      slashCommands: [],
      toggleTrace: vi.fn(),
      rateMessage: vi.fn(),
      setActiveCitation: vi.fn(),
      confirmScheduledTask: vi.fn(),
      dismissScheduledTaskDraft: vi.fn(),
      removeQueuedTurn: vi.fn(),
      tenantId: 'tenant_demo',
      activeConversationId: 'session-team-1',
    } as unknown as UseChatSession;

    render(<MessageBubble chat={chat} item={item} render={messageRender} />, undefined, 'en-US');

    expect(screen.getByRole('status', { name: 'Thinking' })).toBeTruthy();
    expect(screen.queryByText('RAW_STATUS_MUST_NOT_RENDER')).toBeNull();
  });
});

describe('MessageBubble copy button', () => {
  function baseChat(overrides: Partial<UseChatSession> = {}): UseChatSession {
    return {
      slashCommands: [],
      toggleTrace: vi.fn(),
      rateMessage: vi.fn(),
      setActiveCitation: vi.fn(),
      confirmScheduledTask: vi.fn(),
      dismissScheduledTaskDraft: vi.fn(),
      removeQueuedTurn: vi.fn(),
      tenantId: 'tenant_demo',
      activeConversationId: 'session-1',
      ...overrides,
    } as unknown as UseChatSession;
  }

  it('keeps assistant feedback ahead of copy and reveals the actions on message hover', () => {
    const item: ChatMessage = {
      id: 'message-assistant-actions',
      role: 'assistant',
      content: '这是助手的回复内容',
      created_at: '2026-08-15T00:00:00Z',
    };
    const messageRender: MessageRender = {
      traceTurnId: 'turn-assistant-actions',
      summary: null,
      details: [],
      expanded: false,
      showInlineTrace: false,
      visibleContent: item.content,
      citations: [],
      scheduledDraft: null,
      scheduledTaskPrompt: false,
      attachments: [],
      harnessArtifacts: [],
      statusOnly: false,
    };

    const { container } = render(<MessageBubble chat={baseChat()} item={item} render={messageRender} />);
    const actionButtons = screen.getAllByRole('button');
    const actions = actionButtons[0].parentElement;

    expect(actionButtons.map((button) => button.getAttribute('aria-label'))).toEqual(['点赞', '点踩', '复制']);
    expect(container.firstElementChild?.className).toContain('group/message');
    expect(actions?.className).toContain('max-h-0');
    expect(actions?.className).toContain('opacity-0');
    expect(actions?.className).toContain('group-hover/message:max-h-[28px]');
    expect(actions?.className).toContain('group-focus-within/message:max-h-[28px]');
  });

  it('copies an assistant reply to the clipboard and shows confirmation', async () => {
    copyTextToClipboardMock.mockClear();
    const item: ChatMessage = {
      id: 'message-assistant-1',
      role: 'assistant',
      content: '这是助手的回复内容',
      created_at: '2026-08-15T00:00:00Z',
    };
    const messageRender: MessageRender = {
      traceTurnId: 'turn-assistant-1',
      summary: null,
      details: [],
      expanded: false,
      showInlineTrace: false,
      visibleContent: item.content,
      citations: [],
      scheduledDraft: null,
      scheduledTaskPrompt: false,
      attachments: [],
      harnessArtifacts: [],
      statusOnly: false,
    };

    render(<MessageBubble chat={baseChat()} item={item} render={messageRender} />);

    const copyButton = screen.getByRole('button', { name: '复制' });
    await userEvent.click(copyButton);

    expect(copyTextToClipboardMock).toHaveBeenCalledWith('这是助手的回复内容');
    await waitFor(() => expect(screen.getByRole('button', { name: '已复制' })).toBeTruthy());
  });

  it('reveals the plain user message copy action only on message hover', () => {
    const item: ChatMessage = {
      id: 'message-user-1',
      role: 'user',
      content: '你好，请介绍一下自己',
      created_at: '2026-08-15T00:00:00Z',
    };
    const messageRender: MessageRender = {
      traceTurnId: 'turn-user-1',
      summary: null,
      details: [],
      expanded: false,
      showInlineTrace: false,
      visibleContent: item.content,
      citations: [],
      scheduledDraft: null,
      scheduledTaskPrompt: false,
      attachments: [],
      harnessArtifacts: [],
      statusOnly: false,
    };

    const { container } = render(<MessageBubble chat={baseChat()} item={item} render={messageRender} />);
    const copyButton = screen.getByRole('button', { name: '复制' });
    const actions = copyButton.parentElement;

    expect(container.firstElementChild?.className).toContain('group/message');
    expect(actions?.className).toContain('max-h-0');
    expect(actions?.className).toContain('opacity-0');
    expect(actions?.className).toContain('group-hover/message:max-h-[28px]');
    expect(actions?.className).toContain('group-focus-within/message:max-h-[28px]');
  });

  it('hides the copy button while an assistant reply is still streaming', () => {
    const item: ChatMessage = {
      id: '__streaming_session-1_turn-1',
      role: 'assistant',
      content: '第一段',
      isStreaming: true,
      created_at: '2026-08-15T00:00:00Z',
    };
    const messageRender: MessageRender = {
      traceTurnId: 'turn-streaming-1',
      summary: null,
      details: [],
      expanded: false,
      showInlineTrace: false,
      visibleContent: item.content,
      citations: [],
      scheduledDraft: null,
      scheduledTaskPrompt: false,
      attachments: [],
      harnessArtifacts: [],
      statusOnly: false,
    };

    render(<MessageBubble chat={baseChat()} item={item} render={messageRender} />);

    expect(screen.queryByRole('button', { name: '复制' })).toBeNull();
  });

  it('restarts the confirmation window on a repeated click instead of cutting it short', async () => {
    const item: ChatMessage = {
      id: 'message-assistant-repeat-copy',
      role: 'assistant',
      content: '答案内容',
      created_at: '2026-08-15T00:00:00Z',
    };
    const messageRender: MessageRender = {
      traceTurnId: 'turn-repeat-copy',
      summary: null,
      details: [],
      expanded: false,
      showInlineTrace: false,
      visibleContent: item.content,
      citations: [],
      scheduledDraft: null,
      scheduledTaskPrompt: false,
      attachments: [],
      harnessArtifacts: [],
      statusOnly: false,
    };

    vi.useFakeTimers();
    try {
      render(<MessageBubble chat={baseChat()} item={item} render={messageRender} />);
      const copyButton = () => screen.getByRole('button', { name: /复制/ });

      await act(async () => {
        fireEvent.click(copyButton());
        await Promise.resolve();
      });
      expect(screen.getByRole('button', { name: '已复制' })).toBeTruthy();

      // 首次点击后 1490ms（快到 1500ms 超时）再次点击，确认窗口应当重新起算。
      act(() => {
        vi.advanceTimersByTime(1490);
      });
      await act(async () => {
        fireEvent.click(copyButton());
        await Promise.resolve();
      });

      // 若计时器没有被重置，旧计时器会在此刻（累计 1490+20=1510ms）把状态改回「复制」。
      act(() => {
        vi.advanceTimersByTime(20);
      });
      expect(screen.getByRole('button', { name: '已复制' })).toBeTruthy();

      // 新计时器从第二次点击算起，1500ms 后才应过期。
      act(() => {
        vi.advanceTimersByTime(1480);
      });
      expect(screen.getByRole('button', { name: '复制' })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a clipboard write that resolves after the component has unmounted', async () => {
    let resolveCopy: () => void = () => {};
    copyTextToClipboardMock.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveCopy = resolve;
    }));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const item: ChatMessage = {
      id: 'message-assistant-unmount',
      role: 'assistant',
      content: '答案内容',
      created_at: '2026-08-15T00:00:00Z',
    };
    const messageRender: MessageRender = {
      traceTurnId: 'turn-unmount',
      summary: null,
      details: [],
      expanded: false,
      showInlineTrace: false,
      visibleContent: item.content,
      citations: [],
      scheduledDraft: null,
      scheduledTaskPrompt: false,
      attachments: [],
      harnessArtifacts: [],
      statusOnly: false,
    };

    const { unmount } = render(<MessageBubble chat={baseChat()} item={item} render={messageRender} />);
    fireEvent.click(screen.getByRole('button', { name: '复制' }));

    // 复制的剪贴板 Promise 还没 resolve，此时切换会话导致组件卸载。
    unmount();

    // Promise 在卸载之后才 resolve；不应有 setState-on-unmounted 警告，也不应遗留悬空计时器。
    await act(async () => {
      resolveCopy();
      await Promise.resolve();
    });

    expect(consoleErrorSpy).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it('still shows copy confirmation under StrictMode\'s dev-mode double mount/unmount cycle', async () => {
    copyTextToClipboardMock.mockClear();
    const item: ChatMessage = {
      id: 'message-assistant-strict-mode',
      role: 'assistant',
      content: '答案内容',
      created_at: '2026-08-15T00:00:00Z',
    };
    const messageRender: MessageRender = {
      traceTurnId: 'turn-strict-mode',
      summary: null,
      details: [],
      expanded: false,
      showInlineTrace: false,
      visibleContent: item.content,
      citations: [],
      scheduledDraft: null,
      scheduledTaskPrompt: false,
      attachments: [],
      harnessArtifacts: [],
      statusOnly: false,
    };

    // 应用入口用 <StrictMode> 包裹；开发模式下它会对每个组件多跑一轮
    // 挂载 -> 卸载 -> 再挂载，用来暴露没有正确处理该周期的副作用。
    render(
      <StrictMode>
        <MessageBubble chat={baseChat()} item={item} render={messageRender} />
      </StrictMode>,
    );

    const copyButton = screen.getByRole('button', { name: '复制' });
    await userEvent.click(copyButton);

    expect(copyTextToClipboardMock).toHaveBeenCalledWith('答案内容');
    await waitFor(() => expect(screen.getByRole('button', { name: '已复制' })).toBeTruthy());
  });
});

/** 在不挂载 legacy observer 的前提下，为聊天消息提供新的语义 i18n Provider。 */
function renderMessageWithAppLocale(
  locale: 'zh-CN' | 'en-US',
  item: ChatMessage,
  messageRender: MessageRender,
  chat: UseChatSession,
) {
  return render(
    <AppIntlProvider initialLocale={locale}>
      <MessageBubble chat={chat} item={item} render={messageRender} />
    </AppIntlProvider>,
  );
}

/** 构造只包含消息动作所需行为的聊天 facade，不引入 legacy Provider 或全局观察器。 */
function buildLocaleChat(): UseChatSession {
  return {
    slashCommands: [],
    toggleTrace: vi.fn(),
    rateMessage: vi.fn(),
    setActiveCitation: vi.fn(),
    confirmScheduledTask: vi.fn(),
    dismissScheduledTaskDraft: vi.fn(),
    removeQueuedTurn: vi.fn(),
    tenantId: 'tenant_demo',
    activeConversationId: 'session-i18n',
  } as unknown as UseChatSession;
}

/** 提取当前消息动作的可访问名称，比较 product chrome 而不是业务原始文本。 */
function messageActionLabels(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLButtonElement>('button')]
    .map((button) => button.getAttribute('aria-label') || button.textContent || '')
    .filter(Boolean);
}

describe('MessageBubble semantic locale and raw-content boundaries', () => {
  /** 验证 Agent 原始输出与附件原始值不变，同时消息操作和无障碍名称随 locale 改变。 */
  it('localizes product chrome without translating Agent output or attachment data', () => {
    const rawAgentOutput = 'Agent 原始输出：保留 <raw>& 用户内容';
    const rawFilename = '知识库/合同-中文.pdf';
    const rawAttachmentError = 'provider_raw_error: 中文详情';
    const item: ChatMessage = {
      id: 'message-i18n-agent',
      role: 'assistant',
      content: rawAgentOutput,
      created_at: '2026-08-15T00:00:00Z',
    };
    const messageRender: MessageRender = {
      traceTurnId: 'turn-i18n-agent',
      summary: null,
      details: [],
      expanded: false,
      showInlineTrace: false,
      visibleContent: rawAgentOutput,
      citations: [],
      scheduledDraft: null,
      scheduledTaskPrompt: false,
      attachments: [{
        id: 'attachment-i18n',
        filename: rawFilename,
        content_type: 'application/pdf',
        size: 42,
        kind: 'pdf',
        error: rawAttachmentError,
      }],
      harnessArtifacts: [],
      statusOnly: false,
    };
    const chat = buildLocaleChat();

    const zhView = renderMessageWithAppLocale('zh-CN', item, messageRender, chat);
    const zhText = zhView.container.textContent || '';
    const zhActions = messageActionLabels(zhView.container);
    zhView.unmount();

    const enView = renderMessageWithAppLocale('en-US', item, messageRender, chat);
    const enText = enView.container.textContent || '';
    const enActions = messageActionLabels(enView.container);

    expect(zhText).toContain(rawAgentOutput);
    expect(zhText).toContain(rawFilename);
    expect(zhText).toContain(rawAttachmentError);
    expect(enText).toContain(rawAgentOutput);
    expect(enText).toContain(rawFilename);
    expect(enText).toContain(rawAttachmentError);
    expect(enActions).not.toEqual(zhActions);
  });

  /** 验证用户输入在 locale 切换后保持逐字一致，且复制反馈属于可翻译的产品 chrome。 */
  it('keeps user-authored message content byte-for-byte stable across locales', () => {
    const rawUserInput = '用户输入：不要翻译这段业务内容 / keep verbatim';
    const item: ChatMessage = {
      id: 'message-i18n-user',
      role: 'user',
      content: rawUserInput,
      created_at: '2026-08-15T00:00:00Z',
    };
    const messageRender: MessageRender = {
      traceTurnId: 'turn-i18n-user',
      summary: null,
      details: [],
      expanded: false,
      showInlineTrace: false,
      visibleContent: rawUserInput,
      citations: [],
      scheduledDraft: null,
      scheduledTaskPrompt: false,
      attachments: [],
      harnessArtifacts: [],
      statusOnly: false,
    };
    const chat = buildLocaleChat();

    const zhView = renderMessageWithAppLocale('zh-CN', item, messageRender, chat);
    const zhText = zhView.container.textContent || '';
    const zhActions = messageActionLabels(zhView.container);
    zhView.unmount();

    const enView = renderMessageWithAppLocale('en-US', item, messageRender, chat);
    const enText = enView.container.textContent || '';
    const enActions = messageActionLabels(enView.container);

    expect(zhText).toContain(rawUserInput);
    expect(enText).toContain(rawUserInput);
    expect(enActions).not.toEqual(zhActions);
  });
});
