// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppIntlProvider, type AppLocale } from '@/i18n';
import type { AgentProfileRead } from '@/types';

import EmployeeApiKeyDialog from './EmployeeApiKeyDialog';

const EMPLOYEE_CREDENTIAL_CREATED_AT = '2026-08-29T12:34:00Z';
const semanticEmployeeCopy = {
  'zh-CN': {
    created: '创建于',
    empty: '还没有为这个员工创建 API 密钥',
    heading: 'API 密钥 · 小艾',
    permission: '用于外部系统发起对话和任务',
  },
  'en-US': {
    created: 'Created',
    empty: 'No API key has been created for this employee yet.',
    heading: 'API keys · 小艾',
    permission: 'Used by external systems to start conversations and tasks',
  },
} as const;

const agent: AgentProfileRead = {
  id: 'agent-1',
  tenant_id: 'tenant_demo',
  name: '小艾',
  is_overall: false,
  status: 'active',
  metadata: {},
  resources: [],
  created_at: '2026-08-29T00:00:00Z',
  updated_at: '2026-08-29T00:00:00Z',
};

/** 构造客户端请求所需的成功 JSON 响应。 */
function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify(body),
  } as Response;
}

/** 模拟员工密钥生命周期接口，并可从空列表或现有密钥状态开始。 */
function stubEmployeeCredentialFetch(canReveal = true, hasCredential = true) {
  let status = 'active';
  let exists = hasCredential;
  const credential = () => ({
    id: 'employee-key-1',
    agent_id: agent.id,
    name: '员工运行密钥',
    access: 'runtime',
    key_prefix: 'sd_live_test…',
    can_reveal: canReveal,
    scopes: ['runs:*'],
    status,
    created_at: EMPLOYEE_CREDENTIAL_CREATED_AT,
  });
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (
      init?.method === 'POST'
      && url.endsWith('/api/enterprise/agents/agent-1/api-credentials/employee-key-1/revoke?tenant_id=tenant_demo')
    ) {
      status = 'revoked';
      return jsonResponse(credential());
    }
    if (
      init?.method === 'POST'
      && url.endsWith('/api/enterprise/agents/agent-1/api-credentials/employee-key-1/reveal?tenant_id=tenant_demo')
    ) {
      return jsonResponse({ api_key: 'sd_live_full_employee_key' });
    }
    if (
      init?.method === 'DELETE'
      && url.endsWith('/api/enterprise/agents/agent-1/api-credentials/employee-key-1?tenant_id=tenant_demo')
    ) {
      exists = false;
      return jsonResponse({});
    }
    if (url.endsWith('/api/enterprise/agents/agent-1/api-credentials?tenant_id=tenant_demo')) {
      return jsonResponse(exists ? [credential()] : []);
    }
    return jsonResponse({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** 仅用语义 Provider 渲染员工密钥对话框，确保员工名与凭据名作为 raw 值保留。 */
function renderSemanticEmployeeDialog(locale: AppLocale): void {
  render(
    <AppIntlProvider locale={locale}>
      <EmployeeApiKeyDialog agent={agent} open onClose={vi.fn()} />
    </AppIntlProvider>,
  );
}

/** 用明确 locale 格式化员工凭据时间，避免测试继承机器默认语言。 */
function expectedEmployeeCredentialDate(locale: AppLocale): string {
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(EMPLOYEE_CREDENTIAL_CREATED_AT));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('EmployeeApiKeyDialog', () => {
  it('uses an in-application confirmation before revoking an employee credential', async () => {
    const user = userEvent.setup();
    const fetchMock = stubEmployeeCredentialFetch();

    renderSemanticEmployeeDialog('zh-CN');

    await screen.findByText('员工运行密钥');
    await user.click(screen.getByRole('button', { name: '禁用' }));
    expect(await screen.findByText('确认禁用 API 密钥')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: '确认禁用' }));

    await waitFor(() => expect(screen.getByText('已禁用')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/enterprise/agents/agent-1/api-credentials/employee-key-1/revoke?tenant_id=tenant_demo',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('cancels or permanently deletes an employee credential only after confirmation', async () => {
    const user = userEvent.setup();
    const fetchMock = stubEmployeeCredentialFetch();

    renderSemanticEmployeeDialog('zh-CN');

    await screen.findByText('员工运行密钥');
    await user.click(screen.getByRole('button', { name: '删除' }));
    expect(await screen.findByText('确认删除 API 密钥')).toBeTruthy();
    expect(screen.getByText(/删除后无法恢复/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText('员工运行密钥')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '删除' }));
    await user.click(screen.getByRole('button', { name: '永久删除' }));

    await waitFor(() => expect(screen.queryByText('员工运行密钥')).toBeNull());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/enterprise/agents/agent-1/api-credentials/employee-key-1?tenant_id=tenant_demo',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('copies the complete employee key through the scoped read operation', async () => {
    const user = userEvent.setup();
    const fetchMock = stubEmployeeCredentialFetch();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    renderSemanticEmployeeDialog('zh-CN');

    await screen.findByText('员工运行密钥');
    await user.click(screen.getByRole('button', { name: '复制完整密钥' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('sd_live_full_employee_key'));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/enterprise/agents/agent-1/api-credentials/employee-key-1/reveal?tenant_id=tenant_demo',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('guides employee managers to rotate legacy keys that cannot be recovered', async () => {
    stubEmployeeCredentialFetch(false);

    renderSemanticEmployeeDialog('zh-CN');

    await screen.findByText('员工运行密钥');
    expect(screen.getByText('旧密钥需轮换后复制')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '复制完整密钥' })).toBeNull();
  });
});

describe('semantic employee API key locale contract', () => {
  for (const locale of ['zh-CN', 'en-US'] as const) {
    const copy = semanticEmployeeCopy[locale];

    it(`localizes employee permissions and empty state without translating the employee name in ${locale}`, async () => {
      stubEmployeeCredentialFetch(true, false);
      renderSemanticEmployeeDialog(locale);

      expect(await screen.findByText(copy.heading)).toBeTruthy();
      expect(screen.getByText(copy.permission)).toBeTruthy();
      expect(await screen.findByText(copy.empty)).toBeTruthy();
    });

    it(`formats employee credential dates by ${locale} while preserving raw key metadata`, async () => {
      stubEmployeeCredentialFetch();
      renderSemanticEmployeeDialog(locale);

      expect(await screen.findByText('员工运行密钥')).toBeTruthy();
      expect(screen.getByText('sd_live_test…')).toBeTruthy();
      expect(screen.getByText(`${copy.created} ${expectedEmployeeCredentialDate(locale)}`)).toBeTruthy();
    });
  }
});
