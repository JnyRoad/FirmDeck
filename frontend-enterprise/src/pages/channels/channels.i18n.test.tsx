// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';

import { AppIntlProvider, type AppLocale } from '@/i18n';
import type { ChannelBindingRead } from '@/types';

import ChannelsPage from '../ChannelsPage';
import BindingManagers from './BindingManagers';
import FeishuSetup from './FeishuSetup';
import WechatSetup from './WechatSetup';

vi.mock('../../contexts/TenantSessionContext', () => {
  const context = {
    tenantId: 'tenant_demo',
    tenantSlug: 'tenant-demo',
    userId: 'user-1',
    generation: 1,
    signal: new AbortController().signal,
    session: { token: 'test-token' },
    isCurrentGeneration: () => true,
  };
  return { useTenantSession: () => context };
});

const pageCopy = {
  'zh-CN': {
    title: '渠道接入',
    create: '接入渠道',
    empty: '暂无渠道接入，接入后用户可通过斜杠指令在多个数字员工之间切换。',
  },
  'en-US': {
    title: 'Channel integrations',
    create: 'Connect channel',
    empty: 'No channel integrations yet. Users can switch between digital employees with slash commands after connecting a channel.',
  },
} as const satisfies Record<AppLocale, Record<string, string>>;

const managersCopy = {
  'zh-CN': {
    title: '渠道协作管理',
    empty: '暂无协作者',
  },
  'en-US': {
    title: 'Channel collaborators',
    empty: 'No collaborators',
  },
} as const satisfies Record<AppLocale, Record<string, string>>;

const baseBinding: ChannelBindingRead = {
  id: 'binding-raw',
  tenant_id: 'tenant_demo',
  agent_id: '',
  channel: 'feishu',
  status: 'active',
  connected: true,
  app_id: 'raw-app-id',
  bot_name: 'raw-bot-name',
  provider_tenant_key: 'raw-provider-tenant',
  agents: [],
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
};

/** 为渠道页面提供成功的空 API 响应，测试只观察产品 chrome，不伪造 provider 原始内容。 */
function stubEmptyChannelApi(): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => '[]',
  }) as Response));
}

/** 在独立语义 Provider 下渲染渠道主页面，禁止 legacy observer 参与 locale 选择。 */
function renderChannelPage(locale: AppLocale): void {
  render(
    <AppIntlProvider initialLocale={locale}>
      <MemoryRouter>
        <ChannelsPage />
      </MemoryRouter>
    </AppIntlProvider>,
  );
}

/** 在指定 locale 下挂载渠道子组件，复用真实组件树验证 setup/manager chrome。 */
function renderChannelChild(locale: AppLocale, child: ReactNode): void {
  render(<AppIntlProvider initialLocale={locale}>{child}</AppIntlProvider>);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('channels semantic locale matrix', () => {
  it.each(['zh-CN', 'en-US'] as const)(
    'localizes page title, empty state, and create action in %s',
    async (locale) => {
      stubEmptyChannelApi();
      renderChannelPage(locale);

      const copy = pageCopy[locale];
      expect(await screen.findByText(copy.title)).toBeTruthy();
      expect(screen.getAllByRole('button', { name: copy.create }).length).toBeGreaterThan(0);
      expect(screen.getByText(copy.empty)).toBeTruthy();
    },
  );

  it.each(['zh-CN', 'en-US'] as const)(
    'localizes collaborator chrome while preserving raw manager values in %s',
    async (locale) => {
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify([{
          user_id: 'raw-user-id',
          name: 'Raw Manager Name',
          granted_at: '2026-08-01T00:00:00Z',
          granted_by_user_id: 'raw-granter-id',
          granted_by_name: 'Raw Granter Name',
        }]),
      }) as Response));

      renderChannelChild(
        locale,
        <BindingManagers
          bindingId="binding-raw"
          users={[]}
        />,
      );

      const copy = managersCopy[locale];
      expect(await screen.findByText(copy.title)).toBeTruthy();
      expect(await screen.findByText('Raw Manager Name')).toBeTruthy();
      expect(screen.getByText(/Raw Granter Name/)).toBeTruthy();
      expect(screen.getByRole('button', { name: locale === 'zh-CN' ? '移除' : 'Remove' })).toBeTruthy();
    },
  );

  it.each(['zh-CN', 'en-US'] as const)(
    'keeps provider IDs and bot names unchanged in %s',
    (locale) => {
      renderChannelChild(locale, <FeishuSetup binding={baseBinding} onChanged={vi.fn()} />);

      expect(screen.getByText(/raw-app-id/)).toBeTruthy();
      expect(screen.getByText(/raw-bot-name/)).toBeTruthy();
      expect(screen.getByText(/raw-provider-tenant/)).toBeTruthy();
    },
  );

  it.each(['zh-CN', 'en-US'] as const)(
    'localizes QR setup state and accessible image text in %s',
    (locale) => {
      renderChannelChild(
        locale,
        <WechatSetup binding={{ ...baseBinding, channel: 'wechat', status: 'pending' }} onChanged={vi.fn()} />,
      );

      expect(screen.getByRole('button', {
        name: locale === 'zh-CN' ? '扫码接入' : 'Connect by QR code',
      })).toBeTruthy();
    },
  );
});
