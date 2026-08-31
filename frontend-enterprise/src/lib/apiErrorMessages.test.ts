import { describe, expect, it } from 'vitest';

import { ApiError } from '@/api/client';
import { createAppTranslator, type AppTranslator } from '@/i18n/imperative';

import { apiErrorMessage } from './apiErrorMessages';

type LocalizedErrorMessage = (
  error: unknown,
  fallbackMessageId: string,
  translator: Pick<AppTranslator, 't'>,
) => string;

/** 以测试期望的受控 translator 调用错误投影；当前旧签名会因此保持明确的 RED。 */
const localizeApiError = apiErrorMessage as unknown as LocalizedErrorMessage;

/** 模拟后端稳定错误描述，不把自然语言 detail 当作机器契约的一部分。 */
function canonicalErrorPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    code: 'KNOWLEDGE_PUBLISH_CONFLICT',
    params: {},
    retryable: false,
    request_id: 'req-i18n-42',
    trace_id: 'trace-i18n-42',
    ...overrides,
  };
}

const expectedCopy = {
  'zh-CN': {
    known: '正式版本已变化，请基于最新版本重新操作。',
    generic: '操作失败，请稍后重试。',
  },
  'en-US': {
    known: 'The published knowledge version changed. Review the latest version and try again.',
    generic: 'Something went wrong. Please try again later.',
  },
} as const;

describe('apiErrorMessage', () => {
  it('localizes a known canonical code from code/params under the active UI locale', () => {
    const error = new ApiError(409, JSON.stringify(canonicalErrorPayload()), 'Conflict');

    expect(localizeApiError(
      error,
      'common.error.generic',
      createAppTranslator('zh-CN'),
    )).toBe(expectedCopy['zh-CN'].known);
    expect(localizeApiError(
      error,
      'common.error.generic',
      createAppTranslator('en-US'),
    )).toBe(expectedCopy['en-US'].known);
  });

  it('uses a localized safe fallback for an unknown canonical code without exposing params', () => {
    const rawProviderMessage = 'provider raw body: do-not-render';
    const error = new ApiError(502, JSON.stringify(canonicalErrorPayload({
      code: 'UNREGISTERED_PROVIDER_FAILURE',
      params: { provider_message: rawProviderMessage },
      retryable: true,
    })), 'Bad Gateway');

    const message = localizeApiError(
      error,
      'common.error.generic',
      createAppTranslator('en-US'),
    );

    expect(message).toBe(expectedCopy['en-US'].generic);
    expect(message).not.toContain('UNREGISTERED_PROVIDER_FAILURE');
    expect(message).not.toContain(rawProviderMessage);
  });

  it('fails closed for malformed canonical data and never projects detail, stack, or provider text', () => {
    const rawDetail = 'provider raw detail: malformed payload';
    const rawStack = 'Error: provider stack secret\n    at provider-client.ts:99';
    const rawProvider = 'upstream provider response: secret';
    const error = new ApiError(502, JSON.stringify({
      code: 'not a stable code',
      params: { provider_message: rawProvider },
      retryable: 'sometimes',
      detail: rawDetail,
      stack: rawStack,
    }), 'Bad Gateway');

    const message = localizeApiError(
      error,
      'common.error.generic',
      createAppTranslator('en-US'),
    );

    expect(message).toBe(expectedCopy['en-US'].generic);
    expect(message).not.toContain(rawDetail);
    expect(message).not.toContain(rawStack);
    expect(message).not.toContain(rawProvider);
  });

  it('keeps the registered legacy detail-code projection while localizing its final UI text', () => {
    const error = new ApiError(409, JSON.stringify({
      detail: 'KNOWLEDGE_PUBLISH_CONFLICT',
      request_id: 'req-legacy-42',
      trace_id: 'trace-legacy-42',
    }), 'Conflict');

    expect(localizeApiError(
      error,
      'common.error.generic',
      createAppTranslator('zh-CN'),
    )).toBe(expectedCopy['zh-CN'].known);
    expect(localizeApiError(
      error,
      'common.error.generic',
      createAppTranslator('en-US'),
    )).toBe(expectedCopy['en-US'].known);
  });

  it('does not treat a legacy provider detail as a final UI message', () => {
    const rawProviderDetail = 'provider raw detail: secret response';
    const rawStack = 'Error: provider stack secret';
    const error = new ApiError(503, JSON.stringify({
      detail: rawProviderDetail,
      stack: rawStack,
    }), 'Service Unavailable');

    const message = localizeApiError(
      error,
      'common.error.generic',
      createAppTranslator('en-US'),
    );

    expect(message).toBe(expectedCopy['en-US'].generic);
    expect(message).not.toContain(rawProviderDetail);
    expect(message).not.toContain(rawStack);
  });

  it('keeps the legacy known-code string compatible without accepting arbitrary source prose', () => {
    expect(localizeApiError(
      'MODEL_PROTOCOL_OPTIONS_INVALID',
      'common.error.generic',
      createAppTranslator('zh-CN'),
    )).toBe('模型协议选项无效，请检查 API 协议与协议参数');

    const rawSource = 'upstream request failed: timeout';
    const message = localizeApiError(
      rawSource,
      'common.error.generic',
      createAppTranslator('en-US'),
    );
    expect(message).toBe(expectedCopy['en-US'].generic);
    expect(message).not.toContain(rawSource);
  });

  it('replaces oversized raw bodies and raw fallbacks with a safe generic notice', () => {
    const rawHtml = `<html><body>${'blocked by intercepting proxy '.repeat(10)}</body></html>`;
    expect(rawHtml.length).toBeGreaterThan(160);

    const message = localizeApiError(
      rawHtml,
      'common.error.generic',
      createAppTranslator('en-US'),
    );
    expect(message).toBe(expectedCopy['en-US'].generic);
    expect(message).not.toContain('<html>');
  });
});
