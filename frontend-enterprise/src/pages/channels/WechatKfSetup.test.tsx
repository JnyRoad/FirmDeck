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

  it('clears stale callback values when the Corp ID changes and a later prepare fails', async () => {
    const user = userEvent.setup();
    let prepareAttempt = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (!String(input).endsWith('/callback-config')) return jsonResponse({});
      prepareAttempt += 1;
      return prepareAttempt === 1
        ? jsonResponse({
          callback_url: '/api/channels/wechat-kf/binding-kf/callback',
          callback_path: '/api/channels/wechat-kf/binding-kf/callback',
          callback_token: 'corp-a-token-must-disappear',
          encoding_aes_key: 'corp-a-aes-must-disappear',
        })
        : jsonResponse({ detail: 'provider failure detail' }, 502);
    });
    vi.stubGlobal('fetch', fetchMock);
    renderSetup('en-US', { ...ownerBinding, corp_id: null });

    const corpInput = screen.getByLabelText('Corp ID') as HTMLInputElement;
    await user.type(corpInput, 'wwCorpA');
    await user.click(screen.getByRole('button', { name: 'Prepare callback' }));
    expect(await screen.findByText('corp-a-token-must-disappear')).toBeTruthy();

    await user.clear(corpInput);
    await user.type(corpInput, 'wwCorpB');
    expect(screen.queryByText('corp-a-token-must-disappear')).toBeNull();
    expect(screen.queryByText('corp-a-aes-must-disappear')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Prepare callback' }));

    expect((await screen.findByRole('alert')).textContent).toContain('Unable to prepare callback values.');
    expect(screen.queryByText('corp-a-token-must-disappear')).toBeNull();
    expect(screen.queryByText('corp-a-aes-must-disappear')).toBeNull();
  });

  it('clears the Secret before client validation and disables credential fields while saving', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const view = renderSetup('en-US', { ...ownerBinding, corp_id: null });

    const missingCorpSecret = screen.getByLabelText('Application Secret') as HTMLInputElement;
    await user.type(missingCorpSecret, 'ClearBeforeValidation');
    await user.click(screen.getByRole('button', { name: 'Save credentials' }));
    expect(missingCorpSecret.value).toBe('');
    expect(fetchMock).not.toHaveBeenCalled();

    view.unmount();
    let rejectSave: ((error: Error) => void) | undefined;
    const pendingSave = new Promise<Response>((_resolve, reject) => {
      rejectSave = reject;
    });
    const pendingFetch = vi.fn(async (input: RequestInfo | URL) => (
      String(input).endsWith('/credentials') ? pendingSave : jsonResponse({})
    ));
    vi.stubGlobal('fetch', pendingFetch);
    renderSetup('en-US');

    const corpInput = screen.getByLabelText('Corp ID') as HTMLInputElement;
    const secretInput = screen.getByLabelText('Application Secret') as HTMLInputElement;
    await user.type(secretInput, 'SnapshotThenClear');
    await user.click(screen.getByRole('button', { name: 'Save credentials' }));
    expect(secretInput.value).toBe('');
    expect(secretInput.disabled).toBe(true);
    expect(corpInput.disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Saving credentials…' }).hasAttribute('disabled')).toBe(true);

    rejectSave?.(new Error('network failure SnapshotThenClear must not render'));
    expect((await screen.findByRole('alert')).textContent).toContain('Unable to save the credentials.');
    expect(document.body.textContent).not.toContain('SnapshotThenClear');
    expect(document.body.textContent).not.toContain('network failure');
  });

  it('updates only the account name without sending a media ID', async () => {
    const user = userEvent.setup();
    const account = providerAccount();
    const updatedAccount = { ...account, name: 'Name Only Update' };
    const updatedBinding = {
      ...ownerBinding,
      status: 'active',
      callback_ready: true,
      wechat_kf_accounts: [{
        open_kfid: account.open_kfid,
        name: updatedAccount.name,
        status: 'active',
        sync_cursor: '',
      }],
    };
    let listAttempt = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/accounts?')) {
        listAttempt += 1;
        return jsonResponse({ accounts: [listAttempt === 1 ? account : updatedAccount] });
      }
      if (init?.method === 'PATCH' && url.endsWith('/account')) return jsonResponse(updatedBinding);
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);
    renderSetup('en-US', { ...ownerBinding, status: 'active', callback_ready: true });
    await screen.findByText(account.open_kfid);

    await user.click(screen.getByRole('button', { name: `Edit account ${account.open_kfid}` }));
    const nameInput = screen.getByLabelText('Customer service account name');
    await user.clear(nameInput);
    await user.type(nameInput, updatedAccount.name);
    await user.click(screen.getByRole('button', { name: 'Update account' }));

    await screen.findByText(updatedAccount.name);
    const updateCall = fetchMock.mock.calls.find(([input, init]) => (
      init?.method === 'PATCH' && String(input).endsWith('/account')
    ));
    expect(JSON.parse(String(updateCall?.[1]?.body))).toEqual({
      tenant_id: 'tenant_demo',
      open_kfid: account.open_kfid,
      name: updatedAccount.name,
    });
    expect(listAttempt).toBe(2);
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
    let listAttempt = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/accounts?')) {
        listAttempt += 1;
        return jsonResponse({
          accounts: [
            listAttempt === 1
              ? available
              : { ...available, bound: true, bound_binding_id: ownerBinding.id },
            unavailable,
          ],
        });
      }
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
    expect(await screen.findByText('Bound to this integration')).toBeTruthy();
    expect(screen.queryByText('Selected')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Select account wk-select-raw' })).toBeNull();
    expect(listAttempt).toBe(2);
  });

  it('shows accounts bound elsewhere without offering Select or current-binding actions', async () => {
    const elsewhere = providerAccount({
      open_kfid: 'wk-bound-elsewhere',
      name: 'Bound Elsewhere Raw Name',
      bound: true,
      bound_binding_id: 'another-binding',
    });
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ accounts: [elsewhere] })));
    renderSetup('en-US', { ...ownerBinding, callback_ready: true, status: 'active' });

    expect(await screen.findByText(elsewhere.open_kfid)).toBeTruthy();
    expect(screen.getByText('Bound to another integration')).toBeTruthy();
    expect(screen.queryByRole('button', { name: `Select account ${elsewhere.open_kfid}` })).toBeNull();
    expect(screen.queryByRole('button', { name: `Edit account ${elsewhere.open_kfid}` })).toBeNull();
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
    const createdAccount = providerAccount({
      open_kfid: 'wk-created',
      name: 'Created Raw Name',
      avatar: 'https://provider.example/avatar/created.png',
    });
    let listAttempt = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/accounts?')) {
        listAttempt += 1;
        return jsonResponse({ accounts: listAttempt === 1 ? [] : [createdAccount] });
      }
      if (url.includes('/avatar?')) return jsonResponse({ media_id: 'media-avatar-raw' });
      if (init?.method === 'POST' && url.endsWith('/accounts')) return jsonResponse(createdBinding);
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);
    const { onChanged } = renderSetup('en-US', { ...ownerBinding, callback_ready: true, status: 'active' });
    await screen.findByText('No customer service accounts available.');

    let fileInput = screen.getByLabelText('Avatar image') as HTMLInputElement;
    fireEvent.change(fileInput, {
      target: { files: [new File(['plain'], 'avatar.txt', { type: 'text/plain' })] },
    });
    expect(screen.getByRole('alert').textContent).toContain('Use a JPG or PNG image.');
    fileInput = screen.getByLabelText('Avatar image') as HTMLInputElement;
    expect(fileInput.files?.length).toBe(0);
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/avatar?'))).toBe(false);

    fileInput = screen.getByLabelText('Avatar image') as HTMLInputElement;
    fireEvent.change(fileInput, {
      target: {
        files: [new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'large.png', { type: 'image/png' })],
      },
    });
    expect(screen.getByRole('alert').textContent).toContain('Avatar images must be 2 MiB or smaller.');
    fileInput = screen.getByLabelText('Avatar image') as HTMLInputElement;
    expect(fileInput.files?.length).toBe(0);

    fileInput = screen.getByLabelText('Avatar image') as HTMLInputElement;
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
    expect(await screen.findByText(createdAccount.open_kfid)).toBeTruthy();
    expect(listAttempt).toBe(2);
  });

  it('refreshes avatar/name updates and confirms the exact multi-account delete target', async () => {
    const user = userEvent.setup();
    const account = providerAccount();
    const otherAccount = providerAccount({
      open_kfid: 'wk-delete-second',
      name: 'Second Delete Target',
      avatar: 'https://provider.example/avatar/second.png',
    });
    const updatedAccount = {
      ...account,
      name: 'Updated Raw Name',
      avatar: 'https://provider.example/avatar/refreshed.png',
    };
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
      wechat_kf_accounts: [
        { ...boundAccount, name: 'Updated Raw Name' },
        {
          open_kfid: otherAccount.open_kfid,
          name: otherAccount.name,
          status: 'active',
          sync_cursor: '',
        },
      ],
    };
    const deletedBinding = {
      ...updatedBinding,
      wechat_kf_accounts: [{ ...boundAccount, name: 'Updated Raw Name' }],
    };
    let listAttempt = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/accounts?')) {
        listAttempt += 1;
        if (listAttempt === 1) return jsonResponse({ accounts: [account, otherAccount] });
        if (listAttempt === 2) return jsonResponse({ accounts: [updatedAccount, otherAccount] });
        return jsonResponse({ accounts: [updatedAccount] });
      }
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
      wechat_kf_accounts: [
        boundAccount,
        {
          open_kfid: otherAccount.open_kfid,
          name: otherAccount.name,
          status: 'active',
          sync_cursor: '',
        },
      ],
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
    expect(await screen.findByText('Updated Raw Name')).toBeTruthy();
    expect(screen.getAllByRole('img', { name: 'Customer service account avatar' })
      .some((image) => image.getAttribute('src') === updatedAccount.avatar)).toBe(true);

    await user.click(screen.getByRole('button', { name: `Delete account ${otherAccount.open_kfid}` }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('Delete customer service account?');
    expect(dialog.textContent).toContain(otherAccount.name);
    expect(dialog.textContent).toContain(otherAccount.open_kfid);
    expect(dialog.textContent).not.toContain(account.open_kfid);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Delete account' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(deletedBinding));
    await waitFor(() => expect(screen.queryByText(otherAccount.open_kfid)).toBeNull());
    expect(screen.getByText(account.open_kfid)).toBeTruthy();
    expect(listAttempt).toBe(3);
  });

  it('keeps a successful account mutation and reports when the required refresh fails', async () => {
    const user = userEvent.setup();
    const account = providerAccount({ bound: false, bound_binding_id: null });
    const selectedBinding = {
      ...ownerBinding,
      callback_ready: true,
      wechat_kf_accounts: [{
        open_kfid: account.open_kfid,
        name: account.name,
        status: 'active',
        sync_cursor: '',
      }],
    };
    let listAttempt = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/accounts?')) {
        listAttempt += 1;
        return listAttempt === 1
          ? jsonResponse({ accounts: [account] })
          : jsonResponse({ detail: 'provider refresh detail' }, 502);
      }
      if (init?.method === 'POST' && url.endsWith('/account')) return jsonResponse(selectedBinding);
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);
    const { onChanged } = renderSetup('en-US', { ...ownerBinding, callback_ready: true });
    await screen.findByText(account.open_kfid);

    await user.click(screen.getByRole('button', { name: `Select account ${account.open_kfid}` }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(selectedBinding));
    expect((await screen.findByRole('alert')).textContent)
      .toContain('The account change was saved, but the provider list could not be refreshed.');
    expect(document.body.textContent).not.toContain('provider refresh detail');
  });

  it('ignores an older account-list response after the binding changes', async () => {
    const staleAccount = providerAccount({ open_kfid: 'wk-stale-response', bound_binding_id: 'binding-old' });
    const currentAccount = providerAccount({ open_kfid: 'wk-current-response', bound_binding_id: 'binding-new' });
    let releaseStale: ((response: Response) => void) | undefined;
    const staleResponse = new Promise<Response>((resolve) => {
      releaseStale = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => (
      String(input).includes('/binding-old/')
        ? staleResponse
        : jsonResponse({ accounts: [currentAccount] })
    ));
    vi.stubGlobal('fetch', fetchMock);
    const onChanged = vi.fn();
    const view = renderSetup('en-US', {
      ...ownerBinding,
      id: 'binding-old',
      callback_ready: true,
    }, onChanged);

    view.rerender(
      <AppIntlProvider initialLocale="en-US">
        <WechatKfSetup
          binding={{ ...ownerBinding, id: 'binding-new', callback_ready: true }}
          onChanged={onChanged}
        />
      </AppIntlProvider>,
    );
    expect(await screen.findByText(currentAccount.open_kfid)).toBeTruthy();
    releaseStale?.(jsonResponse({ accounts: [staleAccount] }));

    await waitFor(() => expect(screen.queryByText(staleAccount.open_kfid)).toBeNull());
    expect(screen.getByText(currentAccount.open_kfid)).toBeTruthy();
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
        return jsonResponse({ url: 'https://work.weixin.qq.com/kf/demo?code=abc123' });
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
    const rawUrl = await screen.findByText('https://work.weixin.qq.com/kf/demo?code=abc123');
    expect(rawUrl.getAttribute('translate')).toBe('no');
    const rawLink = screen.getByRole('link', { name: 'https://work.weixin.qq.com/kf/demo?code=abc123' });
    expect(rawLink.getAttribute('href')).toBe('https://work.weixin.qq.com/kf/demo?code=abc123');
    expect(rawLink.getAttribute('target')).toBe('_blank');
    expect(rawLink.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.getByRole('img', { name: 'QR code for customer service contact link' }).getAttribute('src'))
      .toContain('data:image/png;base64,');
    await user.click(screen.getByRole('button', { name: 'Copy contact link' }));
    expect(writeText).toHaveBeenCalledWith('https://work.weixin.qq.com/kf/demo?code=abc123');

    await user.click(screen.getByRole('button', { name: 'Refresh accounts' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Unable to load customer service accounts.');
    expect(document.body.textContent).not.toContain('provider secret body must never render');
  });

  it('shows contact generation progress only on the account being processed', async () => {
    const user = userEvent.setup();
    const first = providerAccount({ open_kfid: 'wk-contact-first' });
    const second = providerAccount({ open_kfid: 'wk-contact-second' });
    let releaseContact: ((response: Response) => void) | undefined;
    const contactResponse = new Promise<Response>((resolve) => {
      releaseContact = resolve;
    });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/accounts?')) return jsonResponse({ accounts: [first, second] });
      if (url.includes('/contact-way?')) return contactResponse;
      return jsonResponse({});
    }));
    renderSetup('en-US', {
      ...ownerBinding,
      status: 'active',
      callback_ready: true,
      wechat_kf_accounts: [first, second].map((account) => ({
        open_kfid: account.open_kfid,
        name: account.name,
        status: 'active',
        sync_cursor: '',
      })),
    });
    await screen.findByText(first.open_kfid);

    const firstButton = screen.getByRole('button', { name: `Generate contact link for ${first.open_kfid}` });
    const secondButton = screen.getByRole('button', { name: `Generate contact link for ${second.open_kfid}` });
    await user.click(firstButton);

    expect(firstButton.textContent).toBe('Generating contact link…');
    expect(secondButton.textContent).toBe('Generate contact link');
    releaseContact?.(jsonResponse({ url: 'https://work.weixin.qq.com/kf/contact-first' }));
    await screen.findByText('https://work.weixin.qq.com/kf/contact-first');
  });

  it.each([
    'javascript:alert(1)',
    'http://work.weixin.qq.com/kf/demo',
    'https://user:password@work.weixin.qq.com/kf/demo',
    'https://provider.example/kf/demo',
    'not a url',
  ])('rejects an unsafe provider contact URL without QR, copy, or link output: %s', async (unsafeUrl) => {
    const user = userEvent.setup();
    const account = providerAccount();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => (
      String(input).includes('/accounts?')
        ? jsonResponse({ accounts: [account] })
        : jsonResponse({ url: unsafeUrl })
    ));
    vi.stubGlobal('fetch', fetchMock);
    renderSetup('en-US', {
      ...ownerBinding,
      status: 'active',
      callback_ready: true,
      wechat_kf_accounts: [{
        open_kfid: account.open_kfid,
        name: account.name,
        status: 'active',
        sync_cursor: '',
      }],
    });
    await screen.findByText(account.open_kfid);

    await user.click(screen.getByRole('button', { name: `Generate contact link for ${account.open_kfid}` }));

    expect((await screen.findByRole('alert')).textContent).toContain('The provider returned an unsafe contact link.');
    expect(screen.queryByRole('img', { name: 'QR code for customer service contact link' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy contact link' })).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
    expect(document.body.textContent).not.toContain(unsafeUrl);
  });
});
