// @vitest-environment jsdom

/**
 * 验证 MCP iframe 宿主 chrome、原生 consent 和 postMessage 产品错误的 locale 边界。
 * iframe 的第三方 srcDoc 与工具参数均视为 raw payload，不参与宿主 UI 翻译。
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppIntlProvider } from '@/i18n';

import type { MCPAppViewDescriptor } from '../chatTypes';
import MCPAppView from './MCPAppView';

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock('@/api/client', () => ({
  api: {
    get: apiMocks.get,
    post: apiMocks.post,
  },
}));

/** 构造包含原始工具标识的 MCP 宿主描述，业务标识不进入翻译资源。 */
function buildDescriptor(toolName = 'tool-中文-raw'): MCPAppViewDescriptor {
  return {
    server_id: 'server-i18n',
    resource_uri: 'ui://raw-app',
    tool_name: toolName,
    visibility: ['private'],
    mime_type: 'text/html',
    tenant_id: 'tenant_demo',
    agent_id: 'agent_demo',
    session_id: 'session_demo',
    initial_result: { raw: 'initial result 中文' },
    initial_meta: { raw: 'metadata' },
  };
}

/** 返回供 MCP 组件加载的第三方 HTML 资源，其中内容必须保持逐字不变。 */
function buildResource() {
  return {
    server_id: 'server-i18n',
    uri: 'ui://raw-app',
    mime_type: 'text/html',
    text: '<main>外部应用原始 UI / keep this srcDoc raw</main>',
    meta: { ui: { permissions: [], csp: {} } },
  };
}

/** 在不挂载 legacy observer 的前提下渲染 MCP 宿主。 */
function renderMcpView(locale: 'zh-CN' | 'en-US', descriptor = buildDescriptor()) {
  return render(
    <AppIntlProvider initialLocale={locale}>
      <MCPAppView descriptor={descriptor} />
    </AppIntlProvider>,
  );
}

/** 为 MessageEvent 注入 jsdom iframe source，模拟真实 iframe 到宿主的 postMessage。 */
function dispatchIframeMessage(iframe: HTMLIFrameElement, data: unknown): void {
  const event = new MessageEvent('message', { data });
  Object.defineProperty(event, 'source', { configurable: true, value: iframe.contentWindow });
  window.dispatchEvent(event);
}

beforeEach(() => {
  apiMocks.get.mockReset();
  apiMocks.post.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('MCPAppView semantic locale and raw protocol boundaries', () => {
  /** 验证加载状态具备可访问 status，并且 loading chrome 在两个 locale 中不同。 */
  it('localizes iframe loading state and exposes it as an accessible status', () => {
    apiMocks.get.mockReturnValue(new Promise(() => undefined));

    const zhView = renderMcpView('zh-CN');
    const zhText = zhView.container.textContent || '';
    const zhStatus = zhView.container.querySelector('[role="status"]');
    zhView.unmount();

    const enView = renderMcpView('en-US');
    const enText = enView.container.textContent || '';
    const enStatus = enView.container.querySelector('[role="status"]');

    expect(zhStatus).toBeTruthy();
    expect(enStatus).toBeTruthy();
    expect(zhText).not.toBe(enText);
  });

  /** 验证宿主标题/ARIA 随 locale 改变，同时第三方 srcDoc 和工具标识保持原样。 */
  it('localizes host chrome while preserving third-party srcDoc and tool identifier', async () => {
    apiMocks.get.mockResolvedValue(buildResource());
    const descriptor = buildDescriptor();

    const zhView = renderMcpView('zh-CN', descriptor);
    const zhIframe = await screen.findByTitle(/MCP App/) as HTMLIFrameElement;
    const zhText = zhView.container.textContent || '';
    const zhSection = zhView.container.querySelector('section');
    const zhTitle = zhIframe.getAttribute('title') || '';
    zhView.unmount();

    const enView = renderMcpView('en-US', descriptor);
    const enIframe = await screen.findByTitle(/MCP App/) as HTMLIFrameElement;
    const enText = enView.container.textContent || '';
    const enSection = enView.container.querySelector('section');
    const enTitle = enIframe.getAttribute('title') || '';

    await waitFor(() => {
      expect(zhIframe.getAttribute('srcdoc')).toContain('外部应用原始 UI / keep this srcDoc raw');
      expect(enIframe.getAttribute('srcdoc')).toContain('外部应用原始 UI / keep this srcDoc raw');
    });
    expect(zhText).toContain(descriptor.tool_name);
    expect(enText).toContain(descriptor.tool_name);
    expect(zhSection?.getAttribute('aria-label')).toBeTruthy();
    expect(enSection?.getAttribute('aria-label')).toBeTruthy();
    expect(enText).not.toBe(zhText);
    expect(enTitle).not.toBe(zhTitle);
  });

  /** 验证拒绝副作用工具时，confirm 和 RPC 错误均使用宿主产品文案且不泄露 raw 参数。 */
  it('localizes native consent and cancellation postMessage errors', async () => {
    const rawToolName = 'tool-中文-raw';
    const addEventListener = vi.spyOn(window, 'addEventListener');
    apiMocks.get.mockResolvedValue(buildResource());
    apiMocks.post.mockResolvedValue({ success: true, requires_confirmation: true });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const view = renderMcpView('en-US', buildDescriptor(rawToolName));
    const iframe = await screen.findByTitle(/MCP App/) as HTMLIFrameElement;
    const postMessage = vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(() => undefined);
    await waitFor(() => {
      expect(addEventListener).toHaveBeenCalledWith('message', expect.any(Function));
    });

    dispatchIframeMessage(iframe, {
      method: 'tools/call',
      id: 'request-1',
      params: { name: rawToolName, arguments: { userPayload: '用户原始输入' } },
    });

    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(confirm.mock.calls[0]?.[0]).toContain(rawToolName);
    expect(confirm.mock.calls[0]?.[0]).not.toContain('是否继续');
    await waitFor(() => expect(postMessage).toHaveBeenCalled());
    const cancellation = postMessage.mock.calls
      .map((call) => (call as [unknown])[0] as { error?: { code?: number; message?: string } })
      .find((message) => message.error?.code === -32001);
    expect(cancellation?.error?.message).toBeTruthy();
    expect(cancellation?.error?.message).not.toContain('用户取消了工具调用');
    expect(cancellation?.error?.message).not.toContain('用户原始输入');
    view.unmount();
  });

  /** 验证 provider 原始错误只保留在诊断边界，postMessage 对外返回安全本地化产品错误。 */
  it('does not expose provider error text in a localized postMessage product error', async () => {
    const rawProviderError = 'provider secret raw failure 中文详情';
    const addEventListener = vi.spyOn(window, 'addEventListener');
    apiMocks.get.mockResolvedValue(buildResource());
    apiMocks.post.mockResolvedValue({
      success: false,
      requires_confirmation: false,
      error: { code: 'PROVIDER_FAILURE', message: rawProviderError },
    });
    const view = renderMcpView('en-US');
    const iframe = await screen.findByTitle(/MCP App/) as HTMLIFrameElement;
    const postMessage = vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(() => undefined);
    await waitFor(() => {
      expect(addEventListener).toHaveBeenCalledWith('message', expect.any(Function));
    });

    dispatchIframeMessage(iframe, {
      method: 'ui/tools/call',
      id: 'request-2',
      params: { name: 'tool-中文-raw', arguments: { raw: 'business input' } },
    });

    await waitFor(() => expect(postMessage).toHaveBeenCalled());
    const productError = postMessage.mock.calls
      .map((call) => (call as [unknown])[0] as { error?: { code?: number; message?: string } })
      .find((message) => message.error?.code === -32000);
    expect(productError?.error?.message).toBeTruthy();
    expect(productError?.error?.message).not.toBe(rawProviderError);
    expect(productError?.error?.message).not.toContain('MCP App 工具调用失败');
    expect(productError?.error?.message).not.toContain('secret raw failure');
    view.unmount();
  });
});
