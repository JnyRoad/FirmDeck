// @vitest-environment jsdom

import { createElement } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../api/client';
import { I18nProvider } from '../i18n';
import { OPEN_MODEL_CREATE_EVENT } from '@/components/QuickStartGuide';
import ModelsPage, {
  modelActionError,
  modelAuthModeLabel,
  modelProviderErrorMessage,
} from './ModelsPage';

const subscriptionStatusCopy = {
  '已连接 ChatGPT 订阅': {
    status: 'connected',
    translation: 'ChatGPT subscription connected',
  },
  '已在默认浏览器中打开 ChatGPT 授权页面': {
    status: 'pending',
    translation: 'Opened the ChatGPT authorization page in your default browser',
  },
  '尚未连接 ChatGPT 订阅': {
    status: 'requires_login',
    translation: 'ChatGPT subscription is not connected',
  },
  '本机 Codex 订阅运行时不可用': {
    status: 'unavailable',
    translation: 'The local Codex subscription runtime is unavailable',
  },
} as const;

// 构造满足前端请求封装的成功响应，避免测试依赖真实网络。
function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify(body),
  } as Response;
}

// 模拟模型页初始化请求，并把订阅状态交给真实页面渲染。
function stubModelsPageFetch(subscriptionAccount: {
  status: 'connected' | 'pending' | 'requires_login' | 'unavailable';
  plan_type: null;
  message: string;
}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/codex-subscription/account')) return jsonResponse(subscriptionAccount);
    if (url.includes('/model-configs/protocols')) {
      return jsonResponse({ protocols: ['openai_chat_completions'] });
    }
    if (url.includes('/model-configs')) return jsonResponse([]);
    return jsonResponse({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

// 补齐 jsdom 未实现的指针捕获 API，供生产 Select 组件处理用户点击。
function stubSelectPointerCapture() {
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {};
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
}

beforeEach(() => {
  stubSelectPointerCapture();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('model provider diagnostics', () => {
  it('renders upstream status, provider code, body and request id', () => {
    expect(modelProviderErrorMessage({
      code: 'MODEL_UPSTREAM_ERROR',
      message: 'provider failed',
      upstream_status: 422,
      provider_code: 'invalid_model',
      provider_message: 'model does not exist',
      upstream_body: '{"error":{"code":"invalid_model"}}',
      request_id: 'req_123',
    }, '测试失败')).toBe(
      'MODEL_UPSTREAM_ERROR；HTTP 422；上游错误码：invalid_model；'
      + '上游消息：model does not exist；上游响应：{"error":{"code":"invalid_model"}}；'
      + 'Request ID：req_123',
    );
  });

  it('reads structured provider diagnostics from a failed save response', () => {
    const error = new ApiError(502, JSON.stringify({
      detail: {
        code: 'MODEL_UPSTREAM_ERROR',
        message: 'provider failed',
        upstream_status: 400,
        provider_code: 'invalid_request',
        upstream_body: '{"error":"bad request"}',
      },
    }), 'Bad Gateway');

    expect(modelActionError(error, '保存失败')).toContain(
      'MODEL_UPSTREAM_ERROR；HTTP 400；上游错误码：invalid_request',
    );
    expect(modelActionError(error, '保存失败')).toContain('上游响应：{"error":"bad request"}');
  });

  it('localizes a stable model configuration error code', () => {
    const error = new ApiError(422, JSON.stringify({
      detail: 'MODEL_PROTOCOL_OPTIONS_INVALID',
    }), 'Unprocessable Entity');

    expect(modelActionError(error, '保存失败')).toBe(
      '模型协议选项无效，请检查 API 协议与协议参数',
    );
  });

  it('wraps an unknown stable error code instead of exposing a bare token', () => {
    const error = new ApiError(422, JSON.stringify({ detail: 'MODEL_NEW_FAILURE' }), '');

    expect(modelActionError(error, '保存失败')).toBe('操作失败（错误码：MODEL_NEW_FAILURE）');
  });

  it('labels authentication modes', () => {
    expect(modelAuthModeLabel('api_key')).toBe('API Key');
    expect(modelAuthModeLabel('chatgpt_subscription')).toBe('ChatGPT 订阅（Codex）');
  });

  it('renders ChatGPT subscription account statuses from the API in English', async () => {
    window.localStorage.setItem('staffdeck_locale', 'en-US');

    for (const [message, account] of Object.entries(subscriptionStatusCopy)) {
      const fetchMock = stubModelsPageFetch({
        status: account.status,
        plan_type: null,
        message,
      });
      const user = userEvent.setup();
      render(createElement(I18nProvider, null, createElement(ModelsPage)));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          expect.stringContaining('/codex-subscription/account'),
          expect.anything(),
        );
      });
      window.dispatchEvent(new CustomEvent(OPEN_MODEL_CREATE_EVENT));
      await user.click((await screen.findAllByRole('combobox'))[0]);
      await user.click(await screen.findByRole('option', { name: 'ChatGPT Subscription (Codex)' }));
      expect(await screen.findByText(account.translation)).toBeTruthy();

      cleanup();
      vi.unstubAllGlobals();
      window.localStorage.setItem('staffdeck_locale', 'en-US');
    }
  });
});
