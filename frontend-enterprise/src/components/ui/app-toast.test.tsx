// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  custom: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: {
    custom: mocks.custom,
    warning: vi.fn(),
    info: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  },
}));

import { notify } from './app-toast';

beforeEach(() => {
  mocks.custom.mockReset();
});

describe('app error toast deduplication', () => {
  it('uses the same toast id for repeated string errors', () => {
    notify.error('Bad Gateway');
    notify.error('Bad Gateway');

    const firstOptions = mocks.custom.mock.calls[0]?.[1];
    const secondOptions = mocks.custom.mock.calls[1]?.[1];
    expect(firstOptions?.id).toBe('app-error:Bad Gateway');
    expect(secondOptions?.id).toBe(firstOptions?.id);
  });

  it('preserves an explicit caller-provided id', () => {
    notify.error('Bad Gateway', { id: 'chat-sessions-error' });

    expect(mocks.custom.mock.calls[0]?.[1]?.id).toBe('chat-sessions-error');
  });
});
