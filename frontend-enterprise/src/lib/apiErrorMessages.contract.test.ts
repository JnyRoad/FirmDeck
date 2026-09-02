import { describe, expect, it } from 'vitest';

import { createAppTranslator } from '@/i18n/imperative';
import {
  BACKEND_ERROR_CONTRACT,
  getBackendErrorContract,
} from '@/i18n/generated/backendContract';
import englishMessages from '@/i18n/messages/en-US.json';
import chineseMessages from '@/i18n/messages/zh-CN.json';

import {
  apiErrorMessage,
  backendErrorMessageDescriptor,
} from './apiErrorMessages';

/** Build deterministic, type-valid values so every generated error descriptor is exercised. */
function sampleParams(entry: (typeof BACKEND_ERROR_CONTRACT)[keyof typeof BACKEND_ERROR_CONTRACT]) {
  return Object.fromEntries(
    Object.entries(entry.params).map(([name, kind]) => [
      name,
      String(kind) === 'string' ? 'sample' : String(kind) === 'boolean' ? true : String(kind) === 'integer' ? 1 : 0.5,
    ]),
  );
}

describe('generated backend error contract', () => {
  it('uses generated registry metadata instead of a parallel code-to-copy table', () => {
    const entry = getBackendErrorContract('KNOWLEDGE_PUBLISH_CONFLICT');

    expect(entry).toMatchObject({
      code: 'KNOWLEDGE_PUBLISH_CONFLICT',
      message_key: 'errors.knowledge.publishConflict',
      params: {},
      visibility: 'public',
    });
    expect(Object.keys(BACKEND_ERROR_CONTRACT).length).toBeGreaterThan(300);
  });

  it.each([
    ['zh-CN', '正式版本已变化，请基于最新版本重新操作。'],
    ['en-US', 'The published knowledge version changed. Review the latest version and try again.'],
  ] as const)('localizes a generated code under %s without reading raw detail', (locale, expected) => {
    const translator = createAppTranslator(locale);
    const error = {
      code: 'KNOWLEDGE_PUBLISH_CONFLICT',
      params: {},
      detail: 'provider raw detail must not become UI text',
    };

    expect(apiErrorMessage(error, 'common.error.generic', translator)).toBe(expected);
  });

  it('fails closed for unknown or malformed generated descriptors', () => {
    const translator = createAppTranslator('en-US');

    expect(apiErrorMessage({ code: 'UNREGISTERED', params: { raw: 'secret' } }, 'common.error.generic', translator))
      .toBe('Something went wrong. Please try again later.');
    expect(apiErrorMessage({ code: 'VALIDATION_ERROR', params: { error_count: 'many' } }, 'common.error.generic', translator))
      .toBe('Something went wrong. Please try again later.');
  });

  it('resolves every public generated error through both canonical catalogs', () => {
    const catalogs = [englishMessages as Record<string, string>, chineseMessages as Record<string, string>];

    for (const entry of Object.values(BACKEND_ERROR_CONTRACT)) {
      expect(entry.visibility).toBe('public');
      for (const catalog of catalogs) expect(catalog[entry.message_key]).toEqual(expect.any(String));
      expect(backendErrorMessageDescriptor({
        code: entry.code,
        params: sampleParams(entry),
      })?.messageId).toBe(entry.message_key);
    }
  });
});
