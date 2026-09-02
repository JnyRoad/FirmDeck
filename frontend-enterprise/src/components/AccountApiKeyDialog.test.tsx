// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppIntlProvider, type AppLocale } from '@/i18n';

import AccountApiKeyDialog from './AccountApiKeyDialog';

const ACCOUNT_CREDENTIAL_CREATED_AT = '2026-08-29T12:34:00Z';
const semanticAccountCopy = {
  'zh-CN': {
    copyFull: '复制完整密钥',
    created: '创建于',
    empty: '您还没有创建账号 API 密钥',
    heading: '账号 API 密钥 · Raw Account 名称',
    permission: '以当前账号身份访问和管理数字员工',
    refresh: '刷新',
  },
  'en-US': {
    copyFull: 'Copy full key',
    created: 'Created',
    empty: 'You have not created an account API key yet.',
    heading: 'Account API keys · Raw Account 名称',
    permission: 'Access and manage digital employees as the current account',
    refresh: 'Refresh',
  },
} as const;

/** 构造客户端请求所需的成功 JSON 响应。 */
function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify(body),
  } as Response;
}

/** 模拟账户密钥生命周期接口，并可从空列表或现有密钥状态开始。 */
function stubAccountCredentialFetch(canReveal = true, hasCredential = true) {
  let status = 'active';
  let exists = hasCredential;
  const credential = () => ({
    id: 'account-key-1',
    user_id: 'user-1',
    name: '账户密钥',
    access: 'user_full_access',
    key_prefix: 'sd_live_test…',
    can_reveal: canReveal,
    scopes: ['runs:*'],
    status,
    created_at: ACCOUNT_CREDENTIAL_CREATED_AT,
  });
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST' && url.endsWith('/api/auth/me/api-credentials/account-key-1/revoke')) {
      status = 'revoked';
      return jsonResponse(credential());
    }
    if (init?.method === 'POST' && url.endsWith('/api/auth/me/api-credentials/account-key-1/reveal')) {
      return jsonResponse({ api_key: 'sd_live_full_account_key' });
    }
    if (init?.method === 'DELETE' && url.endsWith('/api/auth/me/api-credentials/account-key-1')) {
      exists = false;
      return jsonResponse({});
    }
    if (url.endsWith('/api/auth/me/api-credentials')) return jsonResponse(exists ? [credential()] : []);
    return jsonResponse({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** 仅用语义 Provider 渲染账户密钥对话框，并保留账号显示名作为 raw fixture。 */
function renderSemanticAccountDialog(locale: AppLocale): void {
  render(
    <AppIntlProvider locale={locale}>
      <AccountApiKeyDialog
        account={{
          id: 'user-1',
          username: 'admin',
          display_name: 'Raw Account 名称',
          role: 'admin',
        }}
        open
        onClose={vi.fn()}
      />
    </AppIntlProvider>,
  );
}

/** 用与产品相同的明确日期字段生成 locale 期望值，不依赖机器默认语言。 */
function expectedCredentialDate(locale: AppLocale): string {
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ACCOUNT_CREDENTIAL_CREATED_AT));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('AccountApiKeyDialog', () => {
  it('uses an in-application confirmation before revoking an account credential', async () => {
    const user = userEvent.setup();
    const fetchMock = stubAccountCredentialFetch();

    renderSemanticAccountDialog('zh-CN');

    await screen.findByText('账户密钥');
    await user.click(screen.getByRole('button', { name: '禁用' }));
    expect(await screen.findByText('确认禁用 API 密钥')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: '确认禁用' }));

    await waitFor(() => expect(screen.getByText('已禁用')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/me/api-credentials/account-key-1/revoke',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('cancels or permanently deletes an account credential only after confirmation', async () => {
    const user = userEvent.setup();
    const fetchMock = stubAccountCredentialFetch();

    renderSemanticAccountDialog('zh-CN');

    await screen.findByText('账户密钥');
    await user.click(screen.getByRole('button', { name: '删除' }));
    expect(await screen.findByText('确认删除 API 密钥')).toBeTruthy();
    expect(screen.getByText(/删除后无法恢复/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText('账户密钥')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '删除' }));
    await user.click(screen.getByRole('button', { name: '永久删除' }));

    await waitFor(() => expect(screen.queryByText('账户密钥')).toBeNull());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/me/api-credentials/account-key-1',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('copies the complete account key through the scoped read operation', async () => {
    const user = userEvent.setup();
    const fetchMock = stubAccountCredentialFetch();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    renderSemanticAccountDialog('zh-CN');

    await screen.findByText('账户密钥');
    await user.click(screen.getByRole('button', { name: '复制完整密钥' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('sd_live_full_account_key'));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/me/api-credentials/account-key-1/reveal',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('guides account owners to rotate legacy keys that cannot be recovered', async () => {
    stubAccountCredentialFetch(false);

    renderSemanticAccountDialog('zh-CN');

    await screen.findByText('账户密钥');
    expect(screen.getByText('旧密钥需轮换后复制')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '复制完整密钥' })).toBeNull();
  });
});

describe('semantic account API key locale contract', () => {
  for (const locale of ['zh-CN', 'en-US'] as const) {
    const copy = semanticAccountCopy[locale];

    it(`localizes account permissions and empty state without translating the account name in ${locale}`, async () => {
      stubAccountCredentialFetch(true, false);
      renderSemanticAccountDialog(locale);

      expect(await screen.findByText(copy.heading)).toBeTruthy();
      expect(screen.getByText(copy.permission)).toBeTruthy();
      expect(await screen.findByText(copy.empty)).toBeTruthy();
    });

    it(`formats credential dates by ${locale} while preserving raw key metadata`, async () => {
      stubAccountCredentialFetch();
      renderSemanticAccountDialog(locale);

      expect(await screen.findByText('账户密钥')).toBeTruthy();
      expect(screen.getByText('sd_live_test…')).toBeTruthy();
      expect(screen.getByText(`${copy.created} ${expectedCredentialDate(locale)}`)).toBeTruthy();
    });
  }

  it('localizes the account credential loading state in en-US', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    renderSemanticAccountDialog('en-US');

    expect((screen.getByRole('button', {
      name: semanticAccountCopy['en-US'].refresh,
    }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('copies the raw full account key unchanged from an en-US semantic subtree', async () => {
    const user = userEvent.setup();
    stubAccountCredentialFetch();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    renderSemanticAccountDialog('en-US');

    await user.click(await screen.findByRole('button', { name: semanticAccountCopy['en-US'].copyFull }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('sd_live_full_account_key'));
  });
});
