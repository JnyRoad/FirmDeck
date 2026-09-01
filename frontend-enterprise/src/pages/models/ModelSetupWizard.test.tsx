// @vitest-environment jsdom

import { createElement } from 'react';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TenantSessionContextValue } from '@/contexts/TenantSessionContext';
import { I18nProvider } from '@/i18n';
import type { ModelConfigRead } from '@/types';
import ModelSetupWizard, { type ModelSetupWizardProps } from './ModelSetupWizard';

const testState = vi.hoisted(() => ({
  mockedPost: vi.fn(),
  mockedPut: vi.fn(),
  currentContext: null as TenantSessionContextValue | null,
}));

vi.mock('@/api/tenant-client', () => ({
  createTenantClient: vi.fn(() => ({
    post: testState.mockedPost,
    put: testState.mockedPut,
  })),
}));

vi.mock('@/contexts/TenantSessionContext', () => ({
  useTenantSession: () => testState.currentContext,
}));

const mockedPost = testState.mockedPost;
const mockedPut = testState.mockedPut;

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

/** 使用已验证租户上下文和默认依赖渲染模型创建向导。 */
function renderWizard(overrides: Partial<ModelSetupWizardProps> = {}) {
  const props: ModelSetupWizardProps = {
    open: true,
    onOpenChange: vi.fn(),
    onCreated: vi.fn(),
    availableProtocols: ['openai_chat_completions', 'anthropic_messages', 'gemini_generate_content'],
    subscriptionAccount: null,
    subscriptionLoading: false,
    onStartSubscriptionLogin: vi.fn(),
    onCancelSubscriptionLogin: vi.fn(),
    onRequestSubscriptionLogout: vi.fn(),
    ...overrides,
  };
  return {
    props,
    ...render(createElement(I18nProvider, null, createElement(ModelSetupWizard, props))),
  };
}

async function selectChannelAndAdvance(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByRole('option', { name }));
  await user.click(await screen.findByRole('button', { name: '下一步' }));
}

function nextButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: '下一步' }) as HTMLButtonElement;
}

/** 返回会先验证连接再持久化配置的主保存按钮。 */
function saveButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: '保存' }) as HTMLButtonElement;
}

// API Key fields fetch the model list on blur, which also calls the tenant
// client — this
// keeps that call harmlessly "unsupported" so tests can assert on the save/test
// calls (queued via `then`) without the two interleaving.
function stubApiPost(...then: Array<() => Promise<unknown>>) {
  let index = 0;
  mockedPost.mockImplementation((url: unknown) => {
    if (String(url).includes('/list-models')) {
      return Promise.resolve({ success: false, models: [] });
    }
    const handler = then[index++];
    return handler ? handler() : Promise.reject(new Error(`unexpected extra api.post call: ${String(url)}`));
  });
}

function findNonListModelsCall(): [string, Record<string, unknown>] {
  const call = mockedPost.mock.calls.find(([url]) => !String(url).includes('/list-models'));
  if (!call) throw new Error('no non-list-models api.post call was made');
  return call as [string, Record<string, unknown>];
}

beforeEach(() => {
  stubSelectPointerCapture();
  testState.currentContext = makeTenantContext('tenant-isolated');
  mockedPost.mockReset();
  mockedPut.mockReset();
  stubApiPost(); // safe default: list-models routes to "unsupported", anything else rejects loudly
});

afterEach(() => {
  cleanup();
});

describe('ModelSetupWizard — step 1 channel selection', () => {
  it('disables 下一步 until a channel is selected', async () => {
    renderWizard();
    expect(nextButton().disabled).toBe(true);
  });

  it('lists preset vendors and the custom/subscription channels', () => {
    renderWizard();
    expect(screen.getByRole('option', { name: 'OpenAI' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Anthropic' })).toBeTruthy();
    expect(screen.getByRole('option', { name: '自定义渠道' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'ChatGPT 订阅（Codex）' })).toBeTruthy();
  });

  it('filters the channel list by search keyword', async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.type(screen.getByPlaceholderText('搜索厂商或渠道，例如 OpenAI'), 'anthropic');
    expect(screen.queryByRole('option', { name: 'OpenAI' })).toBeNull();
    expect(screen.getByRole('option', { name: 'Anthropic' })).toBeTruthy();
  });

  it('shows an empty state when the search matches nothing', async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.type(screen.getByPlaceholderText('搜索厂商或渠道，例如 OpenAI'), 'no-such-vendor');
    expect(screen.getByText('未找到匹配的渠道')).toBeTruthy();
  });
});

describe('ModelSetupWizard — edit mode', () => {
  const EDITING_MODEL = {
    id: 'model-edit-1',
    tenant_id: 'tenant-isolated',
    name: 'OpenAI · gpt-4o',
    provider: 'openai_compatible',
    auth_mode: 'api_key',
    api_protocol: 'openai_chat_completions',
    base_url: 'https://api.openai.com/v1',
    api_key_masked: 'sk-****1234',
    model: 'gpt-4o',
    temperature: 0.2,
    max_output_tokens: 8192,
    extra_body: {},
    protocol_options: {},
    legacy_unmapped_options: {},
    trust_status: 'verified',
    verification_attempt_status: 'succeeded',
    config_revision: 1,
    security_revision: 1,
    is_default: false,
    enabled: true,
    created_at: '2026-08-31T00:00:00Z',
    updated_at: '2026-08-31T00:00:00Z',
  } as ModelConfigRead;

  it('opens an existing model in the guided form and preserves its secret when the field is blank', async () => {
    mockedPut.mockResolvedValue(EDITING_MODEL);
    const onCreated = vi.fn();
    const user = userEvent.setup();
    renderWizard({ editingModel: EDITING_MODEL, onCreated });

    expect(await screen.findByPlaceholderText('不修改请留空')).toBeTruthy();
    expect(screen.getByDisplayValue('gpt-4o')).toBeTruthy();
    expect(screen.getByText('选择渠道')).toBeTruthy();
    expect(screen.getByText('填写凭证并保存')).toBeTruthy();
    expect(saveButton().disabled).toBe(false);

    await user.click(saveButton());

    await waitFor(() => expect(mockedPut).toHaveBeenCalledTimes(1));
    expect(mockedPut).toHaveBeenCalledWith(
      '/api/enterprise/model-configs/model-edit-1?verify_before_save=true',
      expect.objectContaining({
        name: 'OpenAI · gpt-4o',
        model: 'gpt-4o',
        enabled: true,
      }),
    );
    expect(mockedPut.mock.calls[0]?.[1]).not.toHaveProperty('api_key');
    expect(onCreated).toHaveBeenCalledWith(EDITING_MODEL, { tested: true });
  });

  it('keeps a legacy OpenAI default endpoint implicit while preserving its existing secret', async () => {
    const legacyModel = { ...EDITING_MODEL, base_url: null };
    mockedPut.mockResolvedValue(legacyModel);
    const user = userEvent.setup();
    renderWizard({ editingModel: legacyModel });

    expect(await screen.findByPlaceholderText('不修改请留空')).toBeTruthy();
    expect(saveButton().disabled).toBe(false);

    await user.click(saveButton());

    await waitFor(() => expect(mockedPut).toHaveBeenCalledTimes(1));
    expect(mockedPut.mock.calls[0]?.[1]).not.toHaveProperty('api_key');
    expect(mockedPut.mock.calls[0]?.[1]).not.toHaveProperty('base_url');
  });
});

describe('ModelSetupWizard — vendor branch (US1)', () => {
  it('shows only API Key and 模型 fields, with protocol/Base URL hidden by default', async () => {
    const user = userEvent.setup();
    renderWizard();
    await selectChannelAndAdvance(user, 'OpenAI');

    expect(screen.getByText('API Key')).toBeTruthy();
    expect(screen.getByText('模型')).toBeTruthy();
    expect(screen.queryByText('Base URL')).toBeNull();
    expect(screen.queryByText('API 协议')).toBeNull();
  });

  it('puts 配置名称 at the top of the step, above the credential fields', async () => {
    const user = userEvent.setup();
    renderWizard();
    await selectChannelAndAdvance(user, 'OpenAI');

    const position = screen.getByText('配置名称').compareDocumentPosition(screen.getByText('API Key'));
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('reveals the preset protocol and Base URL as read-only text under 高级设置', async () => {
    const user = userEvent.setup();
    renderWizard();
    await selectChannelAndAdvance(user, 'OpenAI');
    await user.click(screen.getByText('高级设置（协议 / 接口地址）'));

    expect(screen.getByText(/api\.openai\.com/)).toBeTruthy();
  });

  it('keeps 保存 disabled until API Key and model are filled', async () => {
    const user = userEvent.setup();
    renderWizard();
    await selectChannelAndAdvance(user, 'OpenAI');

    expect(saveButton().disabled).toBe(true);
    expect(screen.queryByRole('button', { name: '测试' })).toBeNull();
    expect(screen.queryByText('启用')).toBeNull();
  });

  it('保存 verifies and activates in one call, then closes the wizard', async () => {
    const fakeModel = { id: 'model-1', name: 'OpenAI · GPT-4o' } as ModelConfigRead;
    stubApiPost(() => Promise.resolve(fakeModel));
    const onCreated = vi.fn();
    const user = userEvent.setup();
    const { props } = renderWizard({ onCreated });

    await selectChannelAndAdvance(user, 'OpenAI');
    await user.type(screen.getByPlaceholderText('sk-...'), 'sk-test-123');
    await user.type(screen.getByPlaceholderText('选择或输入模型'), 'gpt-4o');

    await user.click(saveButton());

    await waitFor(() => expect(mockedPost).toHaveBeenCalled());
    const [url, body] = findNonListModelsCall();
    expect(url).toBe('/api/enterprise/model-configs?verify_before_save=true');
    expect(body.auth_mode).toBe('api_key');
    expect(body.api_protocol).toBe('openai_chat_completions');
    expect(body.base_url).toBe('https://api.openai.com/v1');
    expect(body.api_key).toBe('sk-test-123');
    expect(body.model).toBe('gpt-4o');
    expect(body.enabled).toBe(true);
    expect(body).not.toHaveProperty('tenant_id');

    // 保存先完成连接验证，验证通过后已持久化并可直接关闭向导。
    await waitFor(() => expect(props.onOpenChange).toHaveBeenCalledWith(false));
    expect(onCreated).toHaveBeenCalledWith(fakeModel, { tested: true });
  });

  it('保存时连接测试失败则提示原因、保持向导打开且不创建模型', async () => {
    stubApiPost(() => Promise.reject(new Error('boom')));
    const onCreated = vi.fn();
    const user = userEvent.setup();
    const { props } = renderWizard({ onCreated });

    await selectChannelAndAdvance(user, 'OpenAI');
    await user.type(screen.getByPlaceholderText('sk-...'), 'sk-test-123');
    await user.type(screen.getByPlaceholderText('选择或输入模型'), 'gpt-4o');

    await user.click(saveButton());

    expect(await screen.findByText('模型保存或连接测试失败，请检查配置后重试。')).toBeTruthy();
    expect(onCreated).not.toHaveBeenCalled();
    expect(props.onOpenChange).not.toHaveBeenCalled();
    expect(saveButton()).toBeTruthy();
  });

  it('keeps 保存 disabled when the config name is cleared', async () => {
    const user = userEvent.setup();
    renderWizard();

    await selectChannelAndAdvance(user, 'OpenAI');
    await user.type(screen.getByPlaceholderText('sk-...'), 'sk-test-123');
    await user.type(screen.getByPlaceholderText('选择或输入模型'), 'gpt-4o');

    const nameInput = screen.getByDisplayValue('OpenAI · gpt-4o');
    await user.clear(nameInput);

    expect(saveButton().disabled).toBe(true);
  });

  it('caps 配置名称 at 30 characters so a long vendor/model combo cannot overflow the stat card and table', async () => {
    const user = userEvent.setup();
    renderWizard();
    await selectChannelAndAdvance(user, 'OpenAI');

    const nameInput = screen.getByDisplayValue('OpenAI') as HTMLInputElement;
    expect(nameInput.maxLength).toBe(30);
  });

  it('shows a reached-the-limit hint once 配置名称 hits the max length', async () => {
    const user = userEvent.setup();
    renderWizard();
    await selectChannelAndAdvance(user, 'OpenAI');

    const nameInput = screen.getByDisplayValue('OpenAI') as HTMLInputElement;
    await user.clear(nameInput);
    await user.type(nameInput, 'x'.repeat(30));

    expect(screen.getByText(/已达到上限/)).toBeTruthy();
  });

  it('clears a name the user typed for the old channel when switching to a different one — it must not leak into the new channel\'s suggested name', async () => {
    const user = userEvent.setup();
    renderWizard();

    await selectChannelAndAdvance(user, 'OpenAI');
    const nameInput = screen.getByDisplayValue('OpenAI') as HTMLInputElement;
    await user.clear(nameInput);
    await user.type(nameInput, '我的 OpenAI 配置');

    await user.click(screen.getByRole('button', { name: '上一步' }));
    await selectChannelAndAdvance(user, 'Anthropic');

    expect(screen.queryByDisplayValue('我的 OpenAI 配置')).toBeNull();
    expect(screen.getByDisplayValue('Anthropic')).toBeTruthy();
  });
});

describe('ModelSetupWizard — auto-fetching the model list', () => {
  it('ignores a pending model-list response and closes when the tenant changes', async () => {
    let resolveFirstTenant:
      | ((value: { success: boolean; models: Array<{ id: string; label: string }> }) => void)
      | undefined;
    mockedPost.mockImplementation((url: unknown) => {
      const requestUrl = String(url);
      if (requestUrl.includes('/list-models') && testState.currentContext?.tenantId === 'tenant-first') {
        return new Promise((resolve) => {
          resolveFirstTenant = resolve;
        });
      }
      if (requestUrl.includes('/list-models') && testState.currentContext?.tenantId === 'tenant-second') {
        return Promise.resolve({
          success: true,
          models: [{ id: 'tenant-second-model', label: 'tenant-second-model' }],
        });
      }
      return Promise.reject(new Error(`unexpected call: ${requestUrl}`));
    });
    const user = userEvent.setup();
    testState.currentContext = makeTenantContext('tenant-first', 1);
    const rendered = renderWizard();

    await selectChannelAndAdvance(user, 'OpenAI');
    const apiKeyInput = screen.getByPlaceholderText('sk-...');
    await user.type(apiKeyInput, 'sk-shared-key');
    await user.tab();
    await waitFor(() => expect(mockedPost.mock.calls.some(([url]) => String(url).includes('/list-models'))).toBe(true));

    testState.currentContext = makeTenantContext('tenant-second', 2);
    rendered.rerender(
      createElement(
        I18nProvider,
        null,
        createElement(ModelSetupWizard, rendered.props),
      ),
    );
    await act(async () => {
      resolveFirstTenant?.({
        success: true,
        models: [{ id: 'tenant-first-model', label: 'tenant-first-model' }],
      });
      await Promise.resolve();
    });

    await waitFor(() => expect(rendered.props.onOpenChange).toHaveBeenCalledWith(false));
    expect(screen.queryByPlaceholderText('sk-...')).toBeNull();
    expect(screen.queryByText('tenant-first-model')).toBeNull();
    expect(screen.queryByText('tenant-second-model')).toBeNull();
  });

  it('fetches vendor models on API Key blur and offers them in the combobox', async () => {
    mockedPost.mockImplementation((url: unknown) => {
      if (String(url).includes('/list-models')) {
        return Promise.resolve({
          success: true,
          models: [{ id: 'gpt-4o-2026', label: 'gpt-4o-2026' }],
        });
      }
      return Promise.reject(new Error('unexpected call'));
    });
    const user = userEvent.setup();
    renderWizard();

    await selectChannelAndAdvance(user, 'OpenAI');
    const apiKeyInput = screen.getByPlaceholderText('sk-...');
    await user.type(apiKeyInput, 'sk-real-key');
    await user.tab(); // blur API Key -> triggers the fetch

    expect(await screen.findByText(/已自动获取到 1 个模型/)).toBeTruthy();
    const [url, body] = mockedPost.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toContain('/list-models');
    expect(url).not.toContain('tenant_id=');
    expect(body).not.toHaveProperty('tenant_id');
    expect(body.api_protocol).toBe('openai_chat_completions');
    expect(body.base_url).toBe('https://api.openai.com/v1');
    expect(body.api_key).toBe('sk-real-key');

    await user.click(screen.getByPlaceholderText('选择或输入模型'));
    await user.click(await screen.findByText('gpt-4o-2026'));
    expect((screen.getByPlaceholderText('选择或输入模型') as HTMLInputElement).value).toBe('gpt-4o-2026');
  });

  it('never shows guessed candidates when the fetch fails — only a real fetch may populate the dropdown', async () => {
    stubApiPost(); // default: list-models resolves { success: false, models: [] }
    const user = userEvent.setup();
    renderWizard();

    await selectChannelAndAdvance(user, 'OpenAI');
    await user.type(screen.getByPlaceholderText('sk-...'), 'sk-bad-key');
    await user.tab();

    expect(await screen.findByText(/未能自动获取模型列表/)).toBeTruthy();
    const modelInput = screen.getByPlaceholderText('选择或输入模型') as HTMLInputElement;
    await user.click(modelInput);
    // No dropdown option must appear — showing any candidate here would look
    // exactly like a real fetch result and mislead the user into thinking a
    // model list was actually retrieved when it wasn't.
    expect(screen.queryByRole('button', { name: /gpt|claude/i })).toBeNull();

    await user.type(modelInput, 'my-own-model-name');
    expect(modelInput.value).toBe('my-own-model-name');
  });

  it('fetches custom-channel models once protocol, Base URL and API Key are all filled', async () => {
    mockedPost.mockImplementation((url: unknown) => {
      if (String(url).includes('/list-models')) {
        return Promise.resolve({ success: true, models: [{ id: 'local-model', label: 'local-model' }] });
      }
      return Promise.reject(new Error('unexpected call'));
    });
    const user = userEvent.setup();
    renderWizard();

    await selectChannelAndAdvance(user, '自定义渠道');
    await user.type(screen.getByPlaceholderText('例如 https://your-proxy.example.com/v1'), 'https://my-proxy.test/v1');
    await user.type(screen.getByPlaceholderText('sk-...'), 'sk-custom-key');
    await user.tab();

    expect(await screen.findByText(/已自动获取到 1 个模型/)).toBeTruthy();
    const [, body] = mockedPost.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.base_url).toBe('https://my-proxy.test/v1');
    expect(body.api_key).toBe('sk-custom-key');
  });

  it('auto-fetches the real Codex-managed model catalog once the subscription is connected', async () => {
    mockedPost.mockImplementation((url: unknown) => {
      if (String(url).includes('/list-models')) {
        return Promise.resolve({
          success: true,
          models: [{ id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra' }],
        });
      }
      return Promise.reject(new Error('unexpected call'));
    });
    const user = userEvent.setup();
    renderWizard({ subscriptionAccount: { status: 'connected', plan_type: 'Plus', message: '已连接' } });

    await selectChannelAndAdvance(user, 'ChatGPT 订阅（Codex）');

    expect(await screen.findByText(/已自动获取到 1 个模型/)).toBeTruthy();
    const [url, body] = mockedPost.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toContain('/list-models');
    expect(body.api_protocol).toBe('codex_app_server');
    expect(body.api_key).toBeUndefined();

    const modelInput = screen.getByPlaceholderText('选择或输入模型') as HTMLInputElement;
    await user.click(modelInput);
    await user.click(await screen.findByText('GPT-5.6-Terra'));
    expect(modelInput.value).toBe('gpt-5.6-terra');
  });

  it('falls back to plain manual entry, with no guessed candidate, when the subscription fetch fails', async () => {
    stubApiPost(); // default: list-models resolves { success: false, models: [] }
    const user = userEvent.setup();
    renderWizard({ subscriptionAccount: { status: 'connected', plan_type: 'Plus', message: '已连接' } });

    await selectChannelAndAdvance(user, 'ChatGPT 订阅（Codex）');

    expect(await screen.findByText(/未能自动获取模型列表/)).toBeTruthy();
    const modelInput = screen.getByPlaceholderText('选择或输入模型') as HTMLInputElement;
    await user.click(modelInput);
    expect(screen.getByText('未获取到模型列表，可直接手动输入')).toBeTruthy();
    await user.type(modelInput, 'gpt-5.6-terra');
    expect(modelInput.value).toBe('gpt-5.6-terra');
  });
});

describe('ModelSetupWizard — custom channel branch (US2)', () => {
  it('shows protocol, Base URL, API Key and model fields instead of the vendor form', async () => {
    const user = userEvent.setup();
    renderWizard();
    await selectChannelAndAdvance(user, '自定义渠道');

    expect(screen.getByText('API 协议')).toBeTruthy();
    expect(screen.getByText('Base URL')).toBeTruthy();
    expect(screen.getByText('API Key')).toBeTruthy();
    expect(screen.getByText('模型')).toBeTruthy();
  });

  it('keeps 保存 disabled until Base URL, API Key and model are filled', async () => {
    const user = userEvent.setup();
    renderWizard();
    await selectChannelAndAdvance(user, '自定义渠道');

    expect(saveButton().disabled).toBe(true);
  });

  it('drops the old protocol\'s fetched model list when the API protocol changes, instead of leaving it selectable under the new one', async () => {
    // Returns a different catalog per protocol so a leftover "openai" model
    // surviving into the "anthropic" state is distinguishable from a fresh,
    // correctly-scoped refetch — both would show *some* success banner, but
    // only the stale case would still offer "openai-model" as an option.
    mockedPost.mockImplementation((url: unknown, body?: unknown) => {
      if (String(url).includes('/list-models')) {
        const protocol = (body as { api_protocol?: string } | undefined)?.api_protocol;
        return Promise.resolve({
          success: true,
          models: [{ id: `${protocol}-model`, label: `${protocol}-model` }],
        });
      }
      return Promise.reject(new Error('unexpected call'));
    });
    const user = userEvent.setup();
    renderWizard();
    await selectChannelAndAdvance(user, '自定义渠道');
    await user.type(screen.getByPlaceholderText('例如 https://your-proxy.example.com/v1'), 'https://my-proxy.test/v1');
    await user.type(screen.getByPlaceholderText('sk-...'), 'sk-custom-key');
    await user.tab();
    expect(await screen.findByText(/已自动获取到 1 个模型/)).toBeTruthy();

    await user.click(screen.getByRole('combobox'));
    await user.click(await screen.findByText('Anthropic Messages'));
    await waitFor(() => expect(mockedPost.mock.calls.length).toBeGreaterThanOrEqual(2));

    await user.click(screen.getByPlaceholderText('选择或输入模型'));
    expect(await screen.findByText('anthropic_messages-model')).toBeTruthy();
    expect(screen.queryByText('openai_chat_completions-model')).toBeNull();
  });

  it('clears an already-picked model when the API protocol changes — the old model id is not valid under the new protocol', async () => {
    mockedPost.mockImplementation((url: unknown) => {
      if (String(url).includes('/list-models')) {
        return Promise.resolve({ success: true, models: [] });
      }
      return Promise.reject(new Error('unexpected call'));
    });
    const user = userEvent.setup();
    renderWizard();
    await selectChannelAndAdvance(user, '自定义渠道');
    await user.type(screen.getByPlaceholderText('例如 https://your-proxy.example.com/v1'), 'https://my-proxy.test/v1');
    await user.type(screen.getByPlaceholderText('sk-...'), 'sk-custom-key');
    const modelInput = screen.getByPlaceholderText('选择或输入模型') as HTMLInputElement;
    await user.type(modelInput, 'gpt-4o');
    expect(modelInput.value).toBe('gpt-4o');

    await user.click(screen.getByRole('combobox'));
    await user.click(await screen.findByText('Anthropic Messages'));

    expect(modelInput.value).toBe('');
  });

  it('shows only one name field (配置名称) — no separate, unused 渠道名称 input to confuse it with', async () => {
    const user = userEvent.setup();
    renderWizard();
    await selectChannelAndAdvance(user, '自定义渠道');

    expect(screen.getAllByText('配置名称')).toHaveLength(1);
    expect(screen.queryByText('渠道名称（可选）')).toBeNull();
    expect(screen.queryByPlaceholderText('例如 我的自建代理')).toBeNull();
  });

  async function fillRequiredCustomFields(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByPlaceholderText('例如 https://your-proxy.example.com/v1'), 'https://my-proxy.test/v1');
    await user.type(screen.getByPlaceholderText('sk-...'), 'sk-test-123');
    await user.type(screen.getByPlaceholderText('选择或输入模型'), 'my-model');
  }

  it('rejects a syntactically-valid but non-object 额外请求参数 value instead of silently discarding it', async () => {
    const onCreated = vi.fn();
    const user = userEvent.setup();
    const { props } = renderWizard({ onCreated });
    await selectChannelAndAdvance(user, '自定义渠道');
    await fillRequiredCustomFields(user);

    await user.click(screen.getByText('高级参数（Temperature / Max Tokens / extra_body，可选）'));
    // A bare number is syntactically valid JSON but not an object — the same
    // shape bug as an array, without the userEvent bracket-escaping hassle.
    const extraBodyField = screen.getByPlaceholderText(/thinking/);
    await user.clear(extraBodyField);
    await user.type(extraBodyField, '123');

    await user.click(saveButton());

    expect(await screen.findByText('额外参数必须是合法的 JSON 对象')).toBeTruthy();
    expect(onCreated).not.toHaveBeenCalled();
    expect(props.onOpenChange).not.toHaveBeenCalled();
  });

  it('rejects a blank Temperature instead of silently sending 0', async () => {
    const onCreated = vi.fn();
    const user = userEvent.setup();
    const { props } = renderWizard({ onCreated });
    await selectChannelAndAdvance(user, '自定义渠道');
    await fillRequiredCustomFields(user);

    await user.click(screen.getByText('高级参数（Temperature / Max Tokens / extra_body，可选）'));
    await user.clear(screen.getByDisplayValue('0.2'));

    await user.click(saveButton());

    expect(await screen.findByText('Temperature 与 Max Tokens 必须是数字')).toBeTruthy();
    expect(onCreated).not.toHaveBeenCalled();
    expect(props.onOpenChange).not.toHaveBeenCalled();
  });
});

describe('ModelSetupWizard — ChatGPT subscription branch (US3)', () => {
  it('never shows an API Key field', async () => {
    const user = userEvent.setup();
    renderWizard();
    await selectChannelAndAdvance(user, 'ChatGPT 订阅（Codex）');

    expect(screen.queryByPlaceholderText('sk-...')).toBeNull();
  });

  it('keeps 保存 disabled until the subscription account is connected', async () => {
    const user = userEvent.setup();
    renderWizard({ subscriptionAccount: { status: 'requires_login', plan_type: null, message: '未登录' } });
    await selectChannelAndAdvance(user, 'ChatGPT 订阅（Codex）');

    expect(saveButton().disabled).toBe(true);
  });

  it('keeps 保存 disabled when connected but no model has been chosen', async () => {
    const user = userEvent.setup();
    renderWizard({ subscriptionAccount: { status: 'connected', plan_type: 'Plus', message: '已连接' } });
    await selectChannelAndAdvance(user, 'ChatGPT 订阅（Codex）');

    expect(saveButton().disabled).toBe(true);
  });

  it('enables 保存 once the subscription account is connected and a model is chosen', async () => {
    const user = userEvent.setup();
    renderWizard({ subscriptionAccount: { status: 'connected', plan_type: 'Plus', message: '已连接' } });
    await selectChannelAndAdvance(user, 'ChatGPT 订阅（Codex）');
    await user.type(screen.getByPlaceholderText('选择或输入模型'), 'gpt-5.6-terra');

    expect(saveButton().disabled).toBe(false);
  });
});

describe('ModelSetupWizard — switching channels clears stale credentials (FR-013)', () => {
  it('disables the optional Codex account check immediately after leaving the subscription channel', async () => {
    const onSubscriptionSelected = vi.fn();
    const user = userEvent.setup();
    renderWizard({ onSubscriptionSelected });

    await user.click(await screen.findByRole('option', { name: 'ChatGPT 订阅（Codex）' }));
    expect(onSubscriptionSelected).toHaveBeenLastCalledWith(true);

    await user.click(screen.getByRole('option', { name: 'OpenAI' }));
    expect(onSubscriptionSelected).toHaveBeenLastCalledWith(false);
  });

  it('does not leak the vendor API Key into the custom channel form', async () => {
    const user = userEvent.setup();
    renderWizard();

    await selectChannelAndAdvance(user, 'OpenAI');
    await user.type(screen.getByPlaceholderText('sk-...'), 'sk-leaked-secret');
    await user.click(screen.getByRole('button', { name: '上一步' }));

    await selectChannelAndAdvance(user, '自定义渠道');
    expect((screen.getByPlaceholderText('sk-...') as HTMLInputElement).value).toBe('');
  });

  it('also clears the API Key when switching between two vendors of the same category', async () => {
    const user = userEvent.setup();
    renderWizard();

    await selectChannelAndAdvance(user, 'OpenAI');
    await user.type(screen.getByPlaceholderText('sk-...'), 'sk-openai-secret');
    await user.click(screen.getByRole('button', { name: '上一步' }));

    await selectChannelAndAdvance(user, 'Anthropic');
    expect((screen.getByPlaceholderText('sk-...') as HTMLInputElement).value).toBe('');
  });

  it('clears a stale test-result banner from the previous channel when switching — a failed/passed test for OpenAI must never be shown as if it applied to a channel the user has not tested yet', async () => {
    stubApiPost(() => Promise.reject(new Error('openai test failed')));
    const user = userEvent.setup();
    renderWizard();

    await selectChannelAndAdvance(user, 'OpenAI');
    await user.type(screen.getByPlaceholderText('sk-...'), 'sk-test-123');
    await user.type(screen.getByPlaceholderText('选择或输入模型'), 'gpt-4o');
    await user.click(saveButton());
    expect(await screen.findByText('模型保存或连接测试失败，请检查配置后重试。')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '上一步' }));
    await selectChannelAndAdvance(user, 'Anthropic');

    expect(screen.queryByText('模型保存或连接测试失败，请检查配置后重试。')).toBeNull();
  });
});

describe('ModelSetupWizard — tenant generation isolation', () => {
  it('closes and clears the active form when the tenant generation changes', async () => {
    const user = userEvent.setup();
    const rendered = renderWizard();

    await selectChannelAndAdvance(user, 'OpenAI');
    await user.type(screen.getByPlaceholderText('sk-...'), 'sk-tenant-one-secret');
    await user.type(screen.getByPlaceholderText('选择或输入模型'), 'tenant-one-model');

    testState.currentContext = makeTenantContext('tenant-two', 2);
    rendered.rerender(createElement(I18nProvider, null, createElement(ModelSetupWizard, rendered.props)));

    await waitFor(() => expect(rendered.props.onOpenChange).toHaveBeenCalledWith(false));
    expect(screen.queryByDisplayValue('sk-tenant-one-secret')).toBeNull();
    expect(screen.queryByDisplayValue('tenant-one-model')).toBeNull();
  });
});

describe('ModelSetupWizard — dialog chrome', () => {
  it('shows exactly one close button, not the DialogContent default plus a second custom one', () => {
    renderWizard();
    // DialogContent renders its own "Close" (sr-only, English) button unless
    // told not to — a real bug shipped two overlapping X icons because this
    // wizard also renders its own "关闭" button in the header.
    expect(screen.queryByText('Close')).toBeNull();
    expect(screen.getByRole('button', { name: '关闭' })).toBeTruthy();
  });
});

describe('ModelSetupWizard — closing mid-flow discards unsaved input', () => {
  it('resets to step 1 with no channel selected the next time it opens', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const { rerender } = renderWizard({ onOpenChange });

    await selectChannelAndAdvance(user, 'OpenAI');
    await user.type(screen.getByPlaceholderText('sk-...'), 'sk-abandoned');
    await user.click(screen.getByRole('button', { name: '关闭' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);

    rerender(createElement(I18nProvider, null, createElement(ModelSetupWizard, {
      open: true,
      onOpenChange,
      onCreated: vi.fn(),
      availableProtocols: ['openai_chat_completions'],
      subscriptionAccount: null,
      subscriptionLoading: false,
      onStartSubscriptionLogin: vi.fn(),
      onCancelSubscriptionLogin: vi.fn(),
      onRequestSubscriptionLogout: vi.fn(),
    })));

    expect(nextButton().disabled).toBe(true);
    await selectChannelAndAdvance(user, 'OpenAI');
    expect((screen.getByPlaceholderText('sk-...') as HTMLInputElement).value).toBe('');
  });
});

describe('ModelSetupWizard — sidebar progress', () => {
  it('shows the selected channel name as the step-1 summary once past step 1', async () => {
    const user = userEvent.setup();
    renderWizard();
    await selectChannelAndAdvance(user, 'Anthropic');

    const sidebar = screen.getByText('选择渠道').closest('button');
    expect(sidebar).not.toBeNull();
    expect(within(sidebar as HTMLElement).getByText('Anthropic')).toBeTruthy();
  });
});
