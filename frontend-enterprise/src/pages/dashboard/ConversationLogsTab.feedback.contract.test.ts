import { describe, expect, it } from 'vitest';

import {
  analysisStatusLabel,
  feedbackAnalysisStatusDescriptor,
  feedbackBucketDescriptor,
  feedbackBucketLabel,
  feedbackEvidenceContent,
  feedbackSummaryDescriptor,
  type FeedbackTranslate,
} from './ConversationLogsTab';

const translate: FeedbackTranslate = (id, values) => `${id}:${JSON.stringify(values ?? {})}`;

describe('conversation log feedback projection', () => {
  it.each([
    ['model_issue', 'dashboard.conversationLogs.bucket.modelIssue'],
    ['skill_instruction_issue', 'dashboard.conversationLogs.bucket.skillInstructionIssue'],
    ['sop_trigger_issue', 'dashboard.conversationLogs.bucket.sopTriggerIssue'],
    ['sop_slot_issue', 'dashboard.conversationLogs.bucket.sopSlotIssue'],
    ['sop_transition_issue', 'dashboard.conversationLogs.bucket.sopTransitionIssue'],
    ['sop_capability_issue', 'dashboard.conversationLogs.bucket.sopCapabilityIssue'],
    ['knowledge_gap', 'dashboard.conversationLogs.bucket.knowledgeGap'],
    ['tool_or_runtime_issue', 'dashboard.conversationLogs.bucket.toolOrRuntimeIssue'],
    ['user_random_or_unclear', 'dashboard.conversationLogs.bucket.userRandomOrUnclear'],
  ])('maps stable bucket %s to a locale message ID', (bucket, messageId) => {
    expect(feedbackBucketDescriptor(bucket)).toEqual({ id: messageId });
  });

  it('fails closed for missing or malformed buckets without returning the backend value', () => {
    expect(feedbackBucketDescriptor('provider leaked prose')).toEqual({
      id: 'dashboard.conversationLogs.bucket.unknown',
    });
    expect(feedbackBucketDescriptor(null)).toEqual({
      id: 'dashboard.conversationLogs.bucket.unknown',
    });
    expect(feedbackBucketLabel('provider leaked prose', translate)).not.toContain('provider leaked prose');
  });

  it('passes bounded status params to a semantic failed message', () => {
    expect(feedbackAnalysisStatusDescriptor('failed', { attempts: 3 })).toEqual({
      id: 'dashboard.conversationLogs.analysis.failedAttempts',
      values: { attempts: 3 },
    });
    expect(feedbackAnalysisStatusDescriptor('failed', { attempts: '3' })).toEqual({
      id: 'dashboard.conversationLogs.analysis.failed',
    });
    expect(analysisStatusLabel('unknown-provider-status', { attempts: 3 }, translate))
      .toBe('dashboard.conversationLogs.analysis.unknown:{}');
  });

  it('projects aggregate bucket params while leaving model detail raw', () => {
    const rawDetail = 'RAW model summary / 不要翻译';
    expect(feedbackSummaryDescriptor({
      bucket: 'knowledge_gap',
      params: { count: 2 },
      detail: rawDetail,
    })).toEqual({
      bucket: { id: 'dashboard.conversationLogs.bucket.knowledgeGap' },
      count: {
        id: 'dashboard.conversationLogs.summary.count',
        values: { count: 2 },
      },
      detail: rawDetail,
    });
  });

  it('drops malformed aggregate params instead of interpolating untrusted values', () => {
    expect(feedbackSummaryDescriptor({
      bucket: 'model_issue',
      params: { count: '2' },
      detail: { provider: 'raw object' },
    })).toBeNull();
  });

  it('keeps model evidence raw at the presentation boundary', () => {
    const rawEvidence = 'RAW evidence / 不要翻译';
    expect(feedbackEvidenceContent({
      evidence: [rawEvidence, { source: 'provider-output' }],
    })).toEqual([rawEvidence, '{"source":"provider-output"}']);
  });
});
