// @vitest-environment jsdom

/**
 * PublishDialog 测试（T043、T085）。
 * 覆盖：标题显示 `draft → next`；level 下拉切换更新结果号；审阅状态展示；
 * 非 stale 单按钮确认；stale 时展示冲突数与三按钮（变基/仍然覆盖发布/取消）；
 * 覆盖发布二次确认（T085，Ruling：FR-050 的「二次确认」保留）：点击「仍然覆盖
 * 发布」先展示内联确认（不发请求），未勾选「已了解」时「确认覆盖」禁用，
 * 勾选后点击才发送 `force_overwrite=true`；「返回」可恢复到 stale 选择视图。
 */
import type { ComponentProps } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '@/i18n';
import type { KnowledgeAdminVersionRead } from '@/types/knowledgeAdmin';

import { PublishDialog } from './PublishDialog';

function makeDraft(overrides: Partial<KnowledgeAdminVersionRead> = {}): KnowledgeAdminVersionRead {
  return {
    id: 'kbver_draft_1',
    tenant_id: 'tenant_demo',
    knowledge_base_id: 'kb_1',
    version: 'draft-7f2c',
    name: 'draft-7f2c',
    status: 'active',
    publication_state: 'draft',
    is_stale: false,
    base_version: '1.0.0',
    draft_name: 'draft-7f2c',
    next_version_preview: { patch: '1.0.1', minor: '1.1.0', major: '2.0.0' },
    source_team_id: null,
    metadata: { review: { staged: 3, pending: 0, reviewed_at: null, reviewed_by_user_id: null } },
    created_at: '2026-08-20T00:00:00Z',
    updated_at: '2026-08-20T00:00:00Z',
    ...overrides,
  };
}

function createMockApi() {
  return {
    getVersionDiff: vi.fn().mockResolvedValue({
      base_version_id: 'kbver_new_pub',
      target_version_id: 'kbver_draft_1',
      pairing: 'lineage',
      summary: { added: 1, modified: 2, deleted: 0 },
      documents: [],
    }),
  };
}

function renderDialog(props: Partial<ComponentProps<typeof PublishDialog>> = {}) {
  const api = createMockApi();
  const onSubmit = vi.fn();
  const onOpenChange = vi.fn();
  const utils = render(
    <I18nProvider>
      <PublishDialog
        open
        onOpenChange={onOpenChange}
        api={api as unknown as ComponentProps<typeof PublishDialog>['api']}
        kbId="kb_1"
        draft={makeDraft()}
        publishedVersion="1.0.1"
        onSubmit={onSubmit}
        {...props}
      />
    </I18nProvider>,
  );
  return { ...utils, api, onSubmit, onOpenChange };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PublishDialog', () => {
  it('shows the title as draft -> next version (patch by default)', () => {
    renderDialog();
    expect(screen.getByRole('heading', { name: /draft-7f2c/ }).textContent).toContain('v1.0.1');
  });

  it('updates the resulting version number in the title when the level select changes', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('combobox', { name: '版本递进' }));
    await user.click(await screen.findByText(/次版本/));

    expect(screen.getByRole('heading', { name: /draft-7f2c/ }).textContent).toContain('v1.1.0');
  });

  it('shows the review status from metadata.review', () => {
    renderDialog();
    expect(screen.getByText(/已接受 3 处，待审阅 0 处/)).toBeTruthy();
  });

  it('non-stale draft: a single confirm button submits with forceOverwrite=false', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderDialog();

    expect(screen.queryByText('变基（推荐）')).toBeNull();
    expect(screen.queryByText('仍然覆盖发布')).toBeNull();

    await user.type(screen.getByLabelText('变更原因'), '本次修订说明');
    await user.click(screen.getByRole('button', { name: '确认发布' }));

    expect(onSubmit).toHaveBeenCalledWith({ level: 'patch', changeReason: '本次修订说明', forceOverwrite: false });
  });

  it('stale draft: shows a conflict count and rebase/force-overwrite/cancel buttons; rebase forwards immediately', async () => {
    const user = userEvent.setup();
    const onRebase = vi.fn();
    const { onSubmit, api } = renderDialog({ draft: makeDraft({ is_stale: true }), onRebase });

    await waitFor(() => expect(api.getVersionDiff).toHaveBeenCalledWith('kb_1', 'kbver_draft_1', { against: 'published' }));
    // conflict count = summary.added(1) + modified(2) + deleted(0) = 3
    expect((await screen.findByRole('alert')).textContent).toContain('3');

    expect(screen.getByRole('button', { name: '变基（推荐）' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '仍然覆盖发布' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '确认发布' })).toBeNull();

    await user.click(screen.getByRole('button', { name: '变基（推荐）' }));
    expect(onRebase).toHaveBeenCalledWith('kbver_draft_1');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('stale draft: force overwrite requires an inline second confirmation before force_overwrite=true is sent', async () => {
    const user = userEvent.setup();
    const { onSubmit, api } = renderDialog({ draft: makeDraft({ is_stale: true }) });

    await waitFor(() => expect(api.getVersionDiff).toHaveBeenCalledWith('kb_1', 'kbver_draft_1', { against: 'published' }));
    await screen.findByRole('alert');
    await user.type(screen.getByLabelText('变更原因'), '强制覆盖发布');

    // 单击「仍然覆盖发布」只展示内联二次确认，不直接发请求。
    await user.click(screen.getByRole('button', { name: '仍然覆盖发布' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '仍然覆盖发布' })).toBeNull();

    // 内联说明需点名已发布版本与草稿基线版本。
    expect(screen.getByText(/对方已发布的 v1\.0\.1/).textContent).toContain('v1.0.0');

    // 未勾选「已了解」时「确认覆盖」保持禁用（jest-dom 的 toBeDisabled 未启用，直接读原生属性）。
    const confirmButton = screen.getByRole('button', { name: '确认覆盖' }) as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(true);
    await user.click(confirmButton);
    expect(onSubmit).not.toHaveBeenCalled();

    // 「返回」恢复 stale 选择视图。
    await user.click(screen.getByRole('button', { name: '返回' }));
    expect(screen.getByRole('button', { name: '仍然覆盖发布' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '确认覆盖' })).toBeNull();

    // 重新进入内联确认、勾选后点击才真正发送 force_overwrite=true。
    await user.click(screen.getByRole('button', { name: '仍然覆盖发布' }));
    await user.click(screen.getByRole('checkbox', { name: '我已了解将丢弃这些变更' }));
    await user.click(screen.getByRole('button', { name: '确认覆盖' }));

    expect(onSubmit).toHaveBeenCalledWith({ level: 'patch', changeReason: '强制覆盖发布', forceOverwrite: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
