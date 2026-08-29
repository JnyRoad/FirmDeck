// @vitest-environment jsdom

import { createElement, useEffect } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ApiError } from '../api/client';
import { I18nProvider, useI18n } from '../i18n';
import {
  modelActionError,
  modelAuthModeLabel,
  modelProviderErrorMessage,
} from './ModelsPage';

const subscriptionStatusCopy = {
  '已连接 ChatGPT 订阅': 'ChatGPT subscription connected',
  '已在默认浏览器中打开 ChatGPT 授权页面':
    'Opened the ChatGPT authorization page in your default browser',
  '尚未连接 ChatGPT 订阅': 'ChatGPT subscription is not connected',
  '本机 Codex 订阅运行时不可用': 'The local Codex subscription runtime is unavailable',
};

// 切换测试页面到英文，以验证 API 返回的订阅状态会被实际国际化运行时翻译。
function SwitchToEnglish() {
  const { setLocale } = useI18n();

  useEffect(() => {
    setLocale('en-US');
  }, [setLocale]);

  return null;
}

afterEach(() => {
  cleanup();
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

  it('renders ChatGPT subscription account statuses in English', async () => {
    render(
      createElement(
        I18nProvider,
        null,
        createElement(SwitchToEnglish),
        ...Object.keys(subscriptionStatusCopy).map((message) =>
          createElement('p', { key: message }, message),
        ),
      ),
    );

    await waitFor(() => {
      for (const translation of Object.values(subscriptionStatusCopy)) {
        expect(screen.getByText(translation)).toBeTruthy();
      }
    });
  });
});
