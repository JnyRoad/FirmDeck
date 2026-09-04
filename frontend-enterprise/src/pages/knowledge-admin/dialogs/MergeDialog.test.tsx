// @vitest-environment jsdom

/**
 * MergeDialog 测试（T055）。
 *
 * 纯组件：接收单篇文档的 `RebaseConflictDocument`（`blocks[]`），不调用任何 API。
 * 覆盖：非冲突段（`context_before`/`context_after`）直接进入合并结果；冲突块
 * 两栏对照（草稿 / 正式版）与四种选择（采用草稿 / 采用正式版 / 两者都保留 /
 * 编辑此段）；结果区带 Git 风格冲突标记且可手动编辑；仍有未解决标记时「完成」
 * 禁用；完成时输出 `{lineageId, contentMd}`。
 */
import type { ComponentProps } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '@/i18n';
import type { RebaseConflictDocument } from '@/types/knowledgeAdmin';

import { MergeDialog } from './MergeDialog';

function makeSingleBlockConflict(): RebaseConflictDocument {
  return {
    lineage_id: 'kdoc_1',
    title: '文档甲',
    blocks: [
      {
        base_lines: ['原文第二段'],
        ours_lines: ['草稿改的第二段'],
        theirs_lines: ['正式版改的第二段'],
        context_before: ['第一段（不变）'],
        context_after: ['第三段（不变）'],
      },
    ],
  };
}

function makeTwoBlockConflict(): RebaseConflictDocument {
  return {
    lineage_id: 'kdoc_2',
    title: '文档乙',
    blocks: [
      {
        base_lines: ['块一原文'],
        ours_lines: ['块一草稿'],
        theirs_lines: ['块一正式版'],
        context_before: [],
        context_after: ['中间不变段'],
      },
      {
        base_lines: ['块二原文'],
        ours_lines: ['块二草稿'],
        theirs_lines: ['块二正式版'],
        context_before: ['中间不变段'],
        context_after: [],
      },
    ],
  };
}

/** jest-dom 的 `toBeDisabled` 未在本仓库启用，直接读取原生 `disabled` 属性。 */
function isDisabled(element: HTMLElement): boolean {
  return (element as HTMLButtonElement).disabled;
}

function renderDialog(props: Partial<ComponentProps<typeof MergeDialog>> = {}) {
  const onOpenChange = vi.fn();
  const onComplete = vi.fn();
  const utils = render(
    <I18nProvider>
      <MergeDialog
        open
        onOpenChange={onOpenChange}
        conflict={makeSingleBlockConflict()}
        onComplete={onComplete}
        {...props}
      />
    </I18nProvider>,
  );
  return { ...utils, onOpenChange, onComplete };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('MergeDialog', () => {
  it('places non-conflicting context lines directly in the result, and marks the conflicting block with git-style markers', () => {
    renderDialog();
    const result = screen.getByLabelText('合并结果') as HTMLTextAreaElement;
    expect(result.value).toContain('第一段（不变）');
    expect(result.value).toContain('第三段（不变）');
    expect(result.value).toContain('<<<<<<<');
    expect(result.value).toContain('=======');
    expect(result.value).toContain('>>>>>>>');
    expect(result.value).toContain('草稿改的第二段');
    expect(result.value).toContain('正式版改的第二段');
  });

  it('shows a two-column comparison (draft / published) and four per-block actions', () => {
    renderDialog();
    expect(screen.getByText('草稿改的第二段')).toBeTruthy();
    expect(screen.getByText('正式版改的第二段')).toBeTruthy();
    expect(screen.getByRole('button', { name: '采用草稿' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '采用正式版' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '两者都保留' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '编辑此段' })).toBeTruthy();
  });

  it('disables complete while markers remain, and enables it once resolved', async () => {
    const user = userEvent.setup();
    renderDialog();

    expect(isDisabled(screen.getByRole('button', { name: '完成' }))).toBe(true);

    await user.click(screen.getByRole('button', { name: '采用草稿' }));

    const result = screen.getByLabelText('合并结果') as HTMLTextAreaElement;
    expect(result.value).not.toContain('<<<<<<<');
    expect(result.value).not.toContain('正式版改的第二段');
    expect(result.value).toContain('草稿改的第二段');
    expect(isDisabled(screen.getByRole('button', { name: '完成' }))).toBe(false);
  });

  it('"adopt published" replaces the block with theirs content only', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: '采用正式版' }));

    const result = screen.getByLabelText('合并结果') as HTMLTextAreaElement;
    expect(result.value).toContain('正式版改的第二段');
    expect(result.value).not.toContain('草稿改的第二段');
    expect(result.value).not.toContain('<<<<<<<');
  });

  it('"keep both" concatenates draft and published content without markers', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: '两者都保留' }));

    const result = screen.getByLabelText('合并结果') as HTMLTextAreaElement;
    expect(result.value).toContain('草稿改的第二段');
    expect(result.value).toContain('正式版改的第二段');
    expect(result.value).not.toContain('<<<<<<<');
    expect(isDisabled(screen.getByRole('button', { name: '完成' }))).toBe(false);
  });

  it('"edit this block" resets a resolved block back to raw conflict markers for manual editing', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: '采用草稿' }));
    expect(isDisabled(screen.getByRole('button', { name: '完成' }))).toBe(false);

    await user.click(screen.getByRole('button', { name: '编辑此段' }));

    const result = screen.getByLabelText('合并结果') as HTMLTextAreaElement;
    expect(result.value).toContain('<<<<<<<');
    expect(isDisabled(screen.getByRole('button', { name: '完成' }))).toBe(true);
  });

  it('allows manually editing the result textarea, and removing all markers enables complete', async () => {
    const user = userEvent.setup();
    renderDialog();

    const result = screen.getByLabelText('合并结果') as HTMLTextAreaElement;
    await user.clear(result);
    await user.type(result, '手动整理后的最终内容');

    expect(result.value).toBe('手动整理后的最终内容');
    expect(isDisabled(screen.getByRole('button', { name: '完成' }))).toBe(false);
  });

  it('calls onComplete with {lineageId, contentMd} for the resolved result', async () => {
    const user = userEvent.setup();
    const { onComplete } = renderDialog();

    await user.click(screen.getByRole('button', { name: '采用草稿' }));
    await user.click(screen.getByRole('button', { name: '完成' }));

    expect(onComplete).toHaveBeenCalledTimes(1);
    const [result] = onComplete.mock.calls[0] as [{ lineageId: string; contentMd: string }];
    expect(result.lineageId).toBe('kdoc_1');
    expect(result.contentMd).toContain('第一段（不变）');
    expect(result.contentMd).toContain('草稿改的第二段');
    expect(result.contentMd).not.toContain('<<<<<<<');
  });

  it('cancel closes without calling onComplete', async () => {
    const user = userEvent.setup();
    const { onOpenChange, onComplete } = renderDialog();

    await user.click(screen.getByRole('button', { name: '取消' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('requires every block resolved before complete is enabled (multi-block document)', async () => {
    const user = userEvent.setup();
    renderDialog({ conflict: makeTwoBlockConflict() });

    expect(isDisabled(screen.getByRole('button', { name: '完成' }))).toBe(true);

    const adoptDraftButtons = screen.getAllByRole('button', { name: '采用草稿' });
    await user.click(adoptDraftButtons[0]);
    expect(isDisabled(screen.getByRole('button', { name: '完成' }))).toBe(true);

    await user.click(adoptDraftButtons[1]);
    expect(isDisabled(screen.getByRole('button', { name: '完成' }))).toBe(false);
  });
});
