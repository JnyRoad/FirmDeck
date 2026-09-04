// @vitest-environment jsdom

/**
 * AuditTab 测试（T044）。
 * 覆盖：按动作 / 群组 / 操作者 / 版本筛选；分页「加载更多」；操作者名、群组名、
 * 原因等自由文本字段用 `RawContent` 渲染（`data-i18n-raw-kind="content"`）。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '@/i18n';
import type { KnowledgeBaseAuditEventRead, KnowledgeBaseRead } from '@/types';

import { AuditTab } from './AuditTab';

const sharedKb: KnowledgeBaseRead = {
  id: 'kb_1',
  tenant_id: 'tenant_demo',
  name: '产品 FAQ 共享库',
  status: 'active',
  mode: 'shared',
  document_count: 3,
  bucket_count: 1,
  chunk_count: 3,
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
};

function makeEvent(overrides: Partial<KnowledgeBaseAuditEventRead>): KnowledgeBaseAuditEventRead {
  return {
    id: 'evt_1',
    knowledge_base_id: 'kb_1',
    actor_type: 'user',
    actor_id: 'user_1',
    actor_name: '张三',
    action: 'draft_created',
    reason: '补充新版 FAQ',
    details: {},
    created_at: '2026-08-20T00:00:00Z',
    ...overrides,
  };
}

function createMockApi() {
  return {
    listAuditEvents: vi.fn().mockResolvedValue({
      items: [makeEvent({ id: 'evt_1' })],
      total: 3,
      offset: 0,
      limit: 20,
      has_more: true,
    }),
    listVersions: vi.fn().mockResolvedValue([]),
  };
}

function renderAuditTab(mockApi: ReturnType<typeof createMockApi>) {
  return render(
    <I18nProvider>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <AuditTab api={mockApi as any} kb={sharedKb} />
    </I18nProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AuditTab', () => {
  it('renders action/team/actor/version filters', async () => {
    const api = createMockApi();
    renderAuditTab(api);

    await waitFor(() => expect(api.listAuditEvents).toHaveBeenCalled());
    expect(screen.getByRole('combobox', { name: '动作' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: '版本' })).toBeTruthy();
    expect(screen.getByLabelText('群组 ID')).toBeTruthy();
    expect(screen.getByLabelText('操作者 ID')).toBeTruthy();
  });

  it('re-queries with the selected action filter', async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    renderAuditTab(api);

    await waitFor(() => expect(api.listAuditEvents).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('combobox', { name: '动作' }));
    // 筛选项显示的是本地化文案，不是后端枚举码（I8）。
    expect(screen.queryByText('published')).toBeNull();
    await user.click(await screen.findByText('发布'));

    await waitFor(() => expect(api.listAuditEvents).toHaveBeenLastCalledWith('kb_1', expect.objectContaining({
      action: 'published',
      offset: 0,
      limit: 20,
    })));
  });

  it('loads the next page and appends results when "加载更多" is clicked', async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    api.listAuditEvents
      .mockResolvedValueOnce({ items: [makeEvent({ id: 'evt_1' })], total: 2, offset: 0, limit: 20, has_more: true })
      .mockResolvedValueOnce({ items: [makeEvent({ id: 'evt_2', actor_name: '李四' })], total: 2, offset: 20, limit: 20, has_more: false });
    renderAuditTab(api);

    await screen.findByText('张三');
    await user.click(screen.getByRole('button', { name: '加载更多' }));

    await waitFor(() => expect(api.listAuditEvents).toHaveBeenLastCalledWith('kb_1', expect.objectContaining({ offset: 1 })));
    expect(await screen.findByText('李四')).toBeTruthy();
    expect(screen.getByText('张三')).toBeTruthy();
  });

  it('renders the audit action code as a localized label, not the raw enum code', async () => {
    const api = createMockApi();
    const { container } = renderAuditTab(api);

    await screen.findByText('张三');
    expect(screen.getByText('创建草稿')).toBeTruthy();
    expect(screen.queryByText('draft_created')).toBeNull();
    // 自有枚举码不再被误标为"原始内容"。
    const rawTexts = Array.from(container.querySelectorAll('[data-i18n-raw-kind="content"]')).map((n) => n.textContent);
    expect(rawTexts).not.toContain('draft_created');
  });

  it('debounces the free-text team/actor filters into a single request', async () => {
    vi.useFakeTimers();
    try {
      const api = createMockApi();
      renderAuditTab(api);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(api.listAuditEvents).toHaveBeenCalledTimes(1);

      const teamInput = screen.getByLabelText('群组 ID');
      act(() => {
        fireEvent.change(teamInput, { target: { value: 't' } });
        fireEvent.change(teamInput, { target: { value: 'te' } });
        fireEvent.change(teamInput, { target: { value: 'team_1' } });
      });
      // 三次按键在防抖窗口内：一次请求都不该发出。
      expect(api.listAuditEvents).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(api.listAuditEvents).toHaveBeenCalledTimes(2);
      expect(api.listAuditEvents).toHaveBeenLastCalledWith('kb_1', expect.objectContaining({ teamId: 'team_1' }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders free-text fields (actor, reason) through RawContent', async () => {
    const api = createMockApi();
    const { container } = renderAuditTab(api);

    await screen.findByText('张三');
    const rawNodes = container.querySelectorAll('[data-i18n-raw-kind="content"]');
    const rawTexts = Array.from(rawNodes).map((node) => node.textContent);
    expect(rawTexts).toContain('张三');
    expect(rawTexts).toContain('补充新版 FAQ');
  });
});
