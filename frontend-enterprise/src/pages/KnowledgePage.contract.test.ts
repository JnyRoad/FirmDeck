import { describe, expect, it } from 'vitest';

import { createAppTranslator } from '@/i18n';
import type {
  KnowledgeErrorDescriptor,
  KnowledgeIngestJobRead,
  KnowledgeSearchTrace,
} from '@/types';

import {
  knowledgeErrorLabel,
  knowledgeRouteLabel,
  knowledgeStageDetailLabel,
  knowledgeStageLabel,
} from './KnowledgePage';

const translator = createAppTranslator('en-US');

describe('KnowledgePage canonical backend projections', () => {
  it('accepts a structured ingest error and localizes it from the current translator', () => {
    const error: KnowledgeErrorDescriptor = {
      code: 'INTERNAL_ERROR',
      params: {},
      retryable: false,
      request_id: null,
      trace_id: null,
    };
    const job: KnowledgeIngestJobRead = {
      id: 'job-t104',
      tenant_id: 'tenant-demo',
      knowledge_base_id: 'kb-demo',
      filename: 'policy.md',
      status: 'failed',
      stage: 'failed',
      progress: 0.2,
      error,
      metadata: {},
      created_at: '2026-08-30T00:00:00Z',
      updated_at: '2026-08-30T00:00:00Z',
    };

    expect(knowledgeErrorLabel(job.error, translator.t)).toBe('Something went wrong. Please try again later.');
  });

  it('localizes stable ingest stages and typed cancellation detail', () => {
    expect(knowledgeStageLabel('parsing', translator.t)).toBe('Parsing source material');
    expect(knowledgeStageDetailLabel({ code: 'cancel_requested', params: {} }, translator.t)).toBe('Cancelling');
  });

  it('does not project a backend trace message or unknown phase as visible prose', () => {
    const trace = {
      phase: 'document_route',
      code: 'document_route',
      params: {},
      message: 'provider secret',
    } satisfies KnowledgeSearchTrace & { message: string };

    expect(knowledgeRouteLabel(trace, translator.t)).toBe('Select knowledge base documents');
    expect(knowledgeRouteLabel({ ...trace, phase: 'untrusted_phase', code: 'untrusted_phase' }, translator.t))
      .toBe('Retrieval stage');
  });
});
