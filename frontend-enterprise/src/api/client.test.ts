// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ENTERPRISE_AUTH_STORAGE_KEY } from '../auth';
import {
  ApiError,
  GENERIC_ERROR_MESSAGE,
  api,
  streamPost,
  uploadChatAttachments,
  wechatKfApi,
} from './client';

const strictTenantSession = {
  token: 'tenant-token-a',
  scope: 'tenant' as const,
  tenant: {
    id: 'tenant-a',
    slug: 'alpha-lab',
    display_name: 'Alpha Lab',
  },
  user: {
    id: 'tenant-a-admin',
    tenant_id: 'tenant-a',
    username: 'admin',
    display_name: 'Alpha Operator',
    role: 'admin' as const,
    must_change_password: false,
    avatar_url: null,
  },
};

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

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('WeChat Customer Service API client', () => {
  it('uses the Task 2 routes and leaves multipart content type to the browser', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => String(input).includes('/accounts')
        ? JSON.stringify({ accounts: [] })
        : JSON.stringify({ id: 'binding-1', accounts: [] }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    const payload = { tenant_id: 'tenant_demo', corp_id: 'ww-corp' };

    await wechatKfApi.prepareCallback('binding-1', payload);
    await wechatKfApi.saveCredentials('binding-1', {
      ...payload,
      secret: 'provider-secret',
      callback_token: 'callback-token',
      encoding_aes_key: 'encoding-key',
    });
    await wechatKfApi.listAccounts('binding-1', 'tenant_demo');
    await wechatKfApi.selectAccount('binding-1', {
      tenant_id: 'tenant_demo',
      open_kfid: 'wk-existing',
    });
    await wechatKfApi.createAccount('binding-1', {
      tenant_id: 'tenant_demo',
      name: 'Provider Account',
      media_id: 'media-create',
    });
    await wechatKfApi.updateAccount('binding-1', {
      tenant_id: 'tenant_demo',
      open_kfid: 'wk-existing',
      name: 'Updated Account',
      media_id: 'media-update',
    });
    await wechatKfApi.deleteAccount('binding-1', 'wk-existing', 'tenant_demo');
    await wechatKfApi.uploadAvatar(
      'binding-1',
      new File(['avatar'], 'avatar.png', { type: 'image/png' }),
      'tenant_demo',
    );
    await wechatKfApi.createContactWay(
      'binding-1',
      'wk-existing',
      'tenant_demo',
    );

    const calls = fetchMock.mock.calls.map(([input, init]) => ({
      url: String(input),
      method: init?.method || 'GET',
      headers: init?.headers as Record<string, string> | undefined,
      body: init?.body,
      credentials: init?.credentials,
    }));
    expect(calls.map(({ url, method }) => [method, url])).toEqual([
      ['POST', '/api/enterprise/channels/binding-1/wechat_kf/callback-config'],
      ['POST', '/api/enterprise/channels/binding-1/wechat_kf/credentials'],
      ['GET', '/api/enterprise/channels/binding-1/wechat_kf/accounts?tenant_id=tenant_demo'],
      ['POST', '/api/enterprise/channels/binding-1/wechat_kf/account'],
      ['POST', '/api/enterprise/channels/binding-1/wechat_kf/accounts'],
      ['PATCH', '/api/enterprise/channels/binding-1/wechat_kf/account'],
      ['DELETE', '/api/enterprise/channels/binding-1/wechat_kf/account/wk-existing?tenant_id=tenant_demo'],
      ['POST', '/api/enterprise/channels/binding-1/wechat_kf/avatar?tenant_id=tenant_demo'],
      ['POST', '/api/enterprise/channels/binding-1/wechat_kf/contact-way?tenant_id=tenant_demo&open_kfid=wk-existing&scene=staffdeck'],
    ]);
    expect(calls[1]?.body).toBe(JSON.stringify({
      ...payload,
      secret: 'provider-secret',
      callback_token: 'callback-token',
      encoding_aes_key: 'encoding-key',
    }));
    expect(calls[7]?.body).toBeInstanceOf(FormData);
    expect(calls[7]?.headers).not.toHaveProperty('Content-Type');
    expect(calls[7]?.credentials).toBe('include');
  });
});

describe('common API transport', () => {
  it('preserves server-derived login fields without appending the deployment tenant constant', async () => {
    const payload = {
      tenant_slug: 'alpha-lab',
      username: 'admin',
      password: 'opaque password bytes  \u0000  preserved',
    };
    const fetchMock = vi.fn<typeof fetch>(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify({ token: 'tenant-token' }),
    } as Response));
    vi.stubGlobal('fetch', fetchMock);

    await api.post('/api/auth/login', payload);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/auth/login');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.body).toBe(JSON.stringify(payload));
    expect(String(init.body)).not.toContain('tenant_demo');
  });

  it('uses the verified tenant identity for attachment uploads without the deployment tenant constant', async () => {
    window.localStorage.setItem(ENTERPRISE_AUTH_STORAGE_KEY, JSON.stringify(strictTenantSession));
    const fetchMock = vi.fn<typeof fetch>(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => [],
    } as Response));
    vi.stubGlobal('fetch', fetchMock);

    await uploadChatAttachments(
      'tenant-a',
      [new File(['tenant A attachment'], 'a.txt', { type: 'text/plain' })],
    );

    const [input, init] = fetchMock.mock.calls[0];
    const parsed = new URL(String(input), window.location.origin);
    expect(parsed.pathname).toBe('/api/chat/attachments');
    expect(parsed.searchParams.get('tenant_id')).toBe('tenant-a');
    expect(String(input)).not.toContain('tenant_demo');
    expect(init?.headers).toEqual(expect.objectContaining({
      Authorization: 'Bearer tenant-token-a',
    }));
    expect(init?.body).toBeInstanceOf(FormData);
  });

  it('uses the verified tenant identity for chat streams without appending the deployment tenant constant', async () => {
    window.localStorage.setItem(ENTERPRISE_AUTH_STORAGE_KEY, JSON.stringify(strictTenantSession));
    const reader = { read: vi.fn().mockResolvedValue({ done: true, value: undefined }) };
    const fetchMock = vi.fn<typeof fetch>(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: { getReader: () => reader },
    } as unknown as Response));
    vi.stubGlobal('fetch', fetchMock);

    await streamPost(
      '/api/chat/stream',
      { tenant_id: 'tenant-a', message: 'tenant A message' },
      vi.fn(),
    );

    const [input, init] = fetchMock.mock.calls[0];
    expect(input).toBe('/api/chat/stream');
    expect(init?.headers).toEqual(expect.objectContaining({
      Authorization: 'Bearer tenant-token-a',
    }));
    expect(JSON.parse(String(init?.body))).toEqual({
      tenant_id: 'tenant-a',
      message: 'tenant A message',
    });
    expect(String(init?.body)).not.toContain('tenant_demo');
  });

  it('does not authorize a common request from a malformed legacy token-only session', async () => {
    window.localStorage.setItem(ENTERPRISE_AUTH_STORAGE_KEY, JSON.stringify({
      token: 'legacy-token',
      user: { tenant_id: 'tenant-a' },
    }));
    const fetchMock = vi.fn<typeof fetch>(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify({ ok: true }),
    } as Response));
    vi.stubGlobal('fetch', fetchMock);

    await api.get('/api/enterprise/agents');

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).not.toEqual(expect.objectContaining({
      Authorization: 'Bearer legacy-token',
    }));
  });
});
