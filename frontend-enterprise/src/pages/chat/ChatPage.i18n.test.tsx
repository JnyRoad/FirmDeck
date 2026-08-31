// @vitest-environment jsdom

/**
 * 验证聊天 composer/附件等路由级 product chrome 只依赖 AppIntlProvider。
 * 用户输入、附件名和上传错误等业务/raw 值在 locale 切换后必须逐字保持不变。
 */

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppIntlProvider } from '@/i18n';
import type { HarnessWorkspaceArtifact } from '@/types';

import type { UseChatSession } from './useChatSession';
import Composer from './components/Composer';
import HarnessArtifactDownloads from './components/HarnessArtifactDownloads';

/** 构造 Composer 读取的最小 chat facade，所有副作用都使用可观测的测试函数。 */
function buildComposerChat(overrides: Partial<UseChatSession> = {}): UseChatSession {
  return {
    input: '',
    setInput: vi.fn(),
    slashCommands: [],
    composerAttachments: [],
    composerDragActive: false,
    composerPlusOpen: false,
    setComposerPlusOpen: vi.fn(),
    composerIntent: null,
    setComposerIntent: vi.fn(),
    readyComposerAttachments: [],
    uploadingComposerAttachment: false,
    currentSessionRunning: false,
    composerActive: true,
    showComposerAvatar: false,
    displayedProfile: null,
    displayedAgent: null,
    emptyRoleSummary: '',
    emptyProfileTags: [],
    emptyStats: [],
    enabledModelConfigs: [],
    selectedModelConfig: null,
    changeModelConfig: vi.fn(),
    showModelSetupNotice: false,
    modelSetupNoticeText: '',
    canConfigureModels: false,
    setModelSetupOpen: vi.fn(),
    isComposing: false,
    setIsComposing: vi.fn(),
    fileInputRef: { current: null },
    send: vi.fn(),
    abortStream: vi.fn(),
    handleComposerPaste: vi.fn(),
    handleComposerFileChange: vi.fn(),
    handleComposerDragEnter: vi.fn(),
    handleComposerDragOver: vi.fn(),
    handleComposerDragLeave: vi.fn(),
    handleComposerDrop: vi.fn(),
    removeComposerAttachment: vi.fn(),
    handleComposerPlusAction: vi.fn(),
    ...overrides,
  } as unknown as UseChatSession;
}

/** 在指定 locale 下渲染 Composer，不挂载 legacy Provider 或 MutationObserver。 */
function renderComposer(locale: 'zh-CN' | 'en-US', chat: UseChatSession) {
  return render(
    <AppIntlProvider initialLocale={locale}>
      <Composer chat={chat} />
    </AppIntlProvider>,
  );
}

/** 在指定 locale 下渲染生成文件区域，业务文件名始终来自 raw artifact。 */
function renderArtifacts(locale: 'zh-CN' | 'en-US', artifact: HarnessWorkspaceArtifact) {
  return render(
    <AppIntlProvider initialLocale={locale}>
      <HarnessArtifactDownloads
        artifacts={[artifact]}
        tenantId="tenant_demo"
        sessionId="session_demo"
      />
    </AppIntlProvider>,
  );
}

/** 提取 Composer 的按钮和输入框可访问 chrome，用于比较两个 locale 的产品语义。 */
function composerChrome(container: HTMLElement): { buttons: string[]; placeholder: string } {
  return {
    buttons: [...container.querySelectorAll<HTMLButtonElement>('button')]
      .map((button) => button.getAttribute('aria-label') || button.textContent || '')
      .filter(Boolean),
    placeholder: container.querySelector('textarea')?.getAttribute('placeholder') || '',
  };
}

afterEach(() => {
  cleanup();
});

describe('ChatPage locale matrix without legacy observer', () => {
  /** 验证 composer 的 stream/loading/error chrome 本地化，同时附件名和上传错误保持原样。 */
  it('localizes composer stream and attachment states without translating raw values', () => {
    const rawFilename = '知识库/合同-中文.pdf';
    const rawUploadError = 'RAW_UPLOAD_ERROR 中文详情';
    const chat = buildComposerChat({
      composerDragActive: true,
      composerAttachments: [{
        id: 'composer-attachment-i18n',
        filename: rawFilename,
        content_type: 'application/pdf',
        size: 42,
        kind: 'pdf',
        uploadStatus: 'error',
        uploadKey: 'upload-key-i18n',
        error: rawUploadError,
      }],
      currentSessionRunning: true,
      uploadingComposerAttachment: true,
    });

    const zhView = renderComposer('zh-CN', chat);
    const zhText = zhView.container.textContent || '';
    const zhChrome = composerChrome(zhView.container);
    zhView.unmount();

    const enView = renderComposer('en-US', chat);
    const enText = enView.container.textContent || '';
    const enChrome = composerChrome(enView.container);

    expect(zhText).toContain(rawFilename);
    expect(zhText).toContain(rawUploadError);
    expect(enText).toContain(rawFilename);
    expect(enText).toContain(rawUploadError);
    expect(enChrome).not.toEqual(zhChrome);
  });

  /** 验证生成文件区域的标题、下载 ARIA 和加载状态本地化，文件名不随 locale 改写。 */
  it('localizes artifact chrome while preserving download filename', () => {
    const rawFilename = 'reports/季度-中文.csv';
    const artifact: HarnessWorkspaceArtifact = {
      type: 'workspace_file',
      task_frame_id: 'task-frame-i18n',
      path: rawFilename,
      display_name: rawFilename,
      size: 2048,
      content_type: 'text/csv',
    };

    const zhView = renderArtifacts('zh-CN', artifact);
    const zhText = zhView.container.textContent || '';
    const zhButton = zhView.container.querySelector('button')?.getAttribute('aria-label') || '';
    zhView.unmount();

    const enView = renderArtifacts('en-US', artifact);
    const enText = enView.container.textContent || '';
    const enButton = enView.container.querySelector('button')?.getAttribute('aria-label') || '';

    expect(zhText).toContain(rawFilename.split('/').pop() || rawFilename);
    expect(enText).toContain(rawFilename.split('/').pop() || rawFilename);
    expect(enButton).not.toBe(zhButton);
    expect(enText).not.toBe(zhText);
  });
});
