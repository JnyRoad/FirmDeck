// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { api, ApiError } from './client';

function response(status: number, body: unknown, statusText = ''): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: async () => typeof body === 'string' ? body : JSON.stringify(body),
  } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ApiError', () => {
  it('preserves a structured backend error code and human-readable message', () => {
    const error = new ApiError(404, JSON.stringify({
      detail: {
        code: 'EVOLUTION_FEEDBACK_NOT_FOUND',
        message: '未找到可用于改进的 Skill 或 SOP 反馈',
      },
    }), 'Not Found');

    expect(error.code).toBe('EVOLUTION_FEEDBACK_NOT_FOUND');
    expect(error.message).toBe('未找到可用于改进的 Skill 或 SOP 反馈');
  });

  it('keeps validation detail formatting compatible', () => {
    const error = new ApiError(422, JSON.stringify({
      detail: [{ loc: ['body', 'name'], msg: 'Field required' }],
    }), 'Unprocessable Entity');

    expect(error.code).toBeUndefined();
    expect(error.message).toBe('body.name: Field required');
  });

  it('recognizes a stable error code returned as a string detail', () => {
    const error = new ApiError(422, JSON.stringify({
      detail: 'MODEL_PROTOCOL_OPTIONS_INVALID',
    }), 'Unprocessable Entity');

    expect(error.code).toBe('MODEL_PROTOCOL_OPTIONS_INVALID');
    expect(error.message).toBe('MODEL_PROTOCOL_OPTIONS_INVALID');
  });
});

describe('gateway retry policy', () => {
  it('retries an idempotent GET after a transient gateway response', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(502, 'Bad Gateway', 'Bad Gateway'))
      .mockResolvedValueOnce(response(200, { status: 'ok' }, 'OK'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.get<{ status: string }>('/api/health')).resolves.toEqual({ status: 'ok' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops retrying GET requests after two gateway retries', async () => {
    const fetchMock = vi.fn(async () => response(502, 'Bad Gateway', 'Bad Gateway'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.get('/api/health')).rejects.toMatchObject({ status: 502 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry state-changing requests', async () => {
    const fetchMock = vi.fn(async () => response(502, 'Bad Gateway', 'Bad Gateway'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.post('/api/chat/stream', {})).rejects.toMatchObject({ status: 502 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
