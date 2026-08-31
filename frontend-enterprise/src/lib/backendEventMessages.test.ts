import { describe, expect, it } from 'vitest';

import { createAppTranslator } from '@/i18n/imperative';

import { backendEventMessage, backendEventMessageDescriptor } from './backendEventMessages';

const harnessDecisionParams = {
  iteration: '2',
  decision: 'finish',
  call_index: 1,
  call_count: 1,
  json_attempt: 1,
  json_max_attempts: 1,
  request_attempt: 1,
  request_max_attempts: 1,
};

describe('generated backend event messages', () => {
  it.each([
    ['zh-CN', '第 2 轮模型决定完成任务'],
    ['en-US', 'Iteration 2: the model decided to finish the task'],
  ] as const)('localizes a harness model decision under %s', (locale, expected) => {
    const translator = createAppTranslator(locale);

    expect(backendEventMessage(
      'trace.harness.model.decision',
      harnessDecisionParams,
      translator.t,
      'dashboard.conversationLogs.trace.fallback',
    )).toBe(expected);
  });

  it.each([
    ['zh-CN', '正在生成最终回复，共调用模型 2 次。'],
    ['en-US', 'Generating the final response with 2 model calls.'],
  ] as const)('localizes response-generation call counts under %s', (locale, expected) => {
    const translator = createAppTranslator(locale);

    expect(backendEventMessage(
      'trace.response.generation',
      { model_call_count: 2 },
      translator.t,
      'dashboard.conversationLogs.trace.fallback',
    )).toBe(expected);
  });

  it('rejects missing, extra, or malformed trace params', () => {
    expect(backendEventMessageDescriptor('trace.harness.model.decision', {
      ...harnessDecisionParams,
      decision: 'finish',
      provider_detail: 'must not reach the UI',
    })).toBeNull();
    expect(backendEventMessageDescriptor('trace.response.generation', {
      model_call_count: '1',
    })).toBeNull();
  });
});
