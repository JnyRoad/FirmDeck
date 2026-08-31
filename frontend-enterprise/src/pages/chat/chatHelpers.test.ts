import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AppIntlProvider, createAppTranslator } from '@/i18n';
import type { ChatMessage } from '@/types';

import {
  STREAM_TERMINAL_EVENTS,
  MarkdownMessage,
  attachmentTypeLabel,
  canRateMessage,
  formatDraftSchedule,
  harnessEventTraceLine,
  harnessWorkspaceArtifacts,
  knowledgeCitations,
  messageAttachments,
  renderInlineMarkdown,
  routerDecisionTraceLine,
  scheduledDraftForMessage,
  shouldDeferPersistedEventToLiveStream,
  streamErrorTraceLine,
  stripTrailingCitationSummary,
  traceSummary,
} from './chatHelpers';

const { t: translate } = createAppTranslator('zh-CN');
const { t: translateEnglish } = createAppTranslator('en-US');

/** 在显式语义 i18n Provider 中渲染 Markdown，确保图片宿主 ARIA 使用当前 locale。 */
function renderLocalizedMarkdown(content: string, preserveLineBreaks = true): string {
  return renderToStaticMarkup(
    createElement(
      AppIntlProvider,
      {
        initialLocale: 'zh-CN',
        children: createElement(MarkdownMessage, { content, preserveLineBreaks }),
      },
    ),
  );
}

function message(patch: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg-assistant-1',
    role: 'assistant',
    content: 'Answer [1] and [2]',
    created_at: '2026-07-27T00:00:00Z',
    metadata: {},
    ...patch,
  };
}

describe('chat history consumer contract', () => {
  it('keeps inline citations but removes duplicate trailing citation summaries', () => {
    const content = [
      '请假制度按员工手册执行[1]，办公用品按行政手册执行[5]。',
      '',
      '## 参考来源',
      '',
      '- [1] 人事-员工手册与假期政策：事假',
      '- [5] 行政-行政服务手册：办公用品申领',
      '',
      '参考来源：[1] [5]',
    ].join('\n');

    expect(stripTrailingCitationSummary(content)).toBe(
      '请假制度按员工手册执行[1]，办公用品按行政手册执行[5]。',
    );
  });

  it('removes a trailing citation-label footer without changing the answer', () => {
    expect(stripTrailingCitationSummary('正文保留[1]。\n\n参考资料：[1] [2]')).toBe(
      '正文保留[1]。',
    );
  });

  it('preserves ordinary prose that mentions a source', () => {
    const content = '参考来源：员工手册，具体以最新制度为准。';
    expect(stripTrailingCitationSummary(content)).toBe(content);
  });

  it('continues top-level process numbering across blank lines and bullet details', () => {
    const rendered = renderLocalizedMarkdown([
          '## 用印审批流程指引',
          '',
          '1. **申请入口**：登录审批系统',
          '',
          '1. **填写表单**：填写以下字段',
          '',
          '- 我方主体名称',
          '- 申请日期',
          '',
          '1. **审批流程**：提交申请',
          '',
          '- 直属上级审批',
          '',
          '1. **用印办理**：前往办公室盖章',
        ].join('\n'));

    expect(rendered.match(/<ol(?: start="\d+")?>/g)).toEqual([
      '<ol>',
      '<ol start="2">',
      '<ol start="3">',
      '<ol start="4">',
    ]);
  });

  it('restarts an ordered list after regular paragraph content', () => {
    const rendered = renderLocalizedMarkdown(['1. 第一组', '', '这是新的正文段落。', '', '1. 第二组'].join('\n'));

    expect(rendered.match(/<ol(?: start="\d+")?>/g)).toEqual(['<ol>', '<ol>']);
  });

  it('renders bare HTTP links without changing existing Markdown links or inline code', () => {
    const rendered = renderToStaticMarkup(
      createElement(
        'div',
        null,
        ...renderInlineMarkdown(
          '详情见 https://example.com/docs?a=1。[官网](https://example.org) `https://internal.test`',
          'test',
        ),
      ),
    );

    expect(rendered).toContain(
      '<a href="https://example.com/docs?a=1" target="_blank" rel="noreferrer">https://example.com/docs?a=1</a>。',
    );
    expect(rendered).toContain(
      '<a href="https://example.org/" target="_blank" rel="noreferrer">官网</a>',
    );
    expect(rendered).toContain('<code>https://internal.test</code>');
    expect(rendered.match(/href=/g)).toHaveLength(2);
  });

  it('makes www links clickable by adding a safe HTTPS target', () => {
    const rendered = renderToStaticMarkup(
      createElement(
        'div',
        null,
        ...renderInlineMarkdown('随便给你一个网站：www.baidu.com。', 'test-www'),
      ),
    );

    expect(rendered).toContain(
      '<a href="https://www.baidu.com/" target="_blank" rel="noreferrer">www.baidu.com</a>。',
    );
  });

  it('does not turn unsafe or malformed Markdown targets into external links', () => {
    const rendered = renderToStaticMarkup(
      createElement(
        'div',
        null,
        ...renderInlineMarkdown(
          '[unsafe](javascript:alert(1)) [broken](https://[invalid) [safe](https://example.com/docs)',
          'test-safe-links',
        ),
      ),
    );

    expect(rendered).not.toContain('href="javascript:');
    expect(rendered).not.toContain('href="https://[invalid');
    expect(rendered).toContain(
      '<a href="https://example.com/docs" target="_blank" rel="noreferrer">safe</a>',
    );
  });

  it('renders safe Markdown images and keeps unsafe image targets as text', () => {
    const rendered = renderLocalizedMarkdown([
          '![趋势图](https://images.example.com/chart.png)',
          '',
          '![危险图片](javascript:alert(1))',
        ].join('\n'));

    expect(rendered).toContain('src="https://images.example.com/chart.png"');
    expect(rendered).toContain('alt="趋势图"');
    expect(rendered).toContain('referrerPolicy="no-referrer"');
    expect(rendered).toContain('aria-label="查看图片：趋势图"');
    expect(rendered).toContain('危险图片');
    expect(rendered).not.toContain('危险图片)');
    expect(rendered).not.toContain('src="javascript:');
  });

  it('prefers inline citations, deduplicates content, and falls back to source metadata', () => {
    const item = message({
      metadata: {
        knowledge_citations: [
          { id: 'citation-2', label: '[2]', title: 'Refund policy' },
          { id: 'citation-duplicate', label: '[1]', title: 'Purchase policy' },
          { id: 'citation-1', label: '[1]', title: 'Purchase policy' },
          { id: 'citation-unused', label: '[3]', title: 'Unused policy' },
        ],
      },
    });

    expect(knowledgeCitations(item, item.content)).toEqual([
      expect.objectContaining({ id: 'citation-duplicate', label: '[1]' }),
      expect.objectContaining({ id: 'citation-2', label: '[2]' }),
    ]);
    expect(knowledgeCitations(item, 'No inline citation markers')).toEqual([
      expect.objectContaining({ id: 'citation-duplicate', label: '[1]' }),
      expect.objectContaining({ id: 'citation-2', label: '[2]' }),
      expect.objectContaining({ id: 'citation-unused', label: '[3]' }),
    ]);
  });

  it('keeps separately cited chunks even when their display titles match', () => {
    const item = message({
      metadata: {
        knowledge_citations: [
          { id: 'citation-1', chunk_id: 'chunk-1', label: '[1]', title: '同一制度' },
          { id: 'citation-2', chunk_id: 'chunk-2', label: '[2]', title: '同一制度' },
        ],
      },
    });

    expect(knowledgeCitations(item, item.content)).toEqual([
      expect.objectContaining({ id: 'citation-1', label: '[1]' }),
      expect.objectContaining({ id: 'citation-2', label: '[2]' }),
    ]);
  });

  it('restores scheduled drafts and attachments from persisted metadata', () => {
    const draft = {
      should_create: true,
      tenant_id: 'tenant-demo',
      agent_id: 'agent-demo',
      title: 'Daily price check',
      prompt: 'Check the A1 price',
      schedule_type: 'daily' as const,
      schedule: { time: '09:00' },
      timezone: 'Asia/Shanghai',
      confidence: 1,
    };
    const attachment = {
      id: 'attachment-1',
      filename: 'notes.txt',
      content_type: 'text/plain',
      size: 12,
      kind: 'text' as const,
      text: 'Body text',
    };
    const item = message({
      metadata: ({
        scheduled_task_draft: draft,
        attachments: [attachment, { filename: 'missing-id.txt' }],
      } as unknown) as ChatMessage['metadata'],
    });

    expect(scheduledDraftForMessage(item)).toEqual(draft);
    expect(messageAttachments(item)).toEqual([attachment]);
  });

  it('keeps only valid, unique workspace artifacts from persisted metadata', () => {
    const item = message({
      metadata: {
        harness_artifacts: [
          {
            type: 'workspace_file',
            task_frame_id: 'task-1',
            path: 'reports/result.txt',
            size: 12,
            display_name: '季度报告.txt',
            description: '最终版',
            content_type: 'text/plain',
            source: 'harness',
          },
          {
            type: 'workspace_file',
            task_frame_id: 'task-1',
            path: 'reports/result.txt',
            size: 14,
          },
          { type: 'human_handoff', handoff_id: 'handoff-1' },
          { type: 'workspace_file', task_frame_id: '', path: 'invalid.txt' },
        ],
      },
    });

    expect(harnessWorkspaceArtifacts(item)).toEqual([
      {
        type: 'workspace_file',
        task_frame_id: 'task-1',
        path: 'reports/result.txt',
        size: 12,
        display_name: '季度报告.txt',
        description: '最终版',
        content_type: 'text/plain',
        source: 'harness',
      },
    ]);
  });

  it('allows feedback only for committed assistant messages', () => {
    expect(canRateMessage(message())).toBe(true);
    expect(canRateMessage(message({ isStreaming: true }))).toBe(false);
    expect(canRateMessage(message({ isError: true }))).toBe(false);
    expect(canRateMessage(message({ id: '__streaming__' }))).toBe(false);
    expect(canRateMessage(message({ role: 'user' }))).toBe(false);
  });

  it('locks the legacy frontend terminal vocabulary', () => {
    expect([...STREAM_TERMINAL_EVENTS].sort()).toEqual([
      'complete',
      'done',
      'error',
      'error_occurred',
      'stream_cancelled',
      'stream_end',
      'stream_interrupted',
    ]);
  });

  /** 验证 trace、附件和排程摘要使用当前 locale，同时保留工具名等 raw 业务值。 */
  it('localizes helper chrome without translating raw values', () => {
    const rawToolName = '工具-中文-raw';
    const rawIntent = '采购流程';
    const rawToolLine = harnessEventTraceLine('harness_action_created', {
      task_frame_id: 'task-locale',
      action: 'tool',
      tool_name: rawToolName,
    }, translateEnglish);
    const zhRouter = routerDecisionTraceLine({ user_intent: rawIntent }, translate);
    const enRouter = routerDecisionTraceLine({ user_intent: rawIntent }, translateEnglish);
    const zhError = streamErrorTraceLine({ code: 'PROVIDER_FAILURE' }, 'error', translate);
    const enError = streamErrorTraceLine({ code: 'PROVIDER_FAILURE' }, 'error', translateEnglish);
    const attachment = {
      id: 'attachment-locale',
      filename: '原始文件.txt',
      content_type: 'text/plain',
      size: 2048,
      kind: 'text' as const,
      text: 'raw body',
    };
    const draft = {
      should_create: true,
      tenant_id: 'tenant-demo',
      agent_id: 'agent-demo',
      title: 'raw schedule title',
      prompt: 'raw schedule prompt',
      schedule_type: 'weekly' as const,
      schedule: { weekdays: [0, 2], time: '09:30' },
      timezone: 'Asia/Shanghai',
      confidence: 1,
    };

    expect(zhRouter.text).toContain(rawIntent);
    expect(enRouter.text).toContain(rawIntent);
    expect(zhRouter.text).not.toBe(enRouter.text);
    expect(zhError.text).not.toBe(enError.text);
    expect(zhError.detail).toContain('PROVIDER_FAILURE');
    expect(attachmentTypeLabel(attachment, 'zh-CN', translate)).toContain('文本');
    expect(attachmentTypeLabel(attachment, 'en-US', translateEnglish)).toContain('Text');
    expect(formatDraftSchedule(draft, 'zh-CN', translate, 'Asia/Shanghai')).toContain('09:30');
    expect(formatDraftSchedule(draft, 'en-US', translateEnglish, 'Asia/Shanghai')).toContain('09:30');
    expect(formatDraftSchedule(draft, 'zh-CN', translate, 'Asia/Shanghai'))
      .not.toBe(formatDraftSchedule(draft, 'en-US', translateEnglish, 'Asia/Shanghai'));
    expect(rawToolLine?.text).toContain(rawToolName);
  });

  it('replays persisted assistant and terminal events even when an old live stream owns the turn', () => {
    expect(shouldDeferPersistedEventToLiveStream('stream_delta', true)).toBe(true);
    expect(shouldDeferPersistedEventToLiveStream('assistant_message_created', true)).toBe(false);
    expect(shouldDeferPersistedEventToLiveStream('stream_end', true)).toBe(false);
    expect(shouldDeferPersistedEventToLiveStream('complete', true)).toBe(false);
    expect(shouldDeferPersistedEventToLiveStream('stream_delta', false)).toBe(false);
  });

  it('turns the Harness lifecycle into mergeable execution-record lines', () => {
    const started = harnessEventTraceLine('task_frame_started', {
      task_frame_id: 'task-weather',
      kind: 'conversation',
    }, translate);
    const action = harnessEventTraceLine('harness_action_created', {
      task_frame_id: 'task-weather',
      iteration: 1,
      action: 'tool',
      tool_name: 'general_skill.weather',
    }, translate);
    const completed = harnessEventTraceLine('harness_tool_completed', {
      task_frame_id: 'task-weather',
      iteration: 1,
      tool_name: 'general_skill.weather',
      success: true,
      result: {
        success: true,
        data: { structured_result: { temperature: 29 } },
      },
    }, translate);
    const appView = harnessEventTraceLine('harness_mcp_app_view', {
      task_frame_id: 'task-weather',
      tool_name: 'weather.card',
      mcp_app: {
        server_id: 'server-weather',
        resource_uri: 'ui://weather/card',
        tool_name: 'weather.card',
        visibility: ['model', 'app'],
        mime_type: 'text/html;profile=mcp-app',
      },
    }, translate);
    const finished = harnessEventTraceLine('task_frame_finished', {
      task_frame_id: 'task-weather',
      status: 'completed',
      action_count: 2,
    }, translate);

    expect(started).toMatchObject({
      id: 'harness_frame_task-weather',
      text: '开始执行任务',
      state: 'running',
    });
    expect(action).toMatchObject({
      id: 'harness_action_task-weather_1',
      text: '调用能力 general_skill.weather',
      state: 'running',
    });
    expect(completed).toMatchObject({
      id: 'harness_action_task-weather_1',
      text: '能力调用完成：general_skill.weather',
      state: 'completed',
      outputLanguage: 'json',
      outputTitle: '查看能力结果',
    });
    expect(completed?.output).toContain('"temperature": 29');
    expect(appView).toMatchObject({
      id: 'harness_mcp_app_task-weather_weather.card',
      text: '展示 MCP App weather.card',
      state: 'completed',
      mcpApp: { resource_uri: 'ui://weather/card' },
    });
    expect(finished).toMatchObject({
      id: 'harness_frame_task-weather',
      text: '任务执行完成',
      state: 'completed',
    });
  });

  it('keeps a switched SOP visible while it waits for user input', () => {
    const started = harnessEventTraceLine('task_frame_started', {
      task_frame_id: 'task-purchase',
      kind: 'sop',
      skill_id: 'skill_purchase_001',
      skill_name: '购买商品流程',
      step_id: 'collect_user_name',
    }, translate);
    const finished = harnessEventTraceLine('task_frame_finished', {
      task_frame_id: 'task-purchase',
      kind: 'sop',
      skill_id: 'skill_purchase_001',
      skill_name: '购买商品流程',
      step_id: 'collect_user_name',
      status: 'awaiting_user',
      action_count: 1,
    }, translate);

    expect(started).toMatchObject({
      id: 'harness_frame_task-purchase',
      text: '开始 SOP 购买商品流程',
      state: 'running',
    });
    expect(finished).toMatchObject({
      id: 'harness_frame_task-purchase',
      kind: 'skill',
      text: '等待用户补充：购买商品流程',
      detail: '状态：awaiting_user · 步骤 collect_user_name · 已执行 1 个动作',
      state: 'running',
    });
  });
});
