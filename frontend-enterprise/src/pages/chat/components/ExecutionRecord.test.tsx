// @vitest-environment jsdom

/**
 * 验证 trace/工具记录的 product chrome 走 AppIntlProvider，而工具输出和诊断内容保持原样。
 * 测试不挂载 legacy I18nProvider 或 DOM observer，确保新组件依赖明确的语义运行时。
 */

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { AppIntlProvider } from '@/i18n';

import type { TraceLine } from '../chatTypes';
import ExecutionRecord from './ExecutionRecord';

afterEach(() => {
  cleanup();
});

/** 在新的 AppIntlProvider 下渲染一条可展开的执行记录。 */
function renderExecutionRecord(
  locale: 'zh-CN' | 'en-US',
  summary: { text: string; state: TraceLine['state'] },
  details: TraceLine[],
) {
  return render(
    <AppIntlProvider initialLocale={locale}>
      <ExecutionRecord
        traceTurnId="turn-execution-i18n"
        summary={summary}
        details={details}
        expanded
        onToggle={() => undefined}
      />
    </AppIntlProvider>,
  );
}

/** 验证执行状态、代码/输出标题属于 locale chrome，而工具 payload 与诊断值不得被翻译。 */
function verifiesTraceChromeAndRawPayload(): void {
  const rawToolText = 'tool payload 原文：{"customer":"旅途","keep":"verbatim"}';
  const rawDetail = 'provider raw diagnostic: 中文错误详情 / do not translate';
  const rawOutput = 'raw output: <secret-like-value> remains unchanged';
  const summary = { text: '正在执行工具', state: 'running' as const };
  const details: TraceLine[] = [{
    id: 'trace-line-i18n',
    kind: 'tool',
    text: rawToolText,
    detail: rawDetail,
    code: 'print("raw tool payload")',
    language: 'python',
    output: rawOutput,
    outputTitle: '查看输出',
    state: 'completed',
  }];

  const zhView = renderExecutionRecord('zh-CN', summary, details);
  const zhText = zhView.container.textContent || '';
  const zhSummary = zhView.container.querySelector('button')?.getAttribute('aria-label')
    || zhView.container.querySelector('button')?.textContent
    || '';
  zhView.unmount();

  const enView = renderExecutionRecord('en-US', summary, details);
  const enText = enView.container.textContent || '';
  const enSummary = enView.container.querySelector('button')?.getAttribute('aria-label')
    || enView.container.querySelector('button')?.textContent
    || '';

  expect(zhText).toContain(rawToolText);
  expect(zhText).toContain(rawDetail);
  expect(zhText).toContain(rawOutput);
  expect(enText).toContain(rawToolText);
  expect(enText).toContain(rawDetail);
  expect(enText).toContain(rawOutput);
  expect(enSummary).not.toBe(zhSummary);
}

describe('ExecutionRecord semantic locale and raw boundaries', () => {
  it('localizes trace controls without translating tool payload or diagnostics', verifiesTraceChromeAndRawPayload);
});
