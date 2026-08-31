import { describe, expect, it } from 'vitest';

import { createMessageDescriptor, type MessageDescriptor } from './descriptors';

const stableDescriptor = {
  id: 'common.action.save',
  values: { userName: '旅途' },
} satisfies MessageDescriptor;

const naturalLanguageId = '保存成功';

const naturalLanguageDescriptor: MessageDescriptor = {
  // @ts-expect-error Natural-language prose is not a stable semantic message ID.
  id: naturalLanguageId,
};

const englishCopyId = 'Save successfully';

const englishCopyDescriptor: MessageDescriptor = {
  // @ts-expect-error English UI copy is not a stable semantic message ID.
  id: englishCopyId,
};

const runtimeSegment: string = 'success';
const dynamicId = `common.action.${runtimeSegment}`;

const dynamicDescriptor: MessageDescriptor = {
  // @ts-expect-error Runtime-composed IDs cannot satisfy the finite MessageId contract.
  id: dynamicId,
};

describe('semantic message descriptors', () => {
  /**
   * Verifies that a descriptor carries a stable ID and named values separately, without embedding
   * user data into the ID. Descriptor construction must not mutate the supplied values object.
   */
  it('keeps user data in named values rather than interpolating it into the message ID', () => {
    const userName = '张三 / Alice';
    const descriptor = createMessageDescriptor('common.action.save', { userName });

    expect(descriptor).toEqual({
      id: 'common.action.save',
      values: { userName },
    });
    expect(descriptor.id).toBe('common.action.save');
    expect(descriptor.id).not.toContain(userName);
  });

  /**
   * Verifies the compile-time contract's valid shape remains usable at runtime. The assertion
   * deliberately exercises a named value instead of a positional or prose-based key.
   */
  it('accepts a stable semantic ID with named values', () => {
    expect(stableDescriptor).toEqual({
      id: 'common.action.save',
      values: { userName: '旅途' },
    });
  });
});
