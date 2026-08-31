// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppIntlProvider, type AppLocale } from '@/i18n';
import type { ChannelBindingRead, WeChatKfProviderAccountRead } from '@/types';

import WechatKfSetup from './WechatKfSetup';

vi.mock('qrcode', () => ({
  default: {
    toDataURL: vi.fn(async (value: string) => `data:image/png;base64,${btoa(value)}`),
  },
}));

const ownerBinding: ChannelBindingRead = {
  id: 'binding-kf',
  tenant_id: 'tenant_demo',
  agent_id: 'agent-1',
  channel: 'wechat_kf',
  status: 'pending',
  connected: false,
  corp_id: 'wwRawCorp123',
  callback_ready: false,
  agents: [],
  wechat_kf_accounts: [],
  my_role: 'owner',
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
};

/** 构造完整 fetch Response，使组件通过真实 typed client 边界执行。 */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? 'OK' : 'Bad Request',
    text: async () => JSON.stringify(body),
  } as Response;
}

/** 在真实语义 i18n Provider 下渲染微信客服 setup。 */
function renderSetup(
  locale: AppLocale,
  binding: ChannelBindingRead = ownerBinding,
  onChanged = vi.fn(),
) {
  return {
    onChanged,
    ...render(
      <AppIntlProvider initialLocale={locale}>
        <WechatKfSetup binding={binding} onChanged={onChanged} />
      </AppIntlProvider>,
    ),
  };
}

/** 返回 provider 清单中的完整账号形状，避免不完整 mock 隐藏字段访问。 */
function providerAccount(overrides: Partial<WeChatKfProviderAccountRead> = {}): WeChatKfProviderAccountRead {
  return {
    open_kfid: 'wk-bound-raw',
    name: 'Raw Provider Account',
    avatar: 'https://provider.example/avatar/raw.png',
    manage_privilege: true,
    bound: true,
    bound_binding_id: 'binding-kf',
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('WechatKfSetup', () => {
  it.each([
    ['zh-CN', '微信客服设置', '你没有管理此接入的权限。'],
    ['en-US', 'WeChat Customer Service setup', 'You do not have permission to manage this integration.'],
  ] as const)('localizes read-only permission state in %s and preserves provider identifiers', (
    locale,
    title,
    permission,
  ) => {
    renderSetup(locale, {
      ...ownerBinding,
      my_role: null,
      open_kfid: 'wk_RawIdentifier_123',
      wechat_kf_accounts: [{
        open_kfid: 'wk_RawIdentifier_123',
        name: 'Raw Provider Name',
        status: 'active',
        sync_cursor: 'cursor-raw',
      }],
    });

    expect(screen.getByRole('heading', { name: title })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain(permission);
    expect(screen.getByText('wwRawCorp123')).toBeTruthy();
    expect(screen.getByText('wk_RawIdentifier_123')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('prepares callback values, copies the raw URL, saves credentials, and clears the Secret', async () => {
    const user = userEvent.setup();
    let releasePrepare: ((response: Response) => void) | undefined;
    const prepareResponse = new Promise<Response>((resolve) => {
      releasePrepare = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/callback-config')) return prepareResponse;
      if (url.endsWith('/credentials')) {
        return jsonResponse({ ...ownerBinding, callback_ready: true, status: 'active' });
      }
      if (url.includes('/accounts?')) return jsonResponse({ accounts: [] });
      return jsonResponse({});
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    vi.stubGlobal('fetch', fetchMock);
    renderSetup('en-US');

    await user.click(screen.getByRole('button', { name: 'Prepare callback' }));
    expect(screen.getByRole('button', { name: 'Preparing callback…' }).hasAttribute('disabled')).toBe(true);
    releasePrepare?.(jsonResponse({
      callback_url: '/api/channels/wechat-kf/binding-kf/callback',
      callback_path: '/api/channels/wechat-kf/binding-kf/callback',
      callback_token: 'raw-callback-token',
      encoding_aes_key: 'raw-encoding-aes-key',
    }));

    expect(await screen.findByText('/api/channels/wechat-kf/binding-kf/callback')).toBeTruthy();
    expect(screen.getByText('raw-callback-token')).toBeTruthy();
    expect(screen.getByText('raw-encoding-aes-key')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Copy callback URL' }));
    expect(writeText).toHaveBeenCalledWith('/api/channels/wechat-kf/binding-kf/callback');

    const secretInput = screen.getByLabelText('Application Secret') as HTMLInputElement;
    await user.type(secretInput, 'NeverEchoThisSecret');
    await user.click(screen.getByRole('button', { name: 'Save credentials' }));

    await waitFor(() => expect(secretInput.value).toBe(''));
    expect(document.body.textContent).not.toContain('NeverEchoThisSecret');
    const credentialCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/credentials'));
    expect(JSON.parse(String(credentialCall?.[1]?.body))).toEqual({
      tenant_id: 'tenant_demo',
      corp_id: 'wwRawCorp123',
      secret: 'NeverEchoThisSecret',
      callback_token: 'raw-callback-token',
      encoding_aes_key: 'raw-encoding-aes-key',
    });
  });

  it('uses semantic callback and credential errors, clears the Secret, and hides provider detail', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/callback-config')) {
        return jsonResponse({ detail: 'raw callback provider diagnostic' }, 502);
      }
      if (url.endsWith('/credentials')) {
        return jsonResponse({ detail: 'raw credentials provider diagnostic' }, 502);
      }
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);
    renderSetup('en-US');

    await user.click(screen.getByRole('button', { name: 'Prepare callback' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Unable to prepare callback values.');
    expect(document.body.textContent).not.toContain('raw callback provider diagnostic');

    const secretInput = screen.getByLabelText('Application Secret') as HTMLInputElement;
    await user.type(secretInput, 'SecretClearedAfterFailure');
    await user.click(screen.getByRole('button', { name: 'Save credentials' }));

    await waitFor(() => expect(secretInput.value).toBe(''));
    expect(screen.getByRole('alert').textContent).toContain('Unable to save the credentials.');
    expect(document.body.textContent).not.toContain('SecretClearedAfterFailure');
    expect(document.body.textContent).not.toContain('raw credentials provider diagnostic');
  });

  it('loads manageable accounts and selects an existing provider account', async () => {
    const user = userEvent.setup();
    const available = providerAccount({
      open_kfid: 'wk-select-raw',
      name: 'Selectable Raw Name',
      bound: false,
      bound_binding_id: null,
    });
    const unavailable = providerAccount({
      open_kfid: 'wk-no-privilege',
      name: 'No Privilege Raw Name',
      manage_privilege: false,
      bound: false,
      bound_binding_id: null,
    });
    const selectedBinding = {
      ...ownerBinding,
      status: 'active',
      callback_ready: true,
      open_kfid: available.open_kfid,
      wechat_kf_accounts: [{
        open_kfid: available.open_kfid,
        name: available.name,
        status: 'active',
        sync_cursor: '',
      }],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/accounts?')) return jsonResponse({ accounts: [available, unavailable] });
      if (init?.method === 'POST' && url.endsWith('/account')) return jsonResponse(selectedBinding);
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);
    const { onChanged } = renderSetup('en-US', { ...ownerBinding, callback_ready: true, status: 'active' });

    expect(await screen.findByText('wk-select-raw')).toBeTruthy();
    expect(screen.getByText('wk-no-privilege')).toBeTruthy();
    expect(screen.getByText('No management permission')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Select account wk-select-raw' }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(selectedBinding));
    expect(screen.getByText('Selected')).toBeTruthy();
  });

  it('rejects invalid avatars locally, uploads a valid file, and creates an account', async () => {
    const user = userEvent.setup();
    const createdBinding = {
      ...ownerBinding,
      status: 'active',
      callback_ready: true,
      open_kfid: 'wk-created',
      wechat_kf_accounts: [{
        open_kfid: 'wk-created',
        name: 'Created Raw Name',
        status: 'active',
        sync_cursor: '',
      }],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/accounts?')) return jsonResponse({ accounts: [] });
      if (url.includes('/avatar?')) return jsonResponse({ media_id: 'media-avatar-raw' });
      if (init?.method === 'POST' && url.endsWith('/accounts')) return jsonResponse(createdBinding);
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);
    const { onChanged } = renderSetup('en-US', { ...ownerBinding, callback_ready: true, status: 'active' });
    await screen.findByText('No customer service accounts available.');

    const fileInput = screen.getByLabelText('Avatar image') as HTMLInputElement;
    fireEvent.change(fileInput, {
      target: { files: [new File(['plain'], 'avatar.txt', { type: 'text/plain' })] },
    });
    expect(screen.getByRole('alert').textContent).toContain('Use a JPG or PNG image.');
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/avatar?'))).toBe(false);

    fireEvent.change(fileInput, {
      target: {
        files: [new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'large.png', { type: 'image/png' })],
      },
    });
    expect(screen.getByRole('alert').textContent).toContain('Avatar images must be 2 MiB or smaller.');

    fireEvent.change(fileInput, {
      target: { files: [new File(['valid-avatar'], 'avatar.png', { type: 'image/png' })] },
    });
    await user.click(screen.getByRole('button', { name: 'Upload avatar' }));
    expect(await screen.findByText('Avatar uploaded.')).toBeTruthy();
    expect((screen.getByLabelText('Avatar image') as HTMLInputElement).files?.length).toBe(0);

    await user.type(screen.getByLabelText('Customer service account name'), 'Created Raw Name');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(createdBinding));
    const createCall = fetchMock.mock.calls.find(([input, init]) => (
      init?.method === 'POST' && String(input).endsWith('/accounts')
    ));
    expect(JSON.parse(String(createCall?.[1]?.body))).toEqual({
      tenant_id: 'tenant_demo',
      name: 'Created Raw Name',
      media_id: 'media-avatar-raw',
    });
  });

  it('updates an account and requires destructive confirmation before deleting it', async () => {
    const user = userEvent.setup();
    const account = providerAccount();
    const boundAccount = {
      open_kfid: account.open_kfid,
      name: account.name,
      status: 'active',
      sync_cursor: '',
    };
    const updatedBinding = {
      ...ownerBinding,
      status: 'active',
      callback_ready: true,
      open_kfid: account.open_kfid,
      wechat_kf_accounts: [{ ...boundAccount, name: 'Updated Raw Name' }],
    };
    const deletedBinding = {
      ...updatedBinding,
      open_kfid: null,
      wechat_kf_accounts: [],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/accounts?')) return jsonResponse({ accounts: [account] });
      if (url.includes('/avatar?')) return jsonResponse({ media_id: 'media-update-raw' });
      if (init?.method === 'PATCH' && url.endsWith('/account')) return jsonResponse(updatedBinding);
      if (init?.method === 'DELETE') return jsonResponse(deletedBinding);
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);
    const { onChanged } = renderSetup('en-US', {
      ...ownerBinding,
      status: 'active',
      callback_ready: true,
      open_kfid: account.open_kfid,
      wechat_kf_accounts: [boundAccount],
    });
    await screen.findByText(account.open_kfid);

    await user.click(screen.getByRole('button', { name: `Edit account ${account.open_kfid}` }));
    const nameInput = screen.getByLabelText('Customer service account name') as HTMLInputElement;
    await user.clear(nameInput);
    await user.type(nameInput, 'Updated Raw Name');
    await user.upload(
      screen.getByLabelText('Avatar image'),
      new File(['updated-avatar'], 'updated.png', { type: 'image/png' }),
    );
    await user.click(screen.getByRole('button', { name: 'Upload avatar' }));
    await user.click(screen.getByRole('button', { name: 'Update account' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(updatedBinding));

    await user.click(screen.getByRole('button', { name: `Delete account ${account.open_kfid}` }));
    expect(screen.getByRole('alertdialog').textContent).toContain('Delete customer service account?');
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Delete account' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(deletedBinding));
  });

  it('generates and copies a raw contact URL while keeping provider error text out of the UI', async () => {
    const user = userEvent.setup();
    const account = providerAccount();
    let listAttempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/accounts?')) {
        listAttempts += 1;
        return listAttempts === 1
          ? jsonResponse({ accounts: [account] })
          : jsonResponse({ detail: 'provider secret body must never render' }, 502);
      }
      if (url.includes('/contact-way?')) {
        return jsonResponse({ url: 'https://provider.example/raw/contact?code=abc123' });
      }
      return jsonResponse({});
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    vi.stubGlobal('fetch', fetchMock);
    renderSetup('en-US', {
      ...ownerBinding,
      status: 'active',
      callback_ready: true,
      open_kfid: account.open_kfid,
      wechat_kf_accounts: [{
        open_kfid: account.open_kfid,
        name: account.name,
        status: 'active',
        sync_cursor: '',
      }],
    });
    await screen.findByText(account.open_kfid);

    await user.click(screen.getByRole('button', { name: `Generate contact link for ${account.open_kfid}` }));
    const rawUrl = await screen.findByText('https://provider.example/raw/contact?code=abc123');
    expect(rawUrl.getAttribute('translate')).toBe('no');
    expect(screen.getByRole('img', { name: 'QR code for customer service contact link' }).getAttribute('src'))
      .toContain('data:image/png;base64,');
    await user.click(screen.getByRole('button', { name: 'Copy contact link' }));
    expect(writeText).toHaveBeenCalledWith('https://provider.example/raw/contact?code=abc123');

    await user.click(screen.getByRole('button', { name: 'Refresh accounts' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Unable to load customer service accounts.');
    expect(document.body.textContent).not.toContain('provider secret body must never render');
  });
});
