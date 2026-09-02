// @vitest-environment jsdom

import { cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReactElement } from 'react';
import { AppIntlProvider } from '@/i18n';
import type { AppLocale } from '@/i18n/locales';
import type { HarnessWorkspaceArtifact } from '@/types';

import HarnessArtifactDownloads from './HarnessArtifactDownloads';

const mocks = vi.hoisted(() => ({
  blob: vi.fn(),
  notifyError: vi.fn(),
  notifySuccess: vi.fn(),
}));

vi.mock('@/api/client', () => ({
  api: { blob: mocks.blob },
}));

vi.mock('@/components/ui/app-toast', () => ({
  createToastNotifier: () => ({
    error: mocks.notifyError,
    success: mocks.notifySuccess,
  }),
  notify: {
    error: mocks.notifyError,
    success: mocks.notifySuccess,
  },
}));

const artifact: HarnessWorkspaceArtifact = {
  type: 'workspace_file',
  task_frame_id: 'task/frame',
  path: 'reports/quarterly summary.txt',
  display_name: 'Q2 财务报告.txt',
  description: '最终交付版',
  size: 2048,
};

beforeEach(() => {
  mocks.blob.mockReset();
  mocks.notifyError.mockReset();
  mocks.notifySuccess.mockReset();
  vi.spyOn(window.URL, 'createObjectURL').mockReturnValue('blob:artifact');
  vi.spyOn(window.URL, 'revokeObjectURL').mockImplementation(() => undefined);
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** 为 artifact 行为测试提供显式语义 i18n runtime，避免依赖 legacy observer。 */
function render(ui: ReactElement, locale: AppLocale = 'zh-CN') {
  return rtlRender(<AppIntlProvider initialLocale={locale}>{ui}</AppIntlProvider>);
}

/** 使用与产品契约相同的 Intl 单位格式，生成 artifact 大小的行为期望。 */
function expectedKilobyteSize(locale: AppLocale): string {
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: 'kilobyte',
    unitDisplay: 'short',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(2);
}

describe('Harness artifact downloads', () => {
  it('downloads through the authenticated blob API with scoped identifiers', async () => {
    const user = userEvent.setup();
    mocks.blob.mockResolvedValue(new Blob(['artifact']));
    render(
      <HarnessArtifactDownloads
        artifacts={[artifact]}
        tenantId="tenant demo"
        sessionId="session demo"
      />,
    );

    expect(screen.getByText('Q2 财务报告.txt')).toBeTruthy();
    expect(screen.getByText((_, element) => (
      element?.getAttribute('data-i18n-raw-kind') === 'content'
      && element.textContent === `最终交付版 · ${expectedKilobyteSize('zh-CN')}`
    ))).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Q2 财务报告\.txt$/ }));

    await waitFor(() => {
      expect(mocks.blob).toHaveBeenCalledWith(
        '/api/chat/sessions/session%20demo/artifacts/task%2Fframe'
          + '?tenant_id=tenant+demo&path=reports%2Fquarterly+summary.txt',
      );
    });
    expect(window.URL.createObjectURL).toHaveBeenCalled();
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled();
    expect(window.URL.revokeObjectURL).toHaveBeenCalledWith('blob:artifact');
    expect(mocks.notifySuccess).toHaveBeenCalledWith(
      {
        id: 'chat.artifacts.downloaded',
        values: { filename: 'Q2 财务报告.txt' },
      },
    );
  });

  it('keeps the action disabled without a persisted session', () => {
    render(
      <HarnessArtifactDownloads
        artifacts={[artifact]}
        tenantId="tenant demo"
        sessionId=""
      />,
    );

    const button = screen.getByRole(
      'button',
      { name: /Q2 财务报告\.txt$/ },
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(mocks.blob).not.toHaveBeenCalled();
  });

  it('loads generated image artifacts through the authenticated API and renders a preview', async () => {
    const imageArtifact: HarnessWorkspaceArtifact = {
      ...artifact,
      path: 'charts/趋势图.png',
      display_name: '趋势图.png',
      content_type: 'image/png',
      size: 4096,
    };
    mocks.blob.mockResolvedValue(new Blob(['image'], { type: 'image/png' }));

    render(
      <HarnessArtifactDownloads
        artifacts={[imageArtifact]}
        tenantId="tenant demo"
        sessionId="session demo"
      />,
    );

    await waitFor(() => {
      expect(mocks.blob).toHaveBeenCalledWith(
        '/api/chat/sessions/session%20demo/artifacts/task%2Fframe'
          + '?tenant_id=tenant+demo&path=charts%2F%E8%B6%8B%E5%8A%BF%E5%9B%BE.png',
      );
      expect(screen.getByRole('img', { name: '趋势图.png' })).toBeTruthy();
    });
    expect(screen.getByRole('link', { name: '查看图片 趋势图.png' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '下载图片 趋势图.png' })).toBeTruthy();
  });

  it('reports a failed download without creating an object URL', async () => {
    const user = userEvent.setup();
    mocks.blob.mockRejectedValue(new Error('Artifact not found'));
    render(
      <HarnessArtifactDownloads
        artifacts={[artifact]}
        tenantId="tenant demo"
        sessionId="session demo"
      />,
    );

    await user.click(screen.getByRole('button', { name: /Q2 财务报告\.txt$/ }));

    await waitFor(() => {
      expect(mocks.notifyError).toHaveBeenCalledWith({ id: 'chat.artifacts.downloadFailed' });
    });
    expect(window.URL.createObjectURL).not.toHaveBeenCalled();
  });

  it.each([
    ['zh-CN', '生成文件', '下载文件 Q2 财务报告.txt'],
    ['en-US', 'Generated files', 'Download file Q2 财务报告.txt'],
  ] as const)('localizes artifact chrome in %s while preserving raw metadata', (locale, heading, downloadLabel) => {
    render(
      <HarnessArtifactDownloads
        artifacts={[artifact]}
        tenantId="tenant demo"
        sessionId="session demo"
      />,
      locale,
    );

    expect(screen.getByLabelText(heading)).toBeTruthy();
    expect(screen.getByText(heading)).toBeTruthy();
    expect(screen.getByRole('button', { name: downloadLabel })).toBeTruthy();
    expect(screen.getByText('Q2 财务报告.txt')).toBeTruthy();
    expect(screen.getByText((_, element) => (
      element?.getAttribute('data-i18n-raw-kind') === 'content'
      && element.textContent === `最终交付版 · ${expectedKilobyteSize(locale)}`
    ))).toBeTruthy();
  });
});
