// @vitest-environment jsdom

/**
 * TeamKnowledgePermissionMatrix 测试（US4 T062）。
 * 覆盖新增的批量设置能力（全部只读 / 全部可编辑 / 全部撤销，均为本地矩阵状态操作，
 * 需要点击「保存权限」才会调用 onSave）：批量后再保存时携带正确的完整矩阵；
 * `showBulkActions` 缺省（TeamDetailPage 既有用法）时不展示批量按钮，
 * 行为与既有用法保持一致；以及零成员时展示空状态提示而不是空网格。
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '@/i18n';
import type { TeamKnowledgeBindingRead, TeamMemberRead } from '@/types';

import TeamKnowledgePermissionMatrix from './TeamKnowledgePermissionMatrix';

const binding: TeamKnowledgeBindingRead = {
  id: 'teamkb-1',
  team_id: 'team-1',
  knowledge_base_id: 'kb-1',
  knowledge_base_name: '共享制度库',
  status: 'active',
  revision: 3,
  is_default: false,
  published_version_id: 'kbver-1',
  published_version: '1.2.0',
  grants: [
    { agent_id: 'agent-1', permission: 'reader', status: 'active' },
  ],
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
};

const members: TeamMemberRead[] = [
  { id: 'member-1', team_id: 'team-1', agent_id: 'agent-1', role: 'leader', agent_name: '小艾', created_at: '2026-08-01T00:00:00Z' },
  { id: 'member-2', team_id: 'team-1', agent_id: 'agent-2', role: 'member', agent_name: '小北', created_at: '2026-08-01T00:00:00Z' },
];

function renderMatrix(overrides: Partial<Parameters<typeof TeamKnowledgePermissionMatrix>[0]> = {}) {
  const onSave = vi.fn().mockResolvedValue(undefined);
  const onSetDefault = vi.fn().mockResolvedValue(undefined);
  const onRemove = vi.fn().mockResolvedValue(undefined);
  const view = render(
    <I18nProvider>
      <TeamKnowledgePermissionMatrix
        binding={binding}
        members={members}
        onSave={onSave}
        onSetDefault={onSetDefault}
        onRemove={onRemove}
        {...overrides}
      />
    </I18nProvider>,
  );
  return { ...view, onSave, onSetDefault, onRemove };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('TeamKnowledgePermissionMatrix bulk actions (T062)', () => {
  it('does not render bulk-action buttons when showBulkActions is not passed (TeamDetailPage compatibility)', () => {
    renderMatrix();
    expect(screen.queryByRole('button', { name: '全部设为可读取' })).toBeNull();
    expect(screen.queryByRole('button', { name: '全部设为可编辑' })).toBeNull();
    expect(screen.queryByRole('button', { name: '全部撤销授权' })).toBeNull();
  });

  it('still saves the pre-existing per-member grant selection unchanged when showBulkActions is omitted', async () => {
    const user = userEvent.setup();
    const { onSave } = renderMatrix();

    await user.click(screen.getByRole('button', { name: '保存 共享制度库 权限' }));

    expect(onSave).toHaveBeenCalledWith(binding, [
      { agent_id: 'agent-1', permission: 'reader' },
      { agent_id: 'agent-2', permission: null },
    ]);
  });

  it('bulk-sets every member to reader, then saves the complete matrix on explicit save click', async () => {
    const user = userEvent.setup();
    const { onSave } = renderMatrix({ showBulkActions: true });

    await user.click(screen.getByRole('button', { name: '全部设为可读取' }));
    // Bulk actions only edit local state; the API call still requires the explicit save click.
    expect(onSave).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '保存 共享制度库 权限' }));
    expect(onSave).toHaveBeenCalledWith(binding, [
      { agent_id: 'agent-1', permission: 'reader' },
      { agent_id: 'agent-2', permission: 'reader' },
    ]);
  });

  it('bulk-sets every member to editor', async () => {
    const user = userEvent.setup();
    const { onSave } = renderMatrix({ showBulkActions: true });

    await user.click(screen.getByRole('button', { name: '全部设为可编辑' }));
    await user.click(screen.getByRole('button', { name: '保存 共享制度库 权限' }));

    expect(onSave).toHaveBeenCalledWith(binding, [
      { agent_id: 'agent-1', permission: 'editor' },
      { agent_id: 'agent-2', permission: 'editor' },
    ]);
  });

  it('bulk-revokes every member back to no access, overriding a pre-existing grant', async () => {
    const user = userEvent.setup();
    const { onSave } = renderMatrix({ showBulkActions: true });

    await user.click(screen.getByRole('button', { name: '全部撤销授权' }));
    await user.click(screen.getByRole('button', { name: '保存 共享制度库 权限' }));

    expect(onSave).toHaveBeenCalledWith(binding, [
      { agent_id: 'agent-1', permission: null },
      { agent_id: 'agent-2', permission: null },
    ]);
  });

  it('lets an admin bulk-set then still hand-adjust one member before saving', async () => {
    const user = userEvent.setup();
    const { onSave } = renderMatrix({ showBulkActions: true });

    await user.click(screen.getByRole('button', { name: '全部设为可读取' }));
    await user.selectOptions(screen.getByLabelText('小北 在 共享制度库 的权限'), 'publisher');
    await user.click(screen.getByRole('button', { name: '保存 共享制度库 权限' }));

    expect(onSave).toHaveBeenCalledWith(binding, [
      { agent_id: 'agent-1', permission: 'reader' },
      { agent_id: 'agent-2', permission: 'publisher' },
    ]);
  });

  it('shows an empty-state message instead of an empty grid when the team has no members', () => {
    renderMatrix({ members: [] });
    expect(screen.getByText('暂无群组成员可设置权限。')).toBeTruthy();
  });

  it('keeps rendering the existing card chrome (badges, save button) when showBulkActions is true', () => {
    renderMatrix({ showBulkActions: true });
    const card = screen.getByText('共享制度库').closest('article')!;
    expect(within(card).getByText('共享知识库')).toBeTruthy();
    expect(within(card).getByRole('button', { name: '保存 共享制度库 权限' })).toBeTruthy();
  });
});
