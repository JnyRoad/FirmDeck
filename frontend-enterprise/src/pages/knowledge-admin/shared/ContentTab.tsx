/**
 * 知识库管理 · 详情页「内容」Tab（FR-020–FR-023、FR-070 相关横幅信息）。
 *
 * `?view=pub|<draftVersionId>` 记录当前查看的版本；正式版视图只读，文档列表来自
 * `getVersionDiff(against='base')` 中的非删除项（`kind` 为 added/modified 的文档，
 * 即该正式版相对上一正式版新增/修改的内容）。
 *
 * 草稿工作区列表改用 A2b `listVersionDocuments(kb.id, currentDraft.id)`（T081，含未改动、
 * 原样带入的文档，携带真实行 `id`）为主数据源，`getVersionDiff` 只用来给每行按
 * `lineage_id` 配上「草稿新增/修改/删除」标记（`kindByLineage`）；未出现在本次对比里的
 * 行标记为 `unchanged`，不显示标记但同样可删除。
 *
 * 写回定位（T083，修复原「已知限制」）：本 Tab 与审阅应用（`applyReview`）调用
 * `updateDocument`/`archiveDocument` 一律用 `documentIdByLineage`（源自
 * `listVersionDocuments` 的 `lineage_id → id` 映射）解析出的真实行 id，不再把
 * `lineage_id` 当作文档 id 传入——`lineage_id` 对"本草稿内新建"的文档恰好等于其自身
 * id，但对"跨版本克隆而来的已改动文档"并不准确（克隆会分配新的行 id，只在 metadata
 * 中保留原始 lineage_id）。`listVersionDocuments` 同时包含已被删除（`status='archived'`）
 * 的行，因此"恢复已删除文档"也能拿到真实 id——这是 `getVersionDiff` 的
 * `target_document_id` 做不到的：对 `kind==='deleted'` 的文档它恒为 `null`（该文档在
 * target 里已没有 ready 状态的对应行，但底层归档行本身仍在，只是不出现在 diff 里）。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { DataTable, type DataTableColumn } from '@/components/DataTable';
import { Dialog, DialogContent, DialogTitle, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea } from '@/components/ui';
import { Button } from '@/components/ui/button';
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
import type { DiffDocument, KnowledgeAdminVersionRead, RebaseResult, VersionDiff, VersionDocument } from '@/types/knowledgeAdmin';

import { CreateDraftDialog } from '../dialogs/CreateDraftDialog';
import { PublishDialog, type PublishDialogSubmitInput } from '../dialogs/PublishDialog';
import { RebaseDialog } from '../dialogs/RebaseDialog';
import { formatVersion } from '../knowledgeAdminModel';
import {
  ReviewEditor,
  type ReviewEditorDocumentInput,
  type ReviewEditorLabels,
  type ReviewEditorOutput,
} from '../review/ReviewEditor';
import { useKnowledgeAdminToast } from './errorMessage';

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

/**
 * 表格行的统一视图：`documentId` 一律是可直接用于写回（`updateDocument`/`archiveDocument`）
 * 的真实行 id——正式版视图来自 diff 的 `target_document_id`（只读，不发起写回，取不到时
 * 退回 `lineage_id` 仅作展示 key）；草稿视图来自 `listVersionDocuments` 的 `id`（见文件头
 * 注释）。`kind==='unchanged'` 表示该文档未出现在与基线的对比里，不显示标记。
 */
type ContentRow = {
  documentId: string;
  title: string;
  kind: DiffDocument['kind'] | 'unchanged';
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
  const toast = useKnowledgeAdminToast();

  const [versions, setVersions] = useState<KnowledgeAdminVersionRead[]>([]);
  const [versionsLoaded, setVersionsLoaded] = useState(false);
  const [diff, setDiff] = useState<VersionDiff | null>(null);
  const [versionDocuments, setVersionDocuments] = useState<VersionDocument[]>([]);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  const [publishOpen, setPublishOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);

  const [rebaseOpen, setRebaseOpen] = useState(false);
  const [rebaseTarget, setRebaseTarget] = useState<KnowledgeAdminVersionRead | null>(null);

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
      setVersionsLoaded(true);
    } catch (error) {
      toast.error(error, 'knowledgeAdmin.toast.loadFailed');
      // `currentDraft` can never resolve if the version list failed to load — without
      // this, a pending `publish=<id>&review=1` review-intent would linger in the URL
      // forever (the intent-consuming effect below never sees a matching draft).
      clearReviewIntentParams();
    }
  }

  async function loadDiff() {
    if (!targetVersionId) {
      setDiff(null);
      setVersionDocuments([]);
      return;
    }
    setLoadingDiff(true);
    try {
      // 草稿视图额外拉取 A2b 全量文档列表（含未改动的，携带真实行 id），供写回定位与
      // "未改动文档也展示"用；正式版视图只读、不发起写回，不需要这份数据。
      const [diffResult, documentsResult] = await Promise.all([
        api.getVersionDiff(kb.id, targetVersionId, { against: 'base' }),
        isDraftView ? api.listVersionDocuments(kb.id, targetVersionId) : Promise.resolve<VersionDocument[]>([]),
      ]);
      setDiff(diffResult);
      setVersionDocuments(Array.isArray(documentsResult) ? documentsResult : []);
    } catch (error) {
      toast.error(error, 'knowledgeAdmin.toast.loadFailed');
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

  /** 清掉 `publish`/`review` 两个意图参数但不打开审阅框（草稿加载失败/草稿已不存在时）。 */
  function clearReviewIntentParams() {
    if (consumedReviewIntentRef.current) return;
    if (!searchParams.get('review') && !searchParams.get('publish')) return;
    consumedReviewIntentRef.current = true;
    const params = new URLSearchParams(searchParams);
    params.delete('review');
    params.delete('publish');
    setSearchParams(params, { replace: true });
  }

  useEffect(() => {
    if (consumedReviewIntentRef.current) return;
    const publishIntentId = searchParams.get('publish');
    const wantsReview = searchParams.get('review') === '1' && Boolean(publishIntentId);
    if (!wantsReview) return;

    // 版本列表已加载但意图指向的草稿不存在（例如已被他人发布/驳回）：清掉参数，不打开审阅框。
    if (versionsLoaded && !versions.some((version) => version.id === publishIntentId)) {
      clearReviewIntentParams();
      return;
    }

    if (!currentDraft) return;
    // 不能只靠 `loadingDiff`（见 fix round 2 报告的竞态分析）：`targetVersionId` 从正式版
    // 切到本草稿的那次渲染里，`loadDiff` effect 调用 `setLoadingDiff(true)` 属于"本次渲染
    // 提交后才生效"的新一轮 state，本 effect 在同一批渲染里读到的仍是旧闭包里的
    // `loadingDiff===false`，而 `diff` 这时可能还是上一个目标（例如正式版）的对比结果。
    // 因此直接判断已加载的 `diff` 是否确实属于当前草稿，而不是判断 `loadingDiff` 是否为 false。
    if (!diff || diff.target_version_id !== currentDraft.id) return;

    consumedReviewIntentRef.current = true;
    openReview(true);
    const params = new URLSearchParams(searchParams);
    params.delete('review');
    params.delete('publish');
    setSearchParams(params, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentDraft, diff, versions, versionsLoaded, searchParams]);

  function setView(next: string) {
    const params = new URLSearchParams(searchParams);
    if (next === PUB_VIEW) params.delete('view');
    else params.set('view', next);
    setSearchParams(params, { replace: true });
  }

  // `lineage_id → kind`：仅覆盖 diff 里出现过的（已变化的）文档；草稿视图里没出现在这里
  // 的行按 `unchanged` 处理。
  const kindByLineage = useMemo(() => {
    const map = new Map<string, DiffDocument['kind']>();
    if (diff) for (const document of diff.documents) map.set(document.lineage_id, document.kind);
    return map;
  }, [diff]);

  // `lineage_id → 真实行 id`：草稿视图写回定位的唯一来源，见文件头注释。
  const documentIdByLineage = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of versionDocuments) {
      if (row.lineage_id) map.set(row.lineage_id, row.id);
    }
    return map;
  }, [versionDocuments]);

  const visibleDocuments: ContentRow[] = useMemo(() => {
    if (!diff) return [];
    if (!isDraftView) {
      // 正式版视图：仅展示该正式版相对上一正式版新增/修改的内容，且始终只读；
      // 因为这里对比的目标本身就是已发布版本，不会包含任何草稿的改动。
      return diff.documents
        .filter((document) => document.kind !== 'deleted')
        .map((document) => ({
          documentId: document.target_document_id ?? document.lineage_id,
          title: document.title,
          kind: document.kind,
        }));
    }
    // 草稿视图：以 `listVersionDocuments` 全量列表为主（含未改动、已删除的行，真实 id），
    // 按 lineage_id 配上 diff 算出的「新增/修改/删除」标记；未变化的行标记为 unchanged。
    return versionDocuments.map((row) => ({
      documentId: row.id,
      title: row.title,
      kind: (row.lineage_id ? kindByLineage.get(row.lineage_id) : undefined) ?? 'unchanged',
    }));
  }, [diff, isDraftView, versionDocuments, kindByLineage]);

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
      toast.success(createMessageDescriptor('knowledgeAdmin.toast.uploadSuccess'));
      await loadDiff();
      onChanged?.();
    } catch (error) {
      toast.error(error, 'knowledgeAdmin.toast.updateError');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function handleDeleteDocument(row: ContentRow) {
    if (!currentDraft) return;
    setRestoringId(row.documentId);
    try {
      await api.archiveDocument(row.documentId, {});
      toast.success(createMessageDescriptor('knowledgeAdmin.toast.archiveDocumentSuccess'));
      await loadDiff();
      onChanged?.();
    } catch (error) {
      toast.error(error, 'knowledgeAdmin.toast.deleteError');
    } finally {
      setRestoringId(null);
    }
  }

  async function handleRestoreDocument(row: ContentRow) {
    if (!currentDraft) return;
    setRestoringId(row.documentId);
    try {
      await api.updateDocument(row.documentId, { status: 'ready' });
      toast.success(createMessageDescriptor('knowledgeAdmin.toast.restoreDocumentSuccess'));
      await loadDiff();
      onChanged?.();
    } catch (error) {
      toast.error(error, 'knowledgeAdmin.toast.updateError');
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
      toast.success(createMessageDescriptor('knowledgeAdmin.toast.createDraftSuccess'));
      setCreateOpen(false);
      await loadVersions();
      setView(created.id);
      onChanged?.();
    } catch (error) {
      toast.error(error, 'knowledgeAdmin.toast.createError');
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
      toast.success(createMessageDescriptor('knowledgeAdmin.toast.publishSuccess'));
      setPublishOpen(false);
      setView(PUB_VIEW);
      await loadVersions();
      onChanged?.();
    } catch (error) {
      toast.error(error, 'knowledgeAdmin.toast.updateError');
    } finally {
      setPublishing(false);
    }
  }

  // 变基落库（无冲突直接落库，或解决冲突后落库）后：旧草稿快照已被 `superseded_by` 替换，
  // 关掉发布框与变基框，把视图切到新草稿快照，并重新拉取版本列表（新快照才会出现在其中）。
  function handleRebased(result: RebaseResult) {
    setRebaseOpen(false);
    setPublishOpen(false);
    setView(result.new_version.id);
    void loadVersions();
    onChanged?.();
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
      toast.success(createMessageDescriptor('knowledgeAdmin.toast.rejectSuccess'));
      setRejectOpen(false);
      setView(PUB_VIEW);
      await loadVersions();
      onChanged?.();
    } catch (error) {
      toast.error(error, 'knowledgeAdmin.toast.updateError');
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
        // 写回一律用 `documentIdByLineage` 解析出的真实行 id，不用 `document.lineageId`
        // 本身——对跨版本克隆而来的行两者并不相等（见文件头注释）；映射缺失时退回
        // lineageId 仅作兜底（例如本草稿内新建、克隆前的极端时序），不阻塞写回。
        const documentId = documentIdByLineage.get(document.lineageId) ?? document.lineageId;
        if (document.kind === 'modified') {
          await api.updateDocument(documentId, {
            contentMd: document.lines.join('\n'),
            expectedUpdatedAt: currentDraft.updated_at,
          });
        } else if (document.kind === 'added' && document.restore) {
          // WholeDocumentPanel: added 文档 restore=true 表示用户拒绝了这次新增。
          await api.archiveDocument(documentId, { expectedUpdatedAt: currentDraft.updated_at });
        } else if (document.kind === 'deleted' && document.restore) {
          // WholeDocumentPanel: deleted 文档 restore=true 表示用户拒绝了这次删除（恢复原文）。
          await api.updateDocument(documentId, {
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
      toast.success(createMessageDescriptor('knowledgeAdmin.toast.applyReviewSuccess'));
      setReviewOpen(false);
      await Promise.all([loadVersions(), loadDiff()]);
      onChanged?.();
      if (reviewReturnToPublish) setPublishOpen(true);
      setReviewReturnToPublish(false);
    } catch (error) {
      if (apiErrorCode(error) === 'KNOWLEDGE_PUBLISH_CONFLICT') {
        // 这里比契约默认的 `errors.knowledge.publishConflict` 文案更具体（"应用审阅"场景专属
        // 措辞），跳过错误码→契约映射直接显示。
        toast.errorDescriptor(createMessageDescriptor('knowledgeAdmin.content.review.applyConflict'));
      } else {
        toast.error(error, 'knowledgeAdmin.toast.updateError');
      }
    } finally {
      setApplying(false);
    }
  }

  const columns: DataTableColumn<ContentRow>[] = [
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
        isDraftView && row.kind !== 'unchanged' ? (
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
            render: (row: ContentRow) =>
              row.kind === 'deleted' ? (
                <Button
                  variant="outline"
                  disabled={restoringId === row.documentId}
                  onClick={() => void handleRestoreDocument(row)}
                  className={OUTLINE_ACTION_BUTTON_SM_CLASS}
                >
                  {t('knowledgeAdmin.content.actions.restore')}
                </Button>
              ) : (
                <Button
                  variant="outline"
                  disabled={restoringId === row.documentId}
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
          {currentDraft.is_stale && (
            <p className="text-[12px] text-[#d20b0b]">
              {t('knowledgeAdmin.content.banner.staleNotice', {
                published: formatVersion(kb.published_version),
                base: formatVersion(currentDraft.base_version),
              })}
            </p>
          )}
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
        rowKey={(row) => row.documentId}
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
        publishedVersion={kb.published_version}
        submitting={publishing}
        onSubmit={(input) => void handlePublish(input)}
        onRebase={(versionId) => {
          setRebaseTarget(versions.find((version) => version.id === versionId) ?? currentDraft);
          setRebaseOpen(true);
        }}
        onReview={() => openReview(true)}
      />

      <RebaseDialog
        open={rebaseOpen}
        onOpenChange={setRebaseOpen}
        api={api}
        kbId={kb.id}
        draft={rebaseTarget}
        onRebased={handleRebased}
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
