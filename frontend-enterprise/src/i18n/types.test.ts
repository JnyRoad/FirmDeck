import { describe, expect, it } from 'vitest';

import type { AppLocale, MessageId } from './types';

const validMessageId = 'common.action.save' satisfies MessageId;
const validLocale = 'en-US' satisfies AppLocale;

// @ts-expect-error Natural-language prose is never a stable semantic message ID.
const naturalLanguageMessageId = 'Save successfully' satisfies MessageId;

// @ts-expect-error Unsupported and test-only locales cannot persist as AppLocale.
const unsupportedLocale = 'en-XA' satisfies AppLocale;

describe('internationalization compile-time contracts', () => {
  it('retains valid semantic IDs and production locale literals at runtime', () => {
    expect(validMessageId).toBe('common.action.save');
    expect(validLocale).toBe('en-US');
    expect(naturalLanguageMessageId).toBe('Save successfully');
    expect(unsupportedLocale).toBe('en-XA');
  });
});
