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
    merged_text: [
      '第一段（不变）',
      '<<<<<<< ours',
      '草稿改的第二段',
      '=======',
      '正式版改的第二段',
      '>>>>>>> theirs',
      '第三段（不变）',
    ].join('\n'),
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
    merged_text: [
      '<<<<<<< ours',
      '块一草稿',
      '=======',
      '块一正式版',
      '>>>>>>> theirs',
      '中间不变段',
      '<<<<<<< ours',
      '块二草稿',
      '=======',
      '块二正式版',
      '>>>>>>> theirs',
    ].join('\n'),
  };
}

/**
 * 30 行文档、冲突只出现在正中间（第 15 行）：冲突区之外的 29 行正文（`ctx-01`…`ctx-29`）
 * 都只在 `merged_text` 里，`blocks[0]` 的 `context_before`/`context_after` 只覆盖到 ±2 行。
 * 用来钉住「合并结果必须以完整合并文本为底稿」——按 ±2 行上下文拼接会丢掉 25 行正文。
 */
function makeLongDocumentConflict(): RebaseConflictDocument {
  const contextLines = Array.from({ length: 29 }, (_, index) => `ctx-${String(index + 1).padStart(2, '0')}`);
  const before = contextLines.slice(0, 14);
  const after = contextLines.slice(14);
  return {
    lineage_id: 'kdoc_long',
    title: '长文档',
    blocks: [
      {
        base_lines: ['原始中段'],
        ours_lines: ['草稿中段'],
        theirs_lines: ['正式版中段'],
        context_before: before.slice(-2),
        context_after: after.slice(0, 2),
      },
    ],
    merged_text: [
      ...before,
      '<<<<<<< ours',
      '草稿中段',
      '=======',
      '正式版中段',
      '>>>>>>> theirs',
      ...after,
    ].join('\n'),
  };
}

/** 统计一行在文本里出现的次数（整行匹配），用于「每行恰好出现一次」的断言。 */
function countLine(text: string, line: string): number {
  return text.split('\n').filter((item) => item === line).length;
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

  it('composes from the full merged text: every non-conflicting line survives exactly once', async () => {
    const user = userEvent.setup();
    renderDialog({ conflict: makeLongDocumentConflict() });

    await user.click(screen.getByRole('button', { name: '采用草稿' }));

    const result = screen.getByLabelText('合并结果') as HTMLTextAreaElement;
    for (let index = 1; index <= 29; index += 1) {
      const line = `ctx-${String(index).padStart(2, '0')}`;
      expect(countLine(result.value, line)).toBe(1);
    }
    expect(countLine(result.value, '草稿中段')).toBe(1);
    expect(result.value).not.toContain('正式版中段');
    expect(result.value).not.toContain('<<<<<<<');
    // 完整文档 = 29 行正文 + 1 行被选中的正文。
    expect(result.value.split('\n')).toHaveLength(30);
  });

  it('replaces each conflict region independently when two blocks are resolved differently', async () => {
    const user = userEvent.setup();
    const { onComplete } = renderDialog({ conflict: makeTwoBlockConflict() });

    await user.click(screen.getAllByRole('button', { name: '采用草稿' })[0]);
    await user.click(screen.getAllByRole('button', { name: '采用正式版' })[1]);
    await user.click(screen.getByRole('button', { name: '完成' }));

    const [result] = onComplete.mock.calls[0] as [{ contentMd: string }];
    expect(result.contentMd.split('\n')).toEqual(['块一草稿', '中间不变段', '块二正式版']);
    // 两块共享的 `中间不变段` 只能出现一次（旧的按块拼接会写两遍）。
    expect(countLine(result.contentMd, '中间不变段')).toBe(1);
  });

  it('keeps an unresolved region verbatim and keeps complete disabled while it remains', async () => {
    const user = userEvent.setup();
    renderDialog({ conflict: makeTwoBlockConflict() });

    await user.click(screen.getAllByRole('button', { name: '采用草稿' })[0]);

    const result = screen.getByLabelText('合并结果') as HTMLTextAreaElement;
    expect(result.value.split('\n')).toEqual([
      '块一草稿',
      '中间不变段',
      '<<<<<<< ours',
      '块二草稿',
      '=======',
      '块二正式版',
      '>>>>>>> theirs',
    ]);
    expect(isDisabled(screen.getByRole('button', { name: '完成' }))).toBe(true);
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
