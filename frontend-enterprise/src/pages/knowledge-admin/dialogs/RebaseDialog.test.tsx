// @vitest-environment jsdom

/**
 * RebaseDialog 测试（T054）。
 *
 * 覆盖：调用 `rebaseDraft` 得到预览，列出可自动合并与冲突文档；无冲突时服务端
 * 已直接落库返回 `RebaseResult`，前端直接完成并刷新；有冲突时逐篇打开
 * `MergeDialog` 收集 resolutions；全部解决后调用 `resolveRebase`；服务端
 * `KNOWLEDGE_PUBLISH_CONFLICT` 时提示重新预览。
 *
 * `MergeDialog` 用一个可控 stub 替身，聚焦 RebaseDialog 自身的编排逻辑（何时打开
 * 合并、如何收集 `{lineageId, contentMd}`、何时允许提交），不重复覆盖
 * `MergeDialog.test.tsx` 已验证的块级合并交互。
 */
import type { ComponentProps } from 'react';
import { createPortal } from 'react-dom';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '@/i18n';
import type { RebaseConflictDocument, RebasePreview, RebaseResult } from '@/types/knowledgeAdmin';
import type { KnowledgeAdminVersionRead } from '@/types/knowledgeAdmin';

// 真实 MergeDialog 是独立的 Radix `<Dialog>`，通过 Portal 挂载到 `document.body`——这样
// 打开它时不会被 RebaseDialog 自身弹窗（已挂载）的 `aria-hidden` 背景遮罩误伤。这里的替身
// 同样用 `createPortal` 挂到 `document.body`，避免它渲染在 RTL 的渲染容器（该容器在
// RebaseDialog 打开时已被标记 `aria-hidden`）内部，导致 `getByRole` 查不到（`getByText` 不受
// `aria-hidden` 影响所以能查到，会让失败现象显得矛盾）。
vi.mock('./MergeDialog', () => ({
  MergeDialog: ({ open, conflict, onComplete }: {
    open: boolean;
    conflict: RebaseConflictDocument;
    onComplete: (result: { lineageId: string; contentMd: string }) => void;
  }) => {
    if (!open) return null;
    // `pointerEvents: 'auto'` 对齐真实 `DialogOverlay`/`DialogContent` 的做法：外层弹窗打开期间
    // `document.body` 被整体设为 `pointer-events: none`，真实对话框内容显式覆盖回 `auto` 才能点击。
    return createPortal(
      <div style={{ pointerEvents: 'auto' }}>
        <span>merge-dialog-for-{conflict.lineage_id}</span>
        <button
          type="button"
          onClick={() => onComplete({ lineageId: conflict.lineage_id, contentMd: `${conflict.title}-resolved` })}
        >
          stub-complete-{conflict.lineage_id}
        </button>
      </div>,
      document.body,
    );
  },
}));

import { RebaseDialog } from './RebaseDialog';

function makeDraft(overrides: Partial<KnowledgeAdminVersionRead> = {}): KnowledgeAdminVersionRead {
  return {
    id: 'kbver_draft_b',
    tenant_id: 'tenant_demo',
    knowledge_base_id: 'kb_1',
    version: 'draft-b',
    name: 'draft-b',
    status: 'active',
    publication_state: 'draft',
    is_stale: true,
    base_version: '1.0.0',
    draft_name: 'draft-b',
    next_version_preview: { patch: '1.0.2', minor: '1.1.0', major: '2.0.0' },
    source_team_id: null,
    metadata: {},
    created_at: '2026-08-20T00:00:00Z',
    updated_at: '2026-08-20T00:00:00Z',
    ...overrides,
  };
}

function makePreview(overrides: Partial<RebasePreview> = {}): RebasePreview {
  return {
    draft_version_id: 'kbver_draft_b',
    from_base_version_id: 'kbver_v100',
    to_base_version_id: 'kbver_v101',
    auto_merged: [{ lineage_id: 'kdoc_yi', title: '文档乙', source: 'ours' }],
    conflicts: [
      {
        lineage_id: 'kdoc_jia',
        title: '文档甲',
        blocks: [
          {
            base_lines: ['原文'],
            ours_lines: ['草稿版'],
            theirs_lines: ['正式版'],
            context_before: [],
            context_after: [],
          },
        ],
      },
    ],
    ...overrides,
  };
}

function makeRebaseResult(overrides: Partial<RebaseResult> = {}): RebaseResult {
  return {
    new_version: makeDraft({ id: 'kbver_draft_b_v2', is_stale: false }),
    superseded_version_id: 'kbver_draft_b',
    ...overrides,
  };
}

function createMockApi() {
  return {
    rebaseDraft: vi.fn(),
    resolveRebase: vi.fn(),
  };
}

function renderDialog(props: Partial<ComponentProps<typeof RebaseDialog>> = {}) {
  const api = createMockApi();
  const onOpenChange = vi.fn();
  const onRebased = vi.fn();
  const utils = render(
    <I18nProvider>
      <RebaseDialog
        open
        onOpenChange={onOpenChange}
        api={api as unknown as ComponentProps<typeof RebaseDialog>['api']}
        kbId="kb_1"
        draft={makeDraft()}
        onRebased={onRebased}
        {...props}
      />
    </I18nProvider>,
  );
  return { ...utils, api, onOpenChange, onRebased };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('RebaseDialog', () => {
  // I13：Radix 的 `Dialog.Content` 只有在渲染树里挂了一个 `Dialog.Description`
  // （`@radix-ui/react-dialog` 通过 context 里的 `descriptionCount` 判断）时，才会给
  // `role="dialog"` 元素带上 `aria-describedby` 并指向一个真实存在、非空的元素——这是本
  // 项目当前锁定的 radix-ui 版本里唯一可观测的"有没有 Description"信号（这个版本的
  // `@radix-ui/react-dialog` 构建产物里没有 `console.warn`/`console.error` 形式的
  // "Missing `Description`" a11y 提示，实测确认过）。断言这条关联链路成立，证明
  // `DialogDescription`（包住既有的 `knowledgeAdmin.rebase.intro` 段落）确实生效，
  // 而不是又挂了一个没有内容/没有关联上的空壳。
  it('associates DialogContent with a real, non-empty DialogDescription via aria-describedby (Radix a11y wiring)', () => {
    renderDialog();
    const dialog = screen.getByRole('dialog', { name: '变基草稿 draft-b' });
    const describedById = dialog.getAttribute('aria-describedby');
    expect(describedById).toBeTruthy();
    const description = document.getElementById(describedById!);
    expect(description).toBeTruthy();
    expect(description!.textContent).toBe('把草稿变更重放到最新正式版之上：无交集的文档自动合并，双方都改过的文档需要逐篇解决冲突。');
  });

  it('submits a reason and calls rebaseDraft, then lists auto-merged and conflicting documents from the preview', async () => {
    const user = userEvent.setup();
    const { api } = renderDialog();
    api.rebaseDraft.mockResolvedValueOnce(makePreview());

    await user.type(screen.getByLabelText('变基原因'), '基线过期，需要变基');
    await user.click(screen.getByRole('button', { name: '开始变基' }));

    await waitFor(() => expect(api.rebaseDraft).toHaveBeenCalledWith('kb_1', 'kbver_draft_b', { changeReason: '基线过期，需要变基' }));

    expect(await screen.findByText('文档乙')).toBeTruthy();
    expect(screen.getByText('文档甲')).toBeTruthy();
  });

  it('when the server already persisted (no conflicts), calls onRebased with the result directly and closes', async () => {
    const user = userEvent.setup();
    const { api, onRebased, onOpenChange } = renderDialog();
    const result = makeRebaseResult();
    api.rebaseDraft.mockResolvedValueOnce(result);

    await user.type(screen.getByLabelText('变基原因'), '基线过期，需要变基');
    await user.click(screen.getByRole('button', { name: '开始变基' }));

    await waitFor(() => expect(onRebased).toHaveBeenCalledWith(result));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('opens MergeDialog per conflicting document and collects resolutions', async () => {
    const user = userEvent.setup();
    const { api } = renderDialog();
    api.rebaseDraft.mockResolvedValueOnce(makePreview());

    await user.type(screen.getByLabelText('变基原因'), '基线过期，需要变基');
    await user.click(screen.getByRole('button', { name: '开始变基' }));
    await screen.findByText('文档甲');

    await user.click(screen.getByRole('button', { name: '去合并' }));
    expect(screen.getByText('merge-dialog-for-kdoc_jia')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'stub-complete-kdoc_jia' }));
    expect(screen.queryByText('merge-dialog-for-kdoc_jia')).toBeNull();
    expect(screen.getByText('已解决 1/1 篇冲突文档')).toBeTruthy();
  });

  it('calls resolveRebase once every conflict is resolved, then onRebased with the result', async () => {
    const user = userEvent.setup();
    const { api, onRebased } = renderDialog();
    api.rebaseDraft.mockResolvedValueOnce(makePreview());
    const result = makeRebaseResult();
    api.resolveRebase.mockResolvedValueOnce(result);

    await user.type(screen.getByLabelText('变基原因'), '基线过期，需要变基');
    await user.click(screen.getByRole('button', { name: '开始变基' }));
    await screen.findByText('文档甲');

    await user.click(screen.getByRole('button', { name: '去合并' }));
    await user.click(screen.getByRole('button', { name: 'stub-complete-kdoc_jia' }));

    await user.click(screen.getByRole('button', { name: '完成变基' }));

    await waitFor(() => expect(api.resolveRebase).toHaveBeenCalledWith('kb_1', 'kbver_draft_b', {
      changeReason: '基线过期，需要变基',
      toBaseVersionId: 'kbver_v101',
      resolutions: [{ lineageId: 'kdoc_jia', contentMd: '文档甲-resolved' }],
    }));
    await waitFor(() => expect(onRebased).toHaveBeenCalledWith(result));
  });

  it('complete-rebase button stays disabled until every conflict is resolved', async () => {
    const user = userEvent.setup();
    const { api } = renderDialog();
    api.rebaseDraft.mockResolvedValueOnce(makePreview());

    await user.type(screen.getByLabelText('变基原因'), '基线过期，需要变基');
    await user.click(screen.getByRole('button', { name: '开始变基' }));
    await screen.findByText('文档甲');

    const completeButton = screen.getByRole('button', { name: '完成变基' }) as HTMLButtonElement;
    expect(completeButton.disabled).toBe(true);
  });

  it('shows a re-preview prompt on KNOWLEDGE_PUBLISH_CONFLICT from resolveRebase', async () => {
    const user = userEvent.setup();
    const { api } = renderDialog();
    api.rebaseDraft.mockResolvedValueOnce(makePreview());
    api.rebaseDraft.mockResolvedValueOnce(makePreview());
    api.resolveRebase.mockRejectedValueOnce({ code: 'KNOWLEDGE_PUBLISH_CONFLICT' });

    await user.type(screen.getByLabelText('变基原因'), '基线过期，需要变基');
    await user.click(screen.getByRole('button', { name: '开始变基' }));
    await screen.findByText('文档甲');

    await user.click(screen.getByRole('button', { name: '去合并' }));
    await user.click(screen.getByRole('button', { name: 'stub-complete-kdoc_jia' }));
    await user.click(screen.getByRole('button', { name: '完成变基' }));

    expect(await screen.findByText('正式版又变了，请重新预览变基。')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '重新预览' }));
    await waitFor(() => expect(api.rebaseDraft).toHaveBeenCalledTimes(2));
  });

  it('keeps already-resolved conflicts across a re-preview (I10)', async () => {
    const user = userEvent.setup();
    const { api } = renderDialog();
    const twoConflicts = makePreview({
      conflicts: [
        ...makePreview().conflicts,
        {
          lineage_id: 'kdoc_bing',
          title: '文档丙',
          blocks: [{ base_lines: ['原文丙'], ours_lines: ['草稿丙'], theirs_lines: ['正式丙'], context_before: [], context_after: [] }],
        },
      ],
    });
    api.rebaseDraft.mockResolvedValueOnce(twoConflicts);
    // 重新预览时"文档丙"已不再冲突（被别人先解决了），"文档甲"仍冲突。
    api.rebaseDraft.mockResolvedValueOnce(makePreview());
    api.resolveRebase.mockRejectedValueOnce({ code: 'KNOWLEDGE_PUBLISH_CONFLICT' });

    await user.type(screen.getByLabelText('变基原因'), '基线过期，需要变基');
    await user.click(screen.getByRole('button', { name: '开始变基' }));
    await screen.findByText('文档甲');

    // 两篇冲突各有一个「去合并」按钮，逐个解决。
    await user.click(screen.getAllByRole('button', { name: '去合并' })[0]);
    await user.click(screen.getByRole('button', { name: 'stub-complete-kdoc_jia' }));
    await user.click(screen.getByRole('button', { name: '去合并' }));
    await user.click(screen.getByRole('button', { name: 'stub-complete-kdoc_bing' }));
    expect(screen.getByText('已解决 2/2 篇冲突文档')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '完成变基' }));
    expect(await screen.findByText('正式版又变了，请重新预览变基。')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '重新预览' }));

    // 已完成的手工合并必须保留：新预览里仍冲突的「文档甲」直接算已解决，
    // 「完成变基」立刻可用，不用重做一遍；不再冲突的「文档丙」被剪掉。
    await waitFor(() => expect(screen.getByText('已解决 1/1 篇冲突文档')).toBeTruthy());
    expect((screen.getByRole('button', { name: '完成变基' }) as HTMLButtonElement).disabled).toBe(false);

    const result = makeRebaseResult();
    api.resolveRebase.mockResolvedValueOnce(result);
    await user.click(screen.getByRole('button', { name: '完成变基' }));
    await waitFor(() => expect(api.resolveRebase).toHaveBeenLastCalledWith('kb_1', 'kbver_draft_b', expect.objectContaining({
      resolutions: [{ lineageId: 'kdoc_jia', contentMd: '文档甲-resolved' }],
    })));
  });

  it('resets resolutions on a fresh start, not only on retry (I10)', async () => {
    const user = userEvent.setup();
    const { api } = renderDialog();
    api.rebaseDraft.mockResolvedValue(makePreview());

    await user.type(screen.getByLabelText('变基原因'), '基线过期，需要变基');
    await user.click(screen.getByRole('button', { name: '开始变基' }));
    await screen.findByText('文档甲');
    expect(screen.getByText('已解决 0/1 篇冲突文档')).toBeTruthy();
  });
});
