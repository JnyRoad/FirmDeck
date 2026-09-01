// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '@/i18n';
import type { ChannelBindingRead } from '@/types';

import WechatSetup from './WechatSetup';

const wechatTestState = vi.hoisted(() => ({
  post: vi.fn(),
  get: vi.fn(),
}));

vi.mock('../../contexts/TenantSessionContext', () => ({
  useTenantSession: () => ({
    tenantId: 'tenant_demo',
    tenantSlug: 'tenant-demo',
    userId: 'user-1',
    generation: 1,
    signal: new AbortController().signal,
    session: { token: 'test-token' },
    isCurrentGeneration: () => true,
  }),
}));

vi.mock('../../api/tenant-client', () => ({
  createTenantClient: () => ({
    post: wechatTestState.post,
    get: wechatTestState.get,
  }),
}));

/** Create a pending WeChat binding that exposes the QR action. */
function binding(id: string): ChannelBindingRead {
  return {
    id,
    tenant_id: 'tenant_demo',
    agent_id: 'agent-1',
    channel: 'wechat',
    name: `微信 ${id}`,
    status: 'pending',
    connected: false,
    agents: [],
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
  };
}

afterEach(() => {
  cleanup();
  wechatTestState.post.mockReset();
  wechatTestState.get.mockReset();
});

describe('WechatSetup QR lifecycle', () => {
  it('clears the busy state synchronously when a binding change resets an in-flight QR request', async () => {
    const user = userEvent.setup();
    wechatTestState.post.mockReturnValue(new Promise(() => {}));
    const props = { binding: binding('binding-1'), onChanged: vi.fn() };
    const page = render(<I18nProvider><WechatSetup {...props} /></I18nProvider>);

    await user.click(screen.getByRole('button', { name: '扫码接入' }));
    expect((screen.getByRole('button', { name: '二维码加载中…' }) as HTMLButtonElement).disabled).toBe(true);

    page.rerender(<I18nProvider><WechatSetup {...props} binding={binding('binding-2')} /></I18nProvider>);

    expect((screen.getByRole('button', { name: '扫码接入' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole('button', { name: '二维码加载中…' })).toBeNull();
  });
});
