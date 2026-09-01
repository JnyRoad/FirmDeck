// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EnterpriseAuthUser } from '@/auth';
import type { TenantSessionContextValue } from '@/contexts/TenantSessionContext';
import { I18nProvider } from '@/i18n';
import type { ChannelBindingRead, ChannelConversationMessageRead, ChannelConversationRead } from '@/types';

import ChannelsPage from './ChannelsPage';

const attachmentTestState = vi.hoisted(() => ({
  context: null as TenantSessionContextValue | null,
}));

vi.mock('../contexts/TenantSessionContext', () => ({
  useTenantSession: () => attachmentTestState.context,
}));

const adminUser: EnterpriseAuthUser = {
  id: 'user-1',
  tenant_id: 'tenant_demo',
  username: 'admin',
  role: 'admin',
};

const binding: ChannelBindingRead = {
  id: 'binding-1',
  tenant_id: 'tenant_demo',
  agent_id: 'agent-1',
  channel: 'feishu',
  name: '附件渠道',
  status: 'active',
  connected: true,
  agents: [],
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
};

const conversation: ChannelConversationRead = {
  session_id: 'session-1',
  external_conv_id: 'external-1',
  display_name: '附件会话',
  is_group: false,
  agent_id: 'agent-1',
  agent_name: '员工一',
  message_count: 1,
  last_message_preview: '附件消息',
  updated_at: '2026-08-01T00:00:00Z',
};

const messages: ChannelConversationMessageRead[] = [{
  id: 'message-1',
  role: 'user',
  content: '请查看附件',
  created_at: '2026-08-01T00:00:00Z',
  attachments: [{
    id: 'attachment-1',
    filename: 'evidence.png',
    content_type: 'image/png',
    size: 4,
    kind: 'image',
  }],
}];

/** Build a current tenant context whose generation can be replaced by rerendering the page. */
function makeContext(generation: number): TenantSessionContextValue {
  return {
    tenantId: 'tenant_demo',
    tenantSlug: 'tenant-demo',
    userId: 'user-1',
    generation,
    signal: new AbortController().signal,
    session: {
      token: `token-${generation}`,
      scope: 'tenant',
      tenant: { id: 'tenant_demo', slug: 'tenant-demo', display_name: 'Demo tenant' },
      user: adminUser,
    },
    isCurrentGeneration: (candidate) => candidate === generation,
  };
}

/** Return an API-shaped response for JSON or blob consumers. */
function response(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify(body ?? {}),
    blob: async () => new Blob(['image']),
  } as Response;
}

/** Expose controlled settlement for a request whose intermediate UI state is under test. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  attachmentTestState.context = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ChannelsPage attachment lifecycle', () => {
  it('removes a revoked image URL before loading the same attachment in a new tenant generation', async () => {
    const user = userEvent.setup();
    attachmentTestState.context = makeContext(1);
    const createObjectURL = vi.fn()
      .mockReturnValueOnce('blob:tenant-one')
      .mockReturnValueOnce('blob:tenant-two');
    const revokeObjectURL = vi.fn();
    const replacementAttachment = deferred<Response>();
    let attachmentRequestCount = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(createObjectURL);
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(revokeObjectURL);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/attachments/attachment-1')) {
        attachmentRequestCount += 1;
        return attachmentRequestCount === 1 ? response(null) : replacementAttachment.promise;
      }
      if (url.includes('/conversations/session-1/messages')) return response(messages);
      if (url.includes('/conversations?')) {
        return response({ items: [conversation], total: 1, offset: 0, limit: 20 });
      }
      if (url.includes('/channels/meta')) return response([]);
      if (url.includes('/my-identity-bindings')) return response([]);
      if (url.includes('/deliveries/days')) return response({ days: [], total_days: 0, offset: 0, limit: 7 });
      if (url.includes('/api/enterprise/channels')) return response([binding]);
      return response([]);
    }));

    const page = render(
      <I18nProvider>
        <MemoryRouter>
          <ChannelsPage currentUser={adminUser} />
        </MemoryRouter>
      </I18nProvider>,
    );
    await user.click(await screen.findByText('附件渠道'));
    await user.click(await screen.findByText('附件会话'));
    expect((await screen.findByRole('img', { name: 'evidence.png' })).getAttribute('src')).toBe('blob:tenant-one');

    attachmentTestState.context = null;
    await act(async () => {
      page.rerender(
        <I18nProvider>
          <MemoryRouter>
            <ChannelsPage currentUser={adminUser} />
          </MemoryRouter>
        </I18nProvider>,
      );
    });

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:tenant-one');
    expect(screen.queryByRole('img', { name: 'evidence.png' })).toBeNull();

    attachmentTestState.context = makeContext(2);
    await act(async () => {
      page.rerender(
        <I18nProvider>
          <MemoryRouter>
            <ChannelsPage currentUser={adminUser} />
          </MemoryRouter>
        </I18nProvider>,
      );
    });
    expect(screen.queryByRole('img', { name: 'evidence.png' })).toBeNull();
    await user.click(await screen.findByText('附件渠道'));
    await user.click(await screen.findByText('附件会话'));
    expect(screen.queryByRole('img', { name: 'evidence.png' })).toBeNull();
    replacementAttachment.resolve(response(null));
    await waitFor(() => expect(screen.getByRole('img', { name: 'evidence.png' }).getAttribute('src')).toBe('blob:tenant-two'));
  });
});
