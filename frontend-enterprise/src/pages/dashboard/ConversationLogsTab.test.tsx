import { describe, expect, it } from 'vitest';

import type { TraceLineRead } from '@/types';

import { timingText, traceDetails } from './ConversationLogsTab';

describe('conversation log trace details', () => {
  it('labels model time as a subset when total elapsed time is present', () => {
    expect(timingText(80_231, 78_749, undefined, ['glm-5.2'])).toBe(
      '总 80.2s · glm-5.2 · 其中模型 78.7s',
    );
    expect(timingText(undefined, 3_524, 1, ['glm-5.2'])).toBe(
      'glm-5.2 · 模型耗时 3.52s · 1 次调用',
    );
  });

  it('keeps measured model decisions in the elapsed-time breakdown', () => {
    const lines: TraceLineRead[] = [
      {
        id: 'thinking-placeholder',
        kind: 'thinking',
        text: '正在思考',
        state: 'running',
      },
      {
        id: 'harness-model-1',
        kind: 'thinking',
        text: '第 1 轮决定调用能力',
        detail: 'Harness 模型决策',
        state: 'completed',
        model_duration_ms: 3524,
        model_call_count: 1,
      },
      {
        id: 'harness-tool-1',
        kind: 'tool',
        text: '能力调用完成 knowledge_search',
        state: 'completed',
        duration_ms: 9964,
      },
    ];

    expect(traceDetails(lines).map((line) => line.id)).toEqual([
      'harness-model-1',
      'harness-tool-1',
    ]);
  });
});
