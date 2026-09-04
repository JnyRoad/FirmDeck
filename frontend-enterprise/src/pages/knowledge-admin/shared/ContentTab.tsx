/**
 * 知识库管理 · 详情页「内容」Tab（FR-020–FR-023、FR-070 相关横幅信息）。
 *
 * `?view=pub|<draftVersionId>` 记录当前查看的版本；正式版视图只读，文档列表来自
 * `getVersionDiff(against='base')` 中的非删除项（`kind` 为 added/modified 的文档，
 * 即该正式版相对上一正式版新增/修改的内容）；草稿视图文档列表同样来自
 * `getVersionDiff(against='base')`，但保留全部三种 `kind` 并加「草稿新增/修改/删除」
 * 标记，删除标记可通过「恢复」撤销。
 *
 * 已知限制（详见任务报告 NEEDS_CONTEXT 记录）：`getVersionDiff` 只返回与基线相比
 * 发生变化的文档，不包含未改动、原样带入的文档，也不返回文档自身的行 id，只有
 * 跨版本身份 `lineage_id`；API 层目前没有「按版本列出全部文档（含 id）」的端点。
 * 因此：(1) 正式版视图与草稿工作区列表都只能展示"已变化"的文档，无法展示未改动、
 * 原样带入的文档；(2) 本 Tab 与审阅应用（`applyReview`）在调用 `updateDocument`/
 * `archiveDocument` 时把 `lineage_id` 当作文档 id 传入——这对"本草稿内新建"的文档
 * 是准确的（新建文档的 lineage_id 就是其自身 id），但对"跨版本克隆而来的已改动
 * 文档"并不准确（克隆会分配新的行 id，只在 metadata 中保留原始 lineage_id）。
 * 后续需要后端在对比响应中补充文档 id，或提供按版本列出文档（含 id）的端点。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { DataTable, type DataTableColumn } from '@/components/DataTable';
import { Dialog, DialogContent, DialogTitle, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { createToastNotifier, notify } from '@/components/ui/app-toast';
import { useAppIntl } from '@/i18n';
import { createMessageDescriptor } from '@/i18n/descriptors';
import { RawContent } from '@/i18n/RawContent';
import { apiErrorCode } from '@/lib/apiErrorMessages';
import {
  DIALOG_CANCEL_BUTTON_CLASS,
  DIALOG_FOOTER_CLASS,
  OUTLINE_ACTION_BUTTON_SM_CLASS,
  SELECT_TRIGGER_CLASS,
} from '@/lib/enterprise-ui';
import { cn } from '@/lib/utils';
import type { KnowledgeAdminApi } from '@/api/knowledgeAdmin';
import type { KnowledgeBaseRead } from '@/types';
import type { DiffDocument, KnowledgeAdminVersionRead, VersionDiff } from '@/types/knowledgeAdmin';

import { CreateDraftDialog } from '../dialogs/CreateDraftDialog';
import { PublishDialog, type PublishDialogSubmitInput } from '../dialogs/PublishDialog';
import { formatVersion } from '../knowledgeAdminModel';
import {
  ReviewEditor,
  type ReviewEditorDocumentInput,
  type ReviewEditorLabels,
  type ReviewEditorOutput,
} from '../review/ReviewEditor';
import { knowledgeAdminErrorMessage } from './errorMessage';

export type ContentTabProps = {
  api: KnowledgeAdminApi;
  kb: KnowledgeBaseRead;
  onChanged?: () => void;
};

const PUB_VIEW = 'pub';

const BADGE_MESSAGE_IDS: Record<DiffDocument['kind'], 'knowledgeAdmin.content.badges.added' | 'knowledgeAdmin.content.badges.modified' | 'knowledgeAdmin.content.badges.deleted'> = {
  added: 'knowledgeAdmin.content.badges.added',
  modified: 'knowledgeAdmin.content.badges.modified',
  deleted: 'knowledgeAdmin.content.badges.deleted',
};

/** 把 modified 文档的 hunks 顺序拼接还原为整篇 base/target 正文；added/deleted 无正文可还原。 */
function reconstructContent(document: DiffDocument): { base: string; current: string } {
  if (document.kind !== 'modified' || !document.hunks) return { base: '', current: '' };
  const base: string[] = [];
  const current: string[] = [];
  for (const hunk of document.hunks) {
    base.push(...hunk.base_lines);
    current.push(...hunk.target_lines);
  }
  return { base: base.join('\n'), current: current.join('\n') };
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const commaIndex = result.indexOf(',');
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** 共享库内容 Tab：正式版只读浏览 + 草稿工作区（新增/修改/删除 + 恢复）+ 审阅打开与写回。 */
export function ContentTab({ api, kb, onChanged }: ContentTabProps) {
  const { t } = useAppIntl();
  const [searchParams, setSearchParams] = useSearchParams();
  const fileInputRef = useRef<HTMLInputElement>(null);
  // `notify.error` (legacy facade) only ever shows a registered stable error code's mapped
  // text or a generic fallback — it deliberately drops arbitrary pre-localized strings (see
  // app-toast.test.tsx "keeps registered legacy error-code compatibility"). The publish-
  // conflict message here is a specific, contract-required string (not a backend error code),
  // so it goes through the descriptor-based notifier instead of `notify.error(t(...))`.
  const toastNotifier = useMemo(() => createToastNotifier({ t }), [t]);

  const [versions, setVersions] = useState<KnowledgeAdminVersionRead[]>([]);
  const [diff, setDiff] = useState<VersionDiff | null>(null);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  const [publishOpen, setPublishOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);

  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectReasonError, setRejectReasonError] = useState(false);
  const [rejecting, setRejecting] = useState(false);

  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewReturnToPublish, setReviewReturnToPublish] = useState(false);
  const [reviewOutput, setReviewOutput] = useState<ReviewEditorOutput | null>(null);
  const [applying, setApplying] = useState(false);

  const view = searchParams.get('view') || PUB_VIEW;
  const draftVersions = useMemo(
    () => versions.filter((version) => version.publication_state === 'draft'),
    [versions],
  );
  const currentDraft = view === PUB_VIEW ? null : versions.find((version) => version.id === view) || null;
  const isDraftView = view !== PUB_VIEW && Boolean(currentDraft);
  const targetVersionId = isDraftView ? currentDraft!.id : kb.published_version_id || null;

  async function loadVersions() {
    try {
      const result = await api.listVersions(kb.id);
      setVersions(Array.isArray(result) ? result : []);
    } catch (error) {
      notify.error(knowledgeAdminErrorMessage(error, 'knowledgeAdmin.toast.loadFailed', { t }));
    }
  }

  async function loadDiff() {
    if (!targetVersionId) {
      setDiff(null);
      return;
    }
    setLoadingDiff(true);
    try {
      const result = await api.getVersionDiff(kb.id, targetVersionId, { against: 'base' });
      setDiff(result);
    } catch (error) {
      notify.error(knowledgeAdminErrorMessage(error, 'knowledgeAdmin.toast.loadFailed', { t }));
    } finally {
      setLoadingDiff(false);
    }
  }

  useEffect(() => {
    void loadVersions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, kb.id]);

  useEffect(() => {
    void loadDiff();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, kb.id, targetVersionId]);

  // 从版本 Tab 的发布框点「去审阅」会带 `?tab=content&view=<id>&publish=<id>&review=1`
  // 跳到本 Tab（版本 Tab 自身的发布框状态在切 Tab 时被卸载，无法直接保留）；
  // 这里在草稿视图数据就绪后据此显式打开审阅框（`reviewReturnToPublish=true`），
  // 应用后自动回到本 Tab 自己渲染的发布框（同一份草稿）。只消费一次，随后清掉这两个
  // 意图参数，避免用户后续手动关闭/重开审阅框时被重复触发。
  const consumedReviewIntentRef = useRef(false);
  useEffect(() => {
    if (consumedReviewIntentRef.current) return;
    if (!currentDraft || loadingDiff) return;
    const wantsReview = searchParams.get('review') === '1' && searchParams.get('publish') === currentDraft.id;
    if (!wantsReview) return;
    consumedReviewIntentRef.current = true;
    openReview(true);
    const params = new URLSearchParams(searchParams);
    params.delete('review');
    params.delete('publish');
    setSearchParams(params, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentDraft, loadingDiff, searchParams]);

  function setView(next: string) {
    const params = new URLSearchParams(searchParams);
    if (next === PUB_VIEW) params.delete('view');
    else params.set('view', next);
    setSearchParams(params, { replace: true });
  }

  const visibleDocuments = useMemo(() => {
    if (!diff) return [];
    if (isDraftView) return diff.documents;
    // 正式版视图：仅展示该正式版相对上一正式版新增/修改的内容，且始终只读；
    // 因为这里对比的目标本身就是已发布版本，不会包含任何草稿的改动。
    return diff.documents.filter((document) => document.kind !== 'deleted');
  }, [diff, isDraftView]);

  async function handleUploadFile(file: File) {
    if (!currentDraft) return;
    setUploading(true);
    try {
      const contentBase64 = await fileToBase64(file);
      await api.uploadDocument({
        knowledgeBaseVersionId: currentDraft.id,
        filename: file.name,
        contentBase64,
        title: file.name,
      });
      notify.successText(t('knowledgeAdmin.toast.uploadSuccess'));
      await loadDiff();
      onChanged?.();
    } catch (error) {
      notify.error(knowledgeAdminErrorMessage(error, 'knowledgeAdmin.toast.updateError', { t }));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function handleDeleteDocument(document: DiffDocument) {
    if (!currentDraft) return;
    setRestoringId(document.lineage_id);
    try {
      await api.archiveDocument(document.lineage_id, {});
      notify.successText(t('knowledgeAdmin.toast.archiveDocumentSuccess'));
      await loadDiff();
      onChanged?.();
    } catch (error) {
      notify.error(knowledgeAdminErrorMessage(error, 'knowledgeAdmin.toast.deleteError', { t }));
    } finally {
      setRestoringId(null);
    }
  }

  async function handleRestoreDocument(document: DiffDocument) {
    if (!currentDraft) return;
    setRestoringId(document.lineage_id);
    try {
      await api.updateDocument(document.lineage_id, { status: 'ready' });
      notify.successText(t('knowledgeAdmin.toast.restoreDocumentSuccess'));
      await loadDiff();
      onChanged?.();
    } catch (error) {
      notify.error(knowledgeAdminErrorMessage(error, 'knowledgeAdmin.toast.updateError', { t }));
    } finally {
      setRestoringId(null);
    }
  }

  async function handleCreateDraft(input: { changeReason: string }) {
    setCreating(true);
    try {
      const created = await api.createDraft(kb.id, {
        teamId: null,
        changeReason: input.changeReason,
        expectedPublishedVersionId: kb.published_version_id ?? undefined,
      });
      notify.successText(t('knowledgeAdmin.toast.createDraftSuccess'));
      setCreateOpen(false);
      await loadVersions();
      setView(created.id);
      onChanged?.();
    } catch (error) {
      notify.error(knowledgeAdminErrorMessage(error, 'knowledgeAdmin.toast.createError', { t }));
    } finally {
      setCreating(false);
    }
  }

  async function handlePublish(input: PublishDialogSubmitInput) {
    if (!currentDraft) return;
    setPublishing(true);
    try {
      await api.publishDraft(kb.id, currentDraft.id, {
        teamId: currentDraft.source_team_id ?? null,
        expectedPublishedVersionId: kb.published_version_id ?? currentDraft.parent_version_id ?? '',
        changeReason: input.changeReason,
        level: input.level,
        forceOverwrite: input.forceOverwrite,
      });
      notify.successText(t('knowledgeAdmin.toast.publishSuccess'));
      setPublishOpen(false);
      setView(PUB_VIEW);
      await loadVersions();
      onChanged?.();
    } catch (error) {
      notify.error(knowledgeAdminErrorMessage(error, 'knowledgeAdmin.toast.updateError', { t }));
    } finally {
      setPublishing(false);
    }
  }

  async function handleReject() {
    if (!currentDraft) return;
    const trimmed = rejectReason.trim();
    if (!trimmed) {
      setRejectReasonError(true);
      return;
    }
    setRejecting(true);
    try {
      await api.rejectDraft(kb.id, currentDraft.id, {
        teamId: currentDraft.source_team_id ?? null,
        changeReason: trimmed,
      });
      notify.successText(t('knowledgeAdmin.toast.rejectSuccess'));
      setRejectOpen(false);
      setView(PUB_VIEW);
      await loadVersions();
      onChanged?.();
    } catch (error) {
      notify.error(knowledgeAdminErrorMessage(error, 'knowledgeAdmin.toast.updateError', { t }));
    } finally {
      setRejecting(false);
    }
  }

  function openReview(returnToPublish: boolean) {
    setPublishOpen(false);
    setReviewReturnToPublish(returnToPublish);
    setReviewOpen(true);
  }

  const reviewDocuments: ReviewEditorDocumentInput[] = useMemo(() => {
    if (!diff) return [];
    return diff.documents.map((document) => {
      const { base, current } = reconstructContent(document);
      return { lineageId: document.lineage_id, title: document.title, kind: document.kind, base, current };
    });
  }, [diff]);

  const reviewLabels: ReviewEditorLabels = {
    pendingLabel: t('knowledgeAdmin.content.review.labels.pending'),
    stagedLabel: t('knowledgeAdmin.content.review.labels.staged'),
    allReviewedLabel: t('knowledgeAdmin.content.review.labels.allReviewed'),
    acceptButton: t('knowledgeAdmin.content.review.labels.accept'),
    unacceptButton: t('knowledgeAdmin.content.review.labels.unaccept'),
    rejectButton: t('knowledgeAdmin.content.review.labels.reject'),
    acceptAllButton: t('knowledgeAdmin.content.review.labels.acceptAll'),
    rejectAllButton: t('knowledgeAdmin.content.review.labels.rejectAll'),
    resetButton: t('knowledgeAdmin.content.review.labels.reset'),
    restoreLineAria: t('knowledgeAdmin.content.review.labels.restoreLineAria'),
    deleteLineAria: t('knowledgeAdmin.content.review.labels.deleteLineAria'),
    revertSelectionButton: t('knowledgeAdmin.content.review.labels.revertSelection'),
    rejectDocButton: t('knowledgeAdmin.content.review.labels.rejectDoc'),
    restoreDocButton: t('knowledgeAdmin.content.review.labels.restoreDoc'),
    stagedBadge: t('knowledgeAdmin.content.review.labels.stagedBadge'),
    addedDocBadge: t('knowledgeAdmin.content.review.labels.addedDocBadge'),
    modifiedDocBadge: t('knowledgeAdmin.content.review.labels.modifiedDocBadge'),
    deletedDocBadge: t('knowledgeAdmin.content.review.labels.deletedDocBadge'),
  };

  async function applyReview() {
    if (!reviewOutput || !currentDraft) return;
    setApplying(true);
    try {
      for (const document of reviewOutput.docs) {
        if (document.kind === 'modified') {
          await api.updateDocument(document.lineageId, {
            contentMd: document.lines.join('\n'),
            expectedUpdatedAt: currentDraft.updated_at,
          });
        } else if (document.kind === 'added' && document.restore) {
          // WholeDocumentPanel: added 文档 restore=true 表示用户拒绝了这次新增。
          await api.archiveDocument(document.lineageId, { expectedUpdatedAt: currentDraft.updated_at });
        } else if (document.kind === 'deleted' && document.restore) {
          // WholeDocumentPanel: deleted 文档 restore=true 表示用户拒绝了这次删除（恢复原文）。
          await api.updateDocument(document.lineageId, {
            status: 'ready',
            expectedUpdatedAt: currentDraft.updated_at,
          });
        }
      }
      await api.recordReview(kb.id, currentDraft.id, {
        staged: reviewOutput.stagedCount,
        pending: reviewOutput.pendingCount,
        documentsAdjusted: reviewOutput.docs.filter((document) => document.staged.length > 0 || document.restore).length,
        expectedUpdatedAt: currentDraft.updated_at,
      });
      notify.successText(t('knowledgeAdmin.toast.applyReviewSuccess'));
      setReviewOpen(false);
      await Promise.all([loadVersions(), loadDiff()]);
      onChanged?.();
      if (reviewReturnToPublish) setPublishOpen(true);
      setReviewReturnToPublish(false);
    } catch (error) {
      if (apiErrorCode(error) === 'KNOWLEDGE_PUBLISH_CONFLICT') {
        toastNotifier.error(createMessageDescriptor('knowledgeAdmin.content.review.applyConflict'));
      } else {
        notify.error(knowledgeAdminErrorMessage(error, 'knowledgeAdmin.toast.updateError', { t }));
      }
    } finally {
      setApplying(false);
    }
  }

  const columns: DataTableColumn<DiffDocument>[] = [
    {
      key: 'title',
      title: t('knowledgeAdmin.content.table.title'),
      render: (row) => <RawContent value={row.title} />,
    },
    {
      key: 'status',
      title: t('knowledgeAdmin.content.table.status'),
      width: 140,
      render: (row) =>
        isDraftView ? (
          <span className="rounded-full bg-[#eef2f7] px-[8px] py-[2px] text-[11px] font-medium text-[#596174]">
            {t(BADGE_MESSAGE_IDS[row.kind])}
          </span>
        ) : null,
    },
    ...(isDraftView
      ? [
          {
            key: 'actions',
            title: t('knowledgeAdmin.content.table.actions'),
            width: 120,
            align: 'right' as const,
            render: (row: DiffDocument) =>
              row.kind === 'deleted' ? (
                <Button
                  variant="outline"
                  disabled={restoringId === row.lineage_id}
                  onClick={() => void handleRestoreDocument(row)}
                  className={OUTLINE_ACTION_BUTTON_SM_CLASS}
                >
                  {t('knowledgeAdmin.content.actions.restore')}
                </Button>
              ) : (
                <Button
                  variant="outline"
                  disabled={restoringId === row.lineage_id}
                  onClick={() => void handleDeleteDocument(row)}
                  className={OUTLINE_ACTION_BUTTON_SM_CLASS}
                >
                  {t('knowledgeAdmin.content.actions.delete')}
                </Button>
              ),
          },
        ]
      : []),
  ];

  return (
    <div className="flex flex-col gap-[14px]">
      <div className="flex flex-wrap items-center gap-[10px]">
        <span className="text-[12px] font-medium text-[#464c5e]">{t('knowledgeAdmin.content.viewSwitcher.label')}</span>
        <Select value={view} onValueChange={setView}>
          <SelectTrigger className={cn(SELECT_TRIGGER_CLASS, 'w-[220px]')} aria-label={t('knowledgeAdmin.content.viewSwitcher.label')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={PUB_VIEW}>{t('knowledgeAdmin.content.viewSwitcher.published')}</SelectItem>
            {draftVersions.map((version) => (
              <SelectItem key={version.id} value={version.id}>
                {t('knowledgeAdmin.content.viewSwitcher.draftOption', { name: version.draft_name || version.version })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {!isDraftView && (
        <div className="flex items-center justify-between rounded-[12px] border-[0.5px] border-[#e3e7f1] bg-[#f7f8fa] px-[14px] py-[10px]">
          <p className="text-[12px] text-[#858b9c]">{t('knowledgeAdmin.content.readonlyNotice')}</p>
          <Button onClick={() => setCreateOpen(true)} className={OUTLINE_ACTION_BUTTON_SM_CLASS}>
            {t('knowledgeAdmin.content.actions.createDraft')}
          </Button>
        </div>
      )}

      {isDraftView && currentDraft && (
        <div className="flex flex-col gap-[8px] rounded-[12px] border-[0.5px] border-[#e3e7f1] bg-white px-[14px] py-[12px]">
          <div className="flex flex-wrap items-center gap-[10px] text-[12px] text-[#464c5e]">
            <span>{t('knowledgeAdmin.content.banner.createdBy', { name: currentDraft.created_by_user_id || currentDraft.created_by_agent_id || '' })}</span>
            <span>
              {t('knowledgeAdmin.content.banner.source', {
                source: currentDraft.source_team_id ? currentDraft.source_team_id : t('knowledgeAdmin.content.banner.sourceAdmin'),
              })}
            </span>
            <span>{t('knowledgeAdmin.content.banner.baseVersion', { version: formatVersion(currentDraft.base_version) })}</span>
            <span>
              {t('knowledgeAdmin.content.banner.nextVersion', {
                version: formatVersion(currentDraft.next_version_preview?.patch),
              })}
            </span>
            {currentDraft.is_stale && (
              <span className="rounded-full bg-[#fce7e7] px-[8px] py-[2px] text-[11px] font-medium text-[#d20b0b]">
                {t('knowledgeAdmin.detail.badges.stale')}
              </span>
            )}
          </div>
          {currentDraft.change_reason && (
            <p className="text-[12px] text-[#858b9c]">
              {t('knowledgeAdmin.content.banner.reason', { reason: currentDraft.change_reason })}
            </p>
          )}
          <div className="flex flex-wrap gap-[8px]">
            <Button variant="outline" onClick={() => openReview(false)} className={OUTLINE_ACTION_BUTTON_SM_CLASS}>
              {t('knowledgeAdmin.content.actions.viewChanges')}
            </Button>
            <Button variant="outline" onClick={() => setPublishOpen(true)} className={OUTLINE_ACTION_BUTTON_SM_CLASS}>
              {t('knowledgeAdmin.content.actions.publish')}
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setRejectReason('');
                setRejectReasonError(false);
                setRejectOpen(true);
              }}
              className={OUTLINE_ACTION_BUTTON_SM_CLASS}
            >
              {t('knowledgeAdmin.content.actions.reject')}
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              data-testid="content-upload-input"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void handleUploadFile(file);
              }}
            />
            <Button
              disabled={uploading}
              onClick={() => fileInputRef.current?.click()}
              className={cn(OUTLINE_ACTION_BUTTON_SM_CLASS, 'bg-[#18181a] text-white hover:bg-[#303030] hover:text-white')}
            >
              {t('knowledgeAdmin.content.actions.upload')}
            </Button>
          </div>
        </div>
      )}

      <DataTable
        columns={columns}
        data={visibleDocuments}
        rowKey={(row) => row.lineage_id}
        loading={loadingDiff}
        emptyText={t('knowledgeAdmin.content.empty')}
        aria-label={t('knowledgeAdmin.detail.tabs.content')}
      />

      <CreateDraftDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        submitting={creating}
        onSubmit={(input) => void handleCreateDraft(input)}
      />

      <PublishDialog
        open={publishOpen}
        onOpenChange={setPublishOpen}
        api={api}
        kbId={kb.id}
        draft={currentDraft}
        submitting={publishing}
        onSubmit={(input) => void handlePublish(input)}
        onRebase={() => toastNotifier.error(createMessageDescriptor('knowledgeAdmin.dialogs.publish.rebaseNotAvailable'))}
        onReview={() => openReview(true)}
      />

      <Dialog open={rejectOpen} onOpenChange={(next) => !rejecting && setRejectOpen(next)}>
        <DialogContent className="w-[min(440px,calc(100vw-32px))] gap-0 overflow-hidden rounded-[16px] border-0 bg-white p-0 shadow-[0px_12px_32px_rgba(0,0,0,0.16)]">
          <DialogTitle className="px-[24px] pt-[20px] pb-[12px] text-[16px] font-semibold text-[#18181a]">
            {t('knowledgeAdmin.content.rejectDialog.title')}
          </DialogTitle>
          <div className="flex flex-col gap-[6px] px-[24px] pb-[16px]">
            <span className="text-[12px] font-medium text-[#464c5e]">{t('knowledgeAdmin.content.rejectDialog.reasonLabel')}</span>
            <Textarea
              value={rejectReason}
              disabled={rejecting}
              aria-invalid={rejectReasonError}
              aria-label={t('knowledgeAdmin.content.rejectDialog.reasonLabel')}
              onChange={(event) => {
                setRejectReason(event.target.value);
                setRejectReasonError(false);
              }}
            />
            {rejectReasonError && (
              <span role="alert" className="text-[12px] text-[#d20b0b]">
                {t('knowledgeAdmin.content.rejectDialog.reasonRequired')}
              </span>
            )}
          </div>
          <div className={DIALOG_FOOTER_CLASS}>
            <Button variant="outline" disabled={rejecting} onClick={() => setRejectOpen(false)} className={DIALOG_CANCEL_BUTTON_CLASS}>
              {t('knowledgeAdmin.content.rejectDialog.cancel')}
            </Button>
            <Button disabled={rejecting} onClick={() => void handleReject()} className="h-[32px] min-w-[80px] rounded-[10px] bg-[#d20b0b] px-[12px] text-[14px] font-normal text-white hover:bg-[#b80909]">
              {t('knowledgeAdmin.content.rejectDialog.confirm')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={reviewOpen} onOpenChange={(next) => !applying && setReviewOpen(next)}>
        <DialogContent className="w-[min(900px,calc(100vw-32px))] gap-0 overflow-hidden rounded-[16px] border-0 bg-white p-0 shadow-[0px_12px_32px_rgba(0,0,0,0.16)]">
          <DialogTitle className="px-[24px] pt-[20px] pb-[12px] text-[16px] font-semibold text-[#18181a]">
            {t('knowledgeAdmin.content.review.title')}
          </DialogTitle>
          <div className="max-h-[70vh] overflow-y-auto px-[24px] pb-[16px]">
            <ReviewEditor documents={reviewDocuments} labels={reviewLabels} onChange={setReviewOutput} />
          </div>
          <div className={DIALOG_FOOTER_CLASS}>
            <Button variant="outline" disabled={applying} onClick={() => setReviewOpen(false)} className={DIALOG_CANCEL_BUTTON_CLASS}>
              {t('knowledgeAdmin.content.review.cancel')}
            </Button>
            <Button
              disabled={applying || !reviewOutput || reviewOutput.pendingCount > 0}
              onClick={() => void applyReview()}
              className="h-[32px] min-w-[100px] rounded-[10px] bg-[#18181a] px-[12px] text-[14px] font-normal text-white hover:bg-[#303030]"
            >
              {t('knowledgeAdmin.content.review.apply')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
