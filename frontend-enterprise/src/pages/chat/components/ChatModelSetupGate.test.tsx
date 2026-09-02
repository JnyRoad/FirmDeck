// @vitest-environment jsdom

import { createElement } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TenantSessionContextValue } from '@/contexts/TenantSessionContext';
import { I18nProvider } from '@/i18n';
import type { CodexSubscriptionAccountRead, ModelConfigRead } from '@/types';
import ChatModelSetupGate, { type ChatModelSetupGateProps } from './ChatModelSetupGate';

const testState = vi.hoisted(() => ({
  mockedGet: vi.fn(),
  mockedPost: vi.fn(),
  currentContext: null as TenantSessionContextValue | null,
}));

vi.mock('@/api/tenant-client', () => ({
  createTenantClient: vi.fn(() => ({
    get: testState.mockedGet,
    post: testState.mockedPost,
    put: vi.fn(),
  })),
}));

vi.mock('@/contexts/TenantSessionContext', () => ({
  useTenantSession: () => testState.currentContext,
}));

const mockedGet = testState.mockedGet;
const mockedPost = testState.mockedPost;

const requiresLogin = {
  status: 'requires_login',
  plan_type: null,
  message: '尚未连接',
} as CodexSubscriptionAccountRead;

function makeTenantContext(tenantId: string, generation = 1): TenantSessionContextValue {
  const controller = new AbortController();
  return {
    session: {
      token: `token-${tenantId}`,
      scope: 'tenant',
      tenant: { id: tenantId, slug: tenantId, display_name: tenantId },
      user: {
        id: 'user-1',
        tenant_id: tenantId,
        username: 'test-user',
        display_name: 'Test User',
        role: 'admin',
        must_change_password: false,
        avatar_url: null,
      },
    },
    tenantId,
    tenantSlug: tenantId,
    userId: 'user-1',
    generation,
    signal: controller.signal,
    isCurrentGeneration: (candidate) => candidate === generation && !controller.signal.aborted,
  };
}

/** 渲染带国际化上下文的聊天模型门禁。 */
function renderGate(overrides: Partial<ChatModelSetupGateProps> = {}) {
  const props: ChatModelSetupGateProps = {
    open: true,
    canConfigure: true,
    onOpenChange: vi.fn(),
    onConfigured: vi.fn(),
    ...overrides,
  };
  return {
    props,
    ...render(createElement(I18nProvider, null, createElement(ChatModelSetupGate, props))),
  };
}

/** 补齐 Radix Select 在 jsdom 中依赖的指针捕获接口。 */
function stubSelectPointerCapture() {
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
  if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => {};
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
}

beforeEach(() => {
  stubSelectPointerCapture();
  testState.currentContext = makeTenantContext('tenant-isolated');
  mockedGet.mockReset();
  mockedPost.mockReset();
  mockedGet.mockImplementation((url: unknown) => {
    const requestUrl = String(url);
    if (requestUrl.includes('/protocols')) {
      return Promise.resolve({ protocols: ['openai_chat_completions'] });
    }
    if (requestUrl.includes('/codex-subscription/account')) return Promise.resolve(requiresLogin);
    return Promise.reject(new Error(`unexpected api.get call: ${requestUrl}`));
  });
});

afterEach(() => cleanup());

describe('ChatModelSetupGate', () => {
  it('shows the shared channel wizard for an administrator and scopes all reads to the verified tenant', async () => {
    renderGate();

    expect(await screen.findByRole('option', { name: 'OpenAI' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'ChatGPT 订阅（Codex）' })).toBeTruthy();
    expect(screen.getByRole('option', { name: '自定义渠道' })).toBeTruthy();
    expect(screen.queryByText('需要先配置模型')).toBeNull();

    expect(mockedGet).toHaveBeenCalledWith(
      '/api/enterprise/model-configs/protocols',
    );
    expect(mockedGet).toHaveBeenCalledWith(
      '/api/enterprise/model-configs/codex-subscription/account',
    );
  });

  it('uses 保存 to test and persist, then completes only after validation passes', async () => {
    const savedModel = { id: 'model-verified', name: 'OpenAI · gpt-4o' } as ModelConfigRead;
    mockedPost.mockImplementation((url: unknown) => {
      if (String(url).includes('/list-models')) return Promise.resolve({ success: false, models: [] });
      if (String(url).includes('verify_before_save=true')) return Promise.resolve(savedModel);
      return Promise.reject(new Error(`unexpected api.post call: ${String(url)}`));
    });
    const user = userEvent.setup();
    const { props } = renderGate();

    await user.click(await screen.findByRole('option', { name: 'OpenAI' }));
    await user.click(screen.getByRole('button', { name: '下一步' }));
    expect(screen.queryByRole('button', { name: '测试' })).toBeNull();

    await user.type(screen.getByPlaceholderText('sk-...'), 'sk-test-123');
    await user.type(screen.getByPlaceholderText('选择或输入模型'), 'gpt-4o');
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(props.onConfigured).toHaveBeenCalledWith(savedModel));
    const saveCall = mockedPost.mock.calls.find(([url]) => String(url).includes('verify_before_save=true'));
    expect(saveCall?.[1]).toMatchObject({ enabled: true });
    expect(saveCall?.[1]).not.toHaveProperty('tenant_id');
  });

  it('shows only the administrator-contact notice to users without model-management permission', async () => {
    renderGate({ canConfigure: false });

    expect(screen.getByText('当前账号没有模型管理权限，请联系管理员完成模型配置和连通性测试。')).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'OpenAI' })).toBeNull();
    expect(screen.queryByText('API Key')).toBeNull();
    await waitFor(() => expect(mockedGet).not.toHaveBeenCalled());
  });
});
