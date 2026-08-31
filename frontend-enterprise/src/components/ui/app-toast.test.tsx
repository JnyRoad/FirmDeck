// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';

import { createMessageDescriptor } from '@/i18n/descriptors';
import { createAppTranslator } from '@/i18n/imperative';
import { AppIntlProvider } from '@/i18n/provider';
import { useAppIntl } from '@/i18n/useAppIntl';

const sonnerSpies = vi.hoisted(() => ({
  custom: vi.fn((_renderer: unknown) => 'custom-toast-id'),
  error: vi.fn((_message: unknown) => 'error-toast-id'),
  info: vi.fn((_message: unknown) => 'info-toast-id'),
  loading: vi.fn((_message: unknown) => 'loading-toast-id'),
  success: vi.fn((_message: unknown) => 'success-toast-id'),
  warning: vi.fn((_message: unknown) => 'warning-toast-id'),
  dismiss: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: sonnerSpies,
}));

import { createToastNotifier, notify } from './app-toast';

/** 渲染最近一次品牌 Toast 的 renderer，读取其最终用户可见文本而不依赖 DOM observer。 */
function renderLatestCustomToast(): string {
  const renderToast = sonnerSpies.custom.mock.calls[sonnerSpies.custom.mock.calls.length - 1]?.[0];
  if (typeof renderToast !== 'function') return '';

  const { container } = render((renderToast as () => ReactNode)() as ReactElement);
  return container.textContent ?? '';
}

/** 在真实 AppIntlProvider 子树中创建受控 notifier，模拟 UI locale 切换后的产品调用。 */
function ControlledNotifierHarness() {
  const intl = useAppIntl();
  const notifier = createToastNotifier(intl);
  const descriptor = createMessageDescriptor('common.action.save');
  const nextLocale = intl.locale === 'zh-CN' ? 'en-US' : 'zh-CN';

  return (
    <>
      <button
        type="button"
        data-testid="show-controlled-toast"
        onClick={() => notifier.error(descriptor)}
      />
      <button
        type="button"
        data-testid="switch-ui-locale"
        onClick={() => intl.setLocale(nextLocale)}
      />
    </>
  );
}

describe('descriptor-based application toasts', () => {
  /**
   * Clears the isolated sonner spies before each test so call assertions cannot leak between
   * severities or raw-content cases. The cleanup only mutates test doubles.
   */
  beforeEach(() => {
    sonnerSpies.custom.mockClear();
    sonnerSpies.error.mockClear();
    sonnerSpies.info.mockClear();
    sonnerSpies.loading.mockClear();
    sonnerSpies.success.mockClear();
    sonnerSpies.warning.mockClear();
    sonnerSpies.dismiss.mockClear();
  });

  /** 清理受控 Provider 与手动渲染的 Toast 节点，避免跨用例污染 locale 或文本断言。 */
  afterEach(() => {
    cleanup();
  });

  /**
   * Verifies all toast severities, including loading, receive localized product text from an
   * explicitly controlled translator rather than a legacy DOM observer or a raw descriptor object.
   */
  it('localizes success, error, warning, info, and loading descriptors', () => {
    const translator = createAppTranslator('en-US');
    const notifier = createToastNotifier(translator);
    const descriptor = createMessageDescriptor('common.action.save');

    notifier.success(descriptor);
    notifier.error(descriptor);
    notifier.warning(descriptor);
    notifier.info(descriptor);
    notifier.loading(descriptor);

    expect(sonnerSpies.warning.mock.calls[0]?.[0]).toBe('Save');
    expect(sonnerSpies.info.mock.calls[0]?.[0]).toBe('Save');
    expect(sonnerSpies.loading.mock.calls[0]?.[0]).toBe('Save');
    expect(sonnerSpies.custom).toHaveBeenCalledTimes(2);

    for (const [renderToast] of sonnerSpies.custom.mock.calls) {
      const toastNode = (renderToast as () => ReactNode)();
      const { container } = render(toastNode as ReactElement);
      expect(container.textContent).toContain('Save');
    }
  });

  /**
   * Verifies the toast API keeps descriptor values separate from product IDs and never treats raw
   * source content as a message key. The controlled translator receives only the stable ID.
   */
  it('does not accept a raw source string as a semantic message descriptor', () => {
    const translator = createAppTranslator('en-US');
    const notifier = createToastNotifier(translator);
    const rawSource = '知识库原文 / User input';

    // @ts-expect-error Raw source content is not a stable MessageDescriptor.
    notifier.success(rawSource);

    expect(sonnerSpies.custom).not.toHaveBeenCalled();
  });

  /** 验证所有 non-DOM 通知入口均以当前 Provider locale 解析，而不是读取旧 observer 状态。 */
  it('re-localizes a controlled notifier after the AppIntlProvider UI locale changes', () => {
    render(
      <AppIntlProvider initialLocale="zh-CN">
        <ControlledNotifierHarness />
      </AppIntlProvider>,
    );

    fireEvent.click(screen.getByTestId('show-controlled-toast'));
    expect(renderLatestCustomToast()).toContain('保存');
    expect(document.documentElement.lang).toBe('zh-CN');

    fireEvent.click(screen.getByTestId('switch-ui-locale'));
    fireEvent.click(screen.getByTestId('show-controlled-toast'));
    expect(renderLatestCustomToast()).toContain('Save');
    expect(document.documentElement.lang).toBe('en-US');
  });

  /** 原始详情、堆栈和 provider 返回体属于诊断数据，不能经 descriptor-only notifier 透传。 */
  it.each(['success', 'error', 'warning', 'info', 'loading'] as const)(
    'rejects raw provider/stack text for the %s controlled notifier',
    (severity) => {
      const translator = createAppTranslator('en-US');
      const notifier = createToastNotifier(translator);
      const rawProviderText = 'provider raw detail / stack secret';
      const invoke = notifier[severity] as unknown as (value: unknown) => unknown;

      invoke(rawProviderText);

      expect(sonnerSpies.custom).not.toHaveBeenCalled();
      expect(sonnerSpies.success).not.toHaveBeenCalled();
      expect(sonnerSpies.error).not.toHaveBeenCalled();
      expect(sonnerSpies.warning).not.toHaveBeenCalled();
      expect(sonnerSpies.info).not.toHaveBeenCalled();
      expect(sonnerSpies.loading).not.toHaveBeenCalled();
    },
  );

  /** Legacy notify 只保留已登记错误码兼容；任意旧 detail/stack/provider 文本都不能成为最终 UI。 */
  it('keeps registered legacy error-code compatibility without rendering raw diagnostic text', () => {
    notify.error('KNOWLEDGE_PUBLISH_CONFLICT');
    expect(sonnerSpies.custom).toHaveBeenCalledTimes(1);
    expect(renderLatestCustomToast()).not.toContain('KNOWLEDGE_PUBLISH_CONFLICT');

    const rawProviderDetail = 'provider raw detail: secret response';
    const rawStack = 'Error: provider stack secret';
    const customCallStart = sonnerSpies.custom.mock.calls.length;
    notify.error(rawProviderDetail);

    for (const [renderToast] of sonnerSpies.custom.mock.calls.slice(customCallStart)) {
      if (typeof renderToast !== 'function') continue;
      const { container } = render((renderToast as () => ReactNode)() as ReactElement);
      expect(container.textContent).not.toContain(rawProviderDetail);
      expect(container.textContent).not.toContain(rawStack);
    }

    notify.warning(rawProviderDetail);
    notify.info(rawProviderDetail);
    notify.loading(rawStack);

    for (const spy of [sonnerSpies.warning, sonnerSpies.info, sonnerSpies.loading]) {
      for (const [message] of spy.mock.calls) {
        expect(String(message)).not.toContain(rawProviderDetail);
        expect(String(message)).not.toContain(rawStack);
      }
    }
  });
});
