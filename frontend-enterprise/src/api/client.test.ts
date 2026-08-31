import { describe, expect, it } from 'vitest';

import { ApiError, GENERIC_ERROR_MESSAGE } from './client';

type ErrorField = 'params' | 'retryable' | 'request_id' | 'trace_id';

/** 从 ApiError 读取 canonical wire 字段；兼容类字段命名但不降低 wire 契约要求。 */
function readErrorField(error: ApiError, field: ErrorField): unknown {
  const record = error as unknown as Record<string, unknown>;
  if (field in record) return record[field];

  const camelCase = field.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
  return record[camelCase];
}

/** 构造不包含自然语言 detail 的标准错误描述，模拟后端 ErrorDescriptor 公共投影。 */
function canonicalErrorPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    code: 'VALIDATION_ERROR',
    params: { error_count: 2 },
    retryable: false,
    request_id: 'req-client-42',
    trace_id: 'trace-client-42',
    ...overrides,
  };
}

describe('ApiError', () => {
  it('parses the canonical descriptor and preserves code, params, retryability, and correlation ids', () => {
    const error = new ApiError(404, JSON.stringify({
      ...canonicalErrorPayload(),
    }), 'Not Found');

    expect(error.code).toBe('VALIDATION_ERROR');
    expect(readErrorField(error, 'params')).toEqual({ error_count: 2 });
    expect(readErrorField(error, 'retryable')).toBe(false);
    expect(readErrorField(error, 'request_id')).toBe('req-client-42');
    expect(readErrorField(error, 'trace_id')).toBe('trace-client-42');
    expect(error.message).not.toContain('Field required');
  });

  it('keeps legacy validation detail as diagnostic body data instead of final user text', () => {
    const error = new ApiError(422, JSON.stringify({
      ...canonicalErrorPayload({ code: 'VALIDATION_ERROR' }),
      detail: [{ loc: ['body', 'name'], msg: 'Field required' }],
    }), 'Unprocessable Entity');

    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.message).not.toContain('body.name');
    expect(error.message).not.toContain('Field required');
    expect(error.body).toContain('Field required');
  });

  it('accepts a legacy detail code only as a compatibility projection', () => {
    const rawLegacyMessage = 'provider raw detail: secret response';
    const error = new ApiError(422, JSON.stringify({
      detail: {
        code: 'MODEL_PROTOCOL_OPTIONS_INVALID',
        message: rawLegacyMessage,
      },
      request_id: 'req-legacy-42',
      trace_id: 'trace-legacy-42',
    }), 'Unprocessable Entity');

    expect(error.code).toBe('MODEL_PROTOCOL_OPTIONS_INVALID');
    expect(error.message).not.toContain(rawLegacyMessage);
    expect(readErrorField(error, 'request_id')).toBe('req-legacy-42');
    expect(readErrorField(error, 'trace_id')).toBe('trace-legacy-42');
  });

  it('preserves an unknown canonical code for diagnostics without treating provider params as prose', () => {
    const rawProviderMessage = 'provider raw body: do-not-render';
    const error = new ApiError(502, JSON.stringify(canonicalErrorPayload({
      code: 'UNREGISTERED_PROVIDER_FAILURE',
      params: { provider_message: rawProviderMessage },
      retryable: true,
      request_id: 'req-unknown-42',
      trace_id: 'trace-unknown-42',
    })), 'Bad Gateway');

    expect(error.code).toBe('UNREGISTERED_PROVIDER_FAILURE');
    expect(readErrorField(error, 'params')).toEqual({ provider_message: rawProviderMessage });
    expect(readErrorField(error, 'retryable')).toBe(true);
    expect(readErrorField(error, 'request_id')).toBe('req-unknown-42');
    expect(readErrorField(error, 'trace_id')).toBe('trace-unknown-42');
    expect(error.body).toContain(rawProviderMessage);
  });

  it('fails closed for a malformed canonical descriptor while retaining correlation diagnostics', () => {
    const rawDetail = 'provider raw detail: malformed payload';
    const rawStack = 'Error: provider stack secret\n    at provider-client.ts:99';
    const error = new ApiError(502, JSON.stringify({
      code: 'not a stable code',
      params: ['not', 'an', 'object'],
      retryable: 'sometimes',
      request_id: 'req-malformed-42',
      trace_id: 'trace-malformed-42',
      detail: rawDetail,
      stack: rawStack,
    }), 'Bad Gateway');

    expect(error.code).toBeUndefined();
    expect(error.message).not.toContain(rawDetail);
    expect(error.message).not.toContain(rawStack);
    expect(readErrorField(error, 'request_id')).toBe('req-malformed-42');
    expect(readErrorField(error, 'trace_id')).toBe('trace-malformed-42');
    expect(error.body).toContain(rawStack);
  });

  it('replaces an oversized non-JSON body (e.g. an intercepting proxy block page) with a generic message', () => {
    const interceptPage = `<!DOCTYPE html><html><head><title>Attention Required!</title></head>`
      + `<body>Your IP address 203.0.113.7 has been blocked by the network gateway. `
      + `Please contact your administrator for more information.</body></html>`;
    expect(interceptPage.length).toBeGreaterThan(160);

    const error = new ApiError(403, interceptPage, 'Forbidden');

    expect(error.message).toBe('操作失败，请稍后重试。');
    expect(error.message).not.toContain('<');
    expect(error.message).not.toContain('203.0.113.7');
    expect(error.code).toBeUndefined();
  });

  it('does not expose a short provider response body as the final user message', () => {
    const rawProviderBody = 'Service Unavailable: provider secret response';
    const error = new ApiError(503, rawProviderBody, 'Service Unavailable');

    expect(error.message).toBe(GENERIC_ERROR_MESSAGE);
    expect(error.message).not.toContain(rawProviderBody);
    expect(error.body).toBe(rawProviderBody);
  });

  it('does not expose a short legacy detail body as the final user message', () => {
    const rawDetail = 'invalid request from upstream provider';
    const error = new ApiError(400, JSON.stringify({ detail: rawDetail }), 'Bad Request');

    expect(error.message).toBe(GENERIC_ERROR_MESSAGE);
    expect(error.message).not.toContain(rawDetail);
    expect(error.body).toContain(rawDetail);
  });
});
