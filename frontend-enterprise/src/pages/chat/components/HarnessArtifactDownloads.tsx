import { useEffect, useState, type ReactNode } from 'react';

import StaffdeckIcon from '@/components/StaffdeckIcon';
import { createToastNotifier } from '@/components/ui/app-toast';
import { api } from '@/api/client';
import { RawContent, RawIdentifier } from '@/i18n/RawContent';
import type { AppLocale } from '@/i18n/locales';
import { useAppIntl } from '@/i18n/useAppIntl';
import type { HarnessWorkspaceArtifact } from '@/types';

import {
  CHAT_ARTIFACTS_CLASS,
  CHAT_ARTIFACT_BUTTON_CLASS,
  CHAT_ARTIFACT_COPY_CLASS,
  CHAT_ARTIFACT_HEADING_CLASS,
  CHAT_ARTIFACT_ICON_CLASS,
  CHAT_ARTIFACT_IMAGE_CARD_CLASS,
  CHAT_ARTIFACT_IMAGE_CLASS,
  CHAT_ARTIFACT_IMAGE_DOWNLOAD_CLASS,
  CHAT_ARTIFACT_IMAGE_FOOTER_CLASS,
  CHAT_ARTIFACT_IMAGE_LINK_CLASS,
  CHAT_ARTIFACT_IMAGE_PLACEHOLDER_CLASS,
  CHAT_ARTIFACT_LIST_CLASS,
  CHAT_ARTIFACT_META_CLASS,
  CHAT_ARTIFACT_NAME_CLASS,
} from '../chatPageStyles';

type HarnessArtifactDownloadsProps = {
  artifacts: HarnessWorkspaceArtifact[];
  tenantId: string;
  sessionId: string;
};

/** 渲染生成文件区域：下载 chrome 本地化，文件名、描述和二进制错误保持 raw。 */
export default function HarnessArtifactDownloads({
  artifacts,
  tenantId,
  sessionId,
}: HarnessArtifactDownloadsProps) {
  const [downloading, setDownloading] = useState('');
  const { t, locale } = useAppIntl();
  const toast = createToastNotifier({ t });

  if (artifacts.length === 0) return null;

  /** 下载单个 artifact；请求异常仅记录到私有日志，toast 使用稳定 descriptor。 */
  async function downloadArtifact(artifact: HarnessWorkspaceArtifact) {
    const identity = `${artifact.task_frame_id}\u001f${artifact.path}`;
    const filename = artifactFilename(artifact.display_name || artifact.path);
    setDownloading(identity);
    try {
      const blob = await api.blob(artifactApiPath(artifact, tenantId, sessionId));
      const objectUrl = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(objectUrl);
      toast.success({ id: 'chat.artifacts.downloaded', values: { filename } });
    } catch (error) {
      // 下载根因只保留在诊断日志，产品 toast 仅展示稳定的本地化错误。
      console.error('[chat-artifact] download failed', error);
      toast.error({ id: 'chat.artifacts.downloadFailed' });
    } finally {
      setDownloading('');
    }
  }

  return (
    <div className={CHAT_ARTIFACTS_CLASS} aria-label={t('chat.artifacts.heading')}>
      <div className={CHAT_ARTIFACT_HEADING_CLASS}>
        <StaffdeckIcon name="folder" size={14} />
        <span>{t('chat.artifacts.heading')}</span>
      </div>
      <div className={CHAT_ARTIFACT_LIST_CLASS}>
        {artifacts.map((artifact) => {
          const identity = `${artifact.task_frame_id}\u001f${artifact.path}`;
          const filename = artifactFilename(artifact.display_name || artifact.path);
          const isDownloading = downloading === identity;
          if (isImageArtifact(artifact)) {
            return (
              <ArtifactImagePreview
                artifact={artifact}
                identity={identity}
                filename={filename}
                isDownloading={isDownloading}
                key={identity}
                tenantId={tenantId}
                sessionId={sessionId}
                locale={locale}
                t={t}
                onDownload={() => void downloadArtifact(artifact)}
              />
            );
          }
          return (
            <button
              type="button"
              className={CHAT_ARTIFACT_BUTTON_CLASS}
              key={identity}
              disabled={isDownloading || !sessionId || !tenantId}
              aria-label={t('chat.artifacts.downloadFile', { filename })}
              aria-busy={isDownloading}
              onClick={() => void downloadArtifact(artifact)}
            >
              <span className={CHAT_ARTIFACT_ICON_CLASS}>
                <StaffdeckIcon name="file" size={17} />
              </span>
              <span className={CHAT_ARTIFACT_COPY_CLASS}>
                <span className={CHAT_ARTIFACT_NAME_CLASS}>
                  <RawIdentifier value={filename} />
                </span>
                <span className={CHAT_ARTIFACT_META_CLASS}>
                  {isDownloading ? t('chat.artifacts.downloading') : artifactMeta(artifact, locale, t)}
                </span>
              </span>
              <StaffdeckIcon name="download" size={16} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

type ArtifactImagePreviewProps = {
  artifact: HarnessWorkspaceArtifact;
  identity: string;
  filename: string;
  isDownloading: boolean;
  tenantId: string;
  sessionId: string;
  locale: AppLocale;
  t: ReturnType<typeof useAppIntl>['t'];
  onDownload: () => void;
};

/** 加载图片 artifact 的预览并提供本地化下载操作，图片地址和文件名仍是 raw 标识。 */
function ArtifactImagePreview({
  artifact,
  identity,
  filename,
  isDownloading,
  tenantId,
  sessionId,
  locale,
  t,
  onDownload,
}: ArtifactImagePreviewProps) {
  const [previewUrl, setPreviewUrl] = useState('');
  const [previewFailed, setPreviewFailed] = useState(false);

  useEffect(() => {
    if (!tenantId || !sessionId) return undefined;
    let disposed = false;
    let objectUrl = '';
    setPreviewUrl('');
    setPreviewFailed(false);

    void api.blob(artifactApiPath(artifact, tenantId, sessionId))
      .then((blob) => {
        if (disposed) return;
        objectUrl = window.URL.createObjectURL(blob);
        setPreviewUrl(objectUrl);
      })
      .catch(() => {
        if (!disposed) setPreviewFailed(true);
      });

    return () => {
      disposed = true;
      if (objectUrl) window.URL.revokeObjectURL(objectUrl);
    };
  }, [artifact.path, artifact.task_frame_id, identity, sessionId, tenantId]);

  return (
    <figure className={CHAT_ARTIFACT_IMAGE_CARD_CLASS}>
      {previewUrl ? (
        <a
          className={CHAT_ARTIFACT_IMAGE_LINK_CLASS}
          href={previewUrl}
          target="_blank"
          rel="noreferrer"
          aria-label={t('chat.artifacts.viewImage', { filename })}
        >
          <img
            className={CHAT_ARTIFACT_IMAGE_CLASS}
            src={previewUrl}
            alt={filename}
            loading="lazy"
            decoding="async"
          />
        </a>
      ) : (
        <div className={CHAT_ARTIFACT_IMAGE_PLACEHOLDER_CLASS} aria-live="polite">
          {previewFailed
            ? t('chat.artifacts.previewUnavailable')
            : t('chat.artifacts.loadingImage')}
        </div>
      )}
      <figcaption className={CHAT_ARTIFACT_IMAGE_FOOTER_CLASS}>
        <span className={CHAT_ARTIFACT_COPY_CLASS}>
          <RawIdentifier className={CHAT_ARTIFACT_NAME_CLASS} value={filename} />
          <span className={CHAT_ARTIFACT_META_CLASS}>{artifactMeta(artifact, locale, t)}</span>
        </span>
        <button
          type="button"
          className={CHAT_ARTIFACT_IMAGE_DOWNLOAD_CLASS}
          disabled={isDownloading || !sessionId || !tenantId}
          aria-label={t('chat.artifacts.downloadImage', { filename })}
          aria-busy={isDownloading}
          onClick={onDownload}
        >
          <StaffdeckIcon name="download" size={16} />
        </button>
      </figcaption>
    </figure>
  );
}

function artifactApiPath(
  artifact: HarnessWorkspaceArtifact,
  tenantId: string,
  sessionId: string,
): string {
  const query = new URLSearchParams({
    tenant_id: tenantId,
    path: artifact.path,
  });
  return `/api/chat/sessions/${encodeURIComponent(sessionId)}/artifacts/`
    + `${encodeURIComponent(artifact.task_frame_id)}?${query.toString()}`;
}

/** 清理下载文件名中的路径与控制字符，返回未翻译的 raw 文件名。 */
function artifactFilename(path: string): string {
  const filename = path.replace(/\\/g, '/').split('/').pop()?.trim() || '';
  return filename.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 180);
}

function isImageArtifact(artifact: HarnessWorkspaceArtifact): boolean {
  const contentType = artifact.content_type?.toLowerCase().split(';')[0].trim();
  if (contentType?.startsWith('image/')) return true;
  return /\.(?:apng|avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(
    artifact.display_name || artifact.path,
  );
}

/** 组合 artifact 元信息；描述保持业务原文，产品 fallback 和单位由当前 locale 决定。 */
function artifactMeta(
  artifact: HarnessWorkspaceArtifact,
  locale: AppLocale,
  t: ReturnType<typeof useAppIntl>['t'],
): ReactNode {
  const size = formatArtifactSize(artifact.size, locale);
  const description = artifact.description?.trim();
  if (description && size) {
    return <RawContent value={`${description} · ${size}`} />;
  }
  if (description) return <RawContent value={description} />;
  return size
    ? t('chat.artifacts.generatedMetaWithSize', { size })
    : t('chat.artifacts.generatedMeta');
}

/** 以当前语言区域格式化 artifact 大小数字，避免业务代码固定地区或手工数字分组。 */
function formatArtifactSize(size: number | null | undefined, locale: AppLocale): string {
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return '';
  if (size < 1024) {
    return new Intl.NumberFormat(locale, {
      style: 'unit',
      unit: 'byte',
      unitDisplay: 'short',
    }).format(size);
  }
  if (size < 1024 * 1024) {
    const fractionDigits = size < 10 * 1024 ? 1 : 0;
    return new Intl.NumberFormat(locale, {
      style: 'unit',
      unit: 'kilobyte',
      unitDisplay: 'short',
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    }).format(size / 1024);
  }
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: 'megabyte',
    unitDisplay: 'short',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(size / 1024 / 1024);
}
