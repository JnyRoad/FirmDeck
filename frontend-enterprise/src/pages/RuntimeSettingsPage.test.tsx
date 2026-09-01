// @vitest-environment jsdom

import type { InputHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { notify } from '@/components/ui';
import { AppIntlProvider, I18nProvider, type AppLocale } from '@/i18n';
import type { TenantSessionContextValue } from '@/contexts/TenantSessionContext';

import RuntimeSettingsPage, {
  buildApiEndpointLinks,
  validateContextSettings,
  validateNetworkSettings,
} from './RuntimeSettingsPage';

vi.mock('@/components/ui/input', async () => {
  const { createElement } = await import('react');

  /** 用无翻译原生控件隔离早期 shared-input legacy 依赖。 */
  function SemanticTestInput(props: InputHTMLAttributes<HTMLInputElement>) {
    return createElement('input', props);
  }

  return { Input: SemanticTestInput };
});

vi.mock('@/components/ui/textarea', async () => {
  const { createElement } = await import('react');

  /** 用无翻译原生控件隔离早期 shared-textarea legacy 依赖。 */
  function SemanticTestTextarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
    return createElement('textarea', props);
  }

  return { Textarea: SemanticTestTextarea };
});

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  currentContext: null as TenantSessionContextValue | null,
}));

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      get: mocks.get,
      put: mocks.put,
    },
  };
});

vi.mock('../api/tenant-client', () => ({
  createTenantClient: () => ({
    get: mocks.get,
    put: mocks.put,
  }),
}));

vi.mock('../contexts/TenantSessionContext', () => ({
  useTenantSession: () => mocks.currentContext,
}));

const validForm = {
  show_thinking_trace: true,
  show_skill_trace: true,
  show_tool_trace: true,
  reflection_max_rounds: '1',
  agent_loop_max_actions: '32',
  context_token_budget: '32000',
  context_compaction_trigger_ratio: '0.70',
  context_recent_round_limit: '6',
  context_long_summary_token_budget: '4000',
  context_medium_summary_token_budget: '4000',
  context_allowed_roles: ['user', 'assistant'] as Array<'user' | 'assistant'>,
  context_long_summary_prefix: '历史的信息可以被总结为：',
  context_medium_summary_prefix: '近期的历史信息总结为：',
  sandbox_enabled: false,
  harness_storage_path: '',
  sandbox_network_mode: 'all' as const,
  sandbox_allowed_domains: '',
};

const runtimeSettings = {
  tenant_id: 'tenant_demo',
  show_thinking_trace: true,
  show_skill_trace: true,
  show_tool_trace: true,
  reflection_max_rounds: 1,
  agent_loop_max_actions: 32,
  context_token_budget: 32000,
  context_compaction_trigger_ratio: 0.7,
  context_recent_round_limit: 6,
  context_long_summary_token_budget: 4000,
  context_medium_summary_token_budget: 4000,
  context_allowed_roles: ['user', 'assistant'] as Array<'user' | 'assistant'>,
  context_long_summary_prefix: '历史的信息可以被总结为：',
  context_medium_summary_prefix: '近期的历史信息总结为：',
  sandbox_enabled: false,
  harness_storage_path: '',
  effective_harness_storage_path: '/Users/demo/.staffdeck/workspaces',
  restart_scheduled: false,
  sandbox_network_mode: 'all' as const,
  sandbox_allowed_domains: [],
  sandbox_status: 'disabled' as const,
  sandbox_status_message: '沙盒已由管理员关闭。',
  updated_at: '2026-08-29T00:00:00Z',
};

const networkSettings = {
  active_base_url: 'http://127.0.0.1:6204/api/v1',
  active_docs_url: 'http://127.0.0.1:6204/api/v1/docs',
  active_openapi_url: 'http://127.0.0.1:6204/api/v1/openapi.json',
  active_mode: 'local' as const,
  mode: 'local' as const,
  port: 6204,
  public_url: '',
  pending_base_url: 'http://127.0.0.1:6204/api/v1',
  restart_required: false,
};

function makeTenantContext(generation = 1): TenantSessionContextValue {
  const controller = new AbortController();
  return {
    tenantId: 'tenant_demo',
    tenantSlug: 'tenant-demo',
    userId: 'admin_demo',
    generation,
    signal: controller.signal,
    session: {
      token: 'test-token',
      scope: 'tenant',
      tenant: { id: 'tenant_demo', slug: 'tenant-demo', display_name: 'Tenant Demo' },
      user: {
        id: 'admin_demo',
        tenant_id: 'tenant_demo',
        username: 'admin',
        display_name: 'Admin',
        role: 'admin',
        must_change_password: false,
        avatar_url: null,
      },
    },
    isCurrentGeneration: (candidate) => candidate === generation && !controller.signal.aborted,
  };
}

const semanticRuntimeCopy = {
  'zh-CN': {
    adminHint: '仅管理员可修改。打开或关闭后保存将自动重启 StaffDeck。默认关闭。',
    heading: '运行设置',
    save: '保存设置',
  },
  'en-US': {
    adminHint: 'Only administrators can change this setting. Saving after a change restarts StaffDeck. Disabled by default.',
    heading: 'Runtime settings',
    save: 'Save settings',
  },
} as const;

function renderRuntimeSettings(): void {
  /** Renders the page with its locale observer and the tenant administrator identity. */

  render(
    <I18nProvider>
      <RuntimeSettingsPage
        currentUser={{
          id: 'admin_demo',
          tenant_id: 'tenant_demo',
          username: 'admin',
          role: 'admin',
        }}
      />
    </I18nProvider>,
  );
}

/** 仅用语义 Provider 渲染管理员运行设置页，排除 legacy observer 翻译。 */
function renderSemanticRuntimeSettings(locale: AppLocale): void {
  render(
    <AppIntlProvider locale={locale}>
      <RuntimeSettingsPage
        currentUser={{
          id: 'admin_demo',
          tenant_id: 'tenant_demo',
          username: 'admin',
          role: 'admin',
        }}
      />
    </AppIntlProvider>,
  );
}

beforeEach(() => {
  mocks.currentContext = makeTenantContext();
  mocks.get.mockReset();
  mocks.put.mockReset();
  mocks.get.mockImplementation((path: string) => {
    if (path.includes('/ui-config')) return Promise.resolve(runtimeSettings);
    if (path.includes('/network-settings')) return Promise.resolve(networkSettings);
    return Promise.resolve({});
  });
  mocks.put.mockResolvedValue(runtimeSettings);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('runtime context settings validation', () => {
  it('accepts the default runtime settings', () => {
    expect(validateContextSettings(validForm)).toBeNull();
  });

  it('rejects summary budgets larger than the context budget', () => {
    expect(validateContextSettings({
      ...validForm,
      context_token_budget: '7000',
    })).toBe('长期与近期摘要预算之和不能超过上下文预算');
  });

  it('requires at least one history role and both summary prefixes', () => {
    expect(validateContextSettings({
      ...validForm,
      context_allowed_roles: [],
    })).toBe('至少保留一种历史消息角色');
    expect(validateContextSettings({
      ...validForm,
      context_medium_summary_prefix: '   ',
    })).toBe('摘要前缀不能为空');
  });
});

describe('network and API endpoint helpers', () => {
  it('derives exactly one current same-machine Base URL for display', () => {
    expect(buildApiEndpointLinks('http://127.0.0.1:6204/api/v1/')).toEqual({
      baseUrl: 'http://127.0.0.1:6204/api/v1',
    });
  });

  it('validates local, LAN, and public next-launch input before save', () => {
    expect(validateNetworkSettings({ mode: 'local', port: '6204', public_url: '' })).toBeNull();
    expect(validateNetworkSettings({ mode: 'lan', port: '6205', public_url: '' })).toBeNull();
    expect(validateNetworkSettings({
      mode: 'public',
      port: '443',
      public_url: 'https://staff.example.com',
    })).toBeNull();
    expect(validateNetworkSettings({ mode: 'local', port: '0', public_url: '' })).toBe(
      '端口必须是 1 到 65535 之间的整数',
    );
    expect(validateNetworkSettings({ mode: 'public', port: '6204', public_url: '' })).toBe(
      '公网访问需要填写完整的 HTTP(S) URL',
    );
    expect(validateNetworkSettings({
      mode: 'public',
      port: '6204',
      public_url: 'https://user:secret@staff.example.com',
    })).toBe('公网 URL 不能包含用户名、密码、查询参数、片段或路径');
  });
});

describe('Harness workspace settings', () => {
  it('labels the field as a Harness-only workspace, shows its effective root, and saves the stable API field', async () => {
    const user = userEvent.setup();
    renderRuntimeSettings();

    const input = await screen.findByPlaceholderText('/Users/demo/.staffdeck/workspaces');
    expect(screen.getByText('Harness 工作区目录')).toBeTruthy();
    expect(screen.getByText('/Users/demo/.staffdeck/workspaces')).toBeTruthy();
    expect(screen.getByText(/仅用于 Harness 的任务文件和生成产物/)).toBeTruthy();
    expect(screen.queryByText('文件存储目录')).toBeNull();

    await user.type(input, '/Volumes/work/harness');
    await user.click(screen.getByRole('button', { name: '保存设置' }));

    await waitFor(() => {
      expect(mocks.put).toHaveBeenCalledWith(
        '/api/enterprise/ui-config',
        expect.objectContaining({ harness_storage_path: '/Volumes/work/harness' }),
      );
    const [path, body] = mocks.put.mock.calls[mocks.put.mock.calls.length - 1] as [
      string,
      Record<string, unknown>,
    ];
      expect(path).not.toContain('tenant_demo');
      expect(body).not.toHaveProperty('tenant_id');
    });
  });

  it('localizes the effective workspace and sandbox status for en-US', async () => {
    window.localStorage.setItem('staffdeck_locale', 'en-US');
    mocks.get.mockImplementation((path: string) => {
      if (path.includes('/ui-config')) {
        return Promise.resolve({
          ...runtimeSettings,
          sandbox_enabled: true,
          sandbox_status: 'unavailable' as const,
          sandbox_status_message: 'No sandbox runtime is available.',
        });
      }
      if (path.includes('/network-settings')) return Promise.resolve(networkSettings);
      return Promise.resolve({});
    });

    renderRuntimeSettings();

    expect(await screen.findByText('Current effective Harness workspace')).toBeTruthy();
    expect(screen.getByText('/Users/demo/.staffdeck/workspaces')).toBeTruthy();
    expect(
      screen.getByText('Sandbox status:Unavailable', { selector: '.font-medium' }),
    ).toBeTruthy();
  });
});

describe('semantic runtime settings locale contract', () => {
  for (const locale of ['zh-CN', 'en-US'] as const) {
    const copy = semanticRuntimeCopy[locale];

    it(`localizes settings actions and administrator-only permission guidance in ${locale}`, async () => {
      renderSemanticRuntimeSettings(locale);

      expect(await screen.findByText(copy.heading)).toBeTruthy();
      expect(screen.getByRole('button', { name: copy.save })).toBeTruthy();
      expect(screen.getByText(copy.adminHint)).toBeTruthy();
    });
  }

  it('localizes settings load errors without exposing raw transport messages in en-US', async () => {
    const notifyError = vi.spyOn(notify, 'error');
    mocks.get.mockImplementation((path: string) => Promise.reject(new Error(
      path.includes('/ui-config') ? 'RAW_UI_LOAD_FAILURE' : 'RAW_NETWORK_LOAD_FAILURE',
    )));

    renderSemanticRuntimeSettings('en-US');

    await waitFor(() => expect(notifyError).toHaveBeenCalledTimes(2));
    expect(notifyError).toHaveBeenCalledWith('Unable to load runtime settings.');
    expect(notifyError).toHaveBeenCalledWith('Unable to load network and API settings.');
    expect(notifyError).not.toHaveBeenCalledWith(expect.stringContaining('RAW_'));
  });
});

describe('sandbox diagnostic contract', () => {
  const cases = [
    {
      locale: 'zh-CN' as const,
      setupCopy: '需要管理员初始化 Windows 沙盒。请执行下方命令，确认 UAC 后重启 StaffDeck。',
    },
    {
      locale: 'en-US' as const,
      setupCopy: 'An administrator must initialize the Windows sandbox. Run the command below, confirm UAC, then restart StaffDeck.',
    },
  ];

  for (const { locale, setupCopy } of cases) {
    it(`localizes sandbox diagnostics and preserves technical values in ${locale}`, async () => {
      const rawCommand = '/opt/staffdeck/node srt-cli.js windows-install';
      mocks.get.mockImplementation((path: string) => {
        if (path.includes('/ui-config')) {
          return Promise.resolve({
            ...runtimeSettings,
            sandbox_enabled: true,
            sandbox_status: 'unavailable' as const,
            sandbox_status_code: 'SANDBOX_WINDOWS_SETUP_REQUIRED',
            sandbox_status_params: { backend: 'srt' },
            sandbox_remediation_code: 'SANDBOX_WINDOWS_SETUP_REQUIRED',
            sandbox_remediation_params: { command: rawCommand },
            sandbox_setup_required: true,
            sandbox_setup_code: 'SANDBOX_WINDOWS_SETUP_REQUIRED',
            sandbox_setup_params: { command: rawCommand },
            sandbox_status_message: 'RAW_STATUS_TEXT_MUST_NOT_REACH_UI',
            sandbox_status_remediation: 'RAW_REMEDIATION_TEXT_MUST_NOT_REACH_UI',
            sandbox_setup_instructions: 'RAW_SETUP_TEXT_MUST_NOT_REACH_UI',
          });
        }
        if (path.includes('/network-settings')) return Promise.resolve(networkSettings);
        return Promise.resolve({});
      });

      renderSemanticRuntimeSettings(locale);

      expect(await screen.findByText(setupCopy)).toBeTruthy();
      expect(screen.getByText(rawCommand)).toBeTruthy();
      expect(screen.getByText('srt')).toBeTruthy();
      expect(screen.getByText('/Users/demo/.staffdeck/workspaces')).toBeTruthy();
      expect(screen.queryByText('RAW_STATUS_TEXT_MUST_NOT_REACH_UI')).toBeNull();
      expect(screen.queryByText('RAW_REMEDIATION_TEXT_MUST_NOT_REACH_UI')).toBeNull();
      expect(screen.queryByText('RAW_SETUP_TEXT_MUST_NOT_REACH_UI')).toBeNull();
    });
  }

  it('does not toast but clears save loading when an old generation rejects', async () => {
    const user = userEvent.setup();
    const context = mocks.currentContext as TenantSessionContextValue;
    let rejectSave: ((reason?: unknown) => void) | undefined;
    mocks.put.mockImplementation(() => new Promise((_resolve, reject) => {
      rejectSave = reject;
    }));
    const notifyError = vi.spyOn(notify, 'error');

    renderSemanticRuntimeSettings('en-US');
    await screen.findByText('Runtime settings');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(mocks.put).toHaveBeenCalledTimes(1));

    context.isCurrentGeneration = () => false;
    rejectSave?.(new DOMException('aborted', 'AbortError'));
    await waitFor(() => expect(notifyError).not.toHaveBeenCalled());
    expect((screen.getByRole('button', { name: 'Save settings' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('clears network save loading when an old generation resolves', async () => {
    const user = userEvent.setup();
    const context = mocks.currentContext as TenantSessionContextValue;
    let resolveNetwork: ((value: typeof networkSettings) => void) | undefined;
    mocks.put.mockImplementation((path: string) => {
      if (path.includes('/network-settings')) {
        return new Promise<typeof networkSettings>((resolve) => {
          resolveNetwork = resolve;
        });
      }
      return Promise.resolve(runtimeSettings);
    });

    renderSemanticRuntimeSettings('en-US');
    const saveNetworkButton = await screen.findByRole('button', { name: 'Save next-launch settings' });
    await user.click(saveNetworkButton);
    await waitFor(() => expect(mocks.put).toHaveBeenCalledWith(
      '/api/enterprise/network-settings',
      expect.any(Object),
    ));

    context.isCurrentGeneration = () => false;
    await act(async () => {
      resolveNetwork?.(networkSettings);
      await Promise.resolve();
    });
    await waitFor(() => expect((saveNetworkButton as HTMLButtonElement).disabled).toBe(false));
  });
});
