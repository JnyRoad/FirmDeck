// @vitest-environment jsdom

/**
 * 知识库管理端统一 toast 出口测试（T082，先于 T083 实现编写，验证当前 RED）。
 *
 * 背景：`notify.error(text)`（legacy facade）只接受稳定错误码字符串，传入任意已翻译好的
 * 自然语言文本时会静默退化成通用兜底文案（`common.error.generic`），把旧的
 * `knowledgeAdminErrorMessage(...)`（已在 T084 随全部调用点迁移移除）算出来的具体错误说明
 * 整个丢弃——这正是 SettingsTab 保存失败、ListPage 删除失败、ContentTab 写回冲突等场景里，
 * 用户只看到"操作失败，请稍后重试。"而看不到具体原因的根因。
 *
 * 覆盖：
 * 1. 已注册错误码（`KNOWLEDGE_BASELINE_STALE`、`KNOWLEDGE_PUBLISH_CONFLICT`）经统一出口显示
 *    契约映射的具体文案，而不是通用兜底文案。
 * 2. 成功 toast 显示 descriptor 文案。
 * 3. 未知错误码回落到调用方指定的 fallback 文案（而不是通用兜底文案，也不是空白）。
 * 4. zh-CN 与 en-US 两种 locale 下，同一错误码/descriptor 的文案不同，且都不是消息 id 字面量。
 */
import type { ReactElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppIntlProvider } from '@/i18n';
import { createMessageDescriptor } from '@/i18n/descriptors';

const sonnerSpies = vi.hoisted(() => ({ custom: vi.fn() }));
vi.mock('sonner', () => ({ toast: sonnerSpies }));

import { useKnowledgeAdminToast } from './errorMessage';

/** 渲染最近一次品牌 Toast 的 renderer，读取其最终用户可见文本。 */
function renderLatestToastText(): string {
  const call = sonnerSpies.custom.mock.calls[sonnerSpies.custom.mock.calls.length - 1];
  const renderToast = call?.[0];
  if (typeof renderToast !== 'function') return '';
  const { container } = render((renderToast as () => ReactElement)());
  return container.textContent ?? '';
}

/** 渲染出口使用方组件：暴露一组按钮，各自触发一种 toast 场景，供测试点击驱动。 */
function ToastOutletHarness() {
  const toast = useKnowledgeAdminToast();
  return (
    <>
      <button
        type="button"
        data-testid="known-error-baseline-stale"
        onClick={() => toast.error(
          { code: 'KNOWLEDGE_BASELINE_STALE', params: { base_version: '1.0.0', published_version: '1.0.1', conflict_count: 2 } },
          'knowledgeAdmin.toast.updateError',
        )}
      />
      <button
        type="button"
        data-testid="known-error-publish-conflict"
        onClick={() => toast.error({ code: 'KNOWLEDGE_PUBLISH_CONFLICT' }, 'knowledgeAdmin.toast.updateError')}
      />
      <button
        type="button"
        data-testid="unknown-error"
        onClick={() => toast.error({ code: 'SOME_UNREGISTERED_CODE' }, 'knowledgeAdmin.toast.updateError')}
      />
      <button
        type="button"
        data-testid="success"
        onClick={() => toast.success(createMessageDescriptor('knowledgeAdmin.toast.updateSuccess'))}
      />
    </>
  );
}

function renderHarness(locale: 'zh-CN' | 'en-US') {
  return render(
    <AppIntlProvider initialLocale={locale}>
      <ToastOutletHarness />
    </AppIntlProvider>,
  );
}

afterEach(() => {
  cleanup();
  sonnerSpies.custom.mockClear();
});

describe('useKnowledgeAdminToast', () => {
  it('shows the contract-mapped specific text for a registered error code, not the generic fallback', () => {
    renderHarness('zh-CN');
    fireEvent.click(screen.getByTestId('known-error-baseline-stale'));

    const text = renderLatestToastText();
    // 具体文案：草稿基线过期详情（版本号 + 冲突数），来自 errors.knowledge.baselineStale。
    expect(text).toContain('1.0.0');
    expect(text).toContain('1.0.1');
    expect(text).toContain('2');
    // 绝不能退化成通用兜底文案。
    expect(text).not.toBe('操作失败，请稍后重试。');
    // 也不能是调用方传入的 fallbackId 对应文案（"保存失败。"）——已注册错误码应优先命中契约映射。
    expect(text).not.toBe('保存失败。');
  });

  it('shows the contract-mapped text for KNOWLEDGE_PUBLISH_CONFLICT, not the generic fallback', () => {
    renderHarness('zh-CN');
    fireEvent.click(screen.getByTestId('known-error-publish-conflict'));

    const text = renderLatestToastText();
    expect(text).toBe('正式版本已变化，请基于最新版本重新操作。');
    expect(text).not.toBe('操作失败，请稍后重试。');
  });

  it('shows the success descriptor text', () => {
    renderHarness('zh-CN');
    fireEvent.click(screen.getByTestId('success'));

    expect(renderLatestToastText()).toBe('已保存。');
  });

  it('falls back to the caller-provided fallback id for an unregistered error code', () => {
    renderHarness('zh-CN');
    fireEvent.click(screen.getByTestId('unknown-error'));

    const text = renderLatestToastText();
    expect(text).toBe('保存失败。');
    expect(text).not.toBe('操作失败，请稍后重试。');
  });

  it('localizes the same registered error code differently across zh-CN and en-US, never as a literal message id', () => {
    renderHarness('zh-CN');
    fireEvent.click(screen.getByTestId('known-error-baseline-stale'));
    const zh = renderLatestToastText();
    cleanup();
    sonnerSpies.custom.mockClear();

    renderHarness('en-US');
    fireEvent.click(screen.getByTestId('known-error-baseline-stale'));
    const en = renderLatestToastText();

    expect(zh).not.toBe(en);
    expect(zh).not.toContain('errors.knowledge.baselineStale');
    expect(en).not.toContain('errors.knowledge.baselineStale');
    expect(en).toContain('1.0.0');
    expect(en).toContain('1.0.1');
  });

  it('localizes the success descriptor differently across zh-CN and en-US', () => {
    renderHarness('zh-CN');
    fireEvent.click(screen.getByTestId('success'));
    const zh = renderLatestToastText();
    cleanup();
    sonnerSpies.custom.mockClear();

    renderHarness('en-US');
    fireEvent.click(screen.getByTestId('success'));
    const en = renderLatestToastText();

    expect(zh).toBe('已保存。');
    expect(en).toBe('Changes saved.');
    expect(zh).not.toBe(en);
  });
});
