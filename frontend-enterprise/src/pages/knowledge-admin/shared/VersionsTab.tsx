/**
 * 知识库管理 · 详情页「版本管理」Tab（FR-030–FR-034）：共享库版本列表，
 * 服务端顺序原样展示（进行中草稿新在前 → released 版本号降序 → rejected）。
 * 草稿行提供「查看变更」（跳转内容 Tab 对应草稿视图）/「发布」/「驳回」；
 * released 行（非当前正式版）提供「回滚到此版本」；顶部「创建草稿」。
 */

import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { DataTable, type DataTableColumn } from '@/components/DataTable';
import { Dialog, DialogContent, DialogTitle, Textarea } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { notify } from '@/components/ui/app-toast';
import { useAppIntl } from '@/i18n';
import { RawIdentifier } from '@/i18n/RawContent';
import {
  DIALOG_CANCEL_BUTTON_CLASS,
  DIALOG_FOOTER_CLASS,
  DIALOG_PRIMARY_BUTTON_CLASS,
  OUTLINE_ACTION_BUTTON_SM_CLASS,
  formatDateTime,
} from '@/lib/enterprise-ui';
import { cn } from '@/lib/utils';
import { PublicationState, VersionLevel } from '@/enums/knowledge';
import type { KnowledgeAdminApi } from '@/api/knowledgeAdmin';
import type { KnowledgeBaseRead } from '@/types';
import type { KnowledgeAdminVersionRead, RebaseResult } from '@/types/knowledgeAdmin';

import { CreateDraftDialog } from '../dialogs/CreateDraftDialog';
import { PublishDialog, type PublishDialogSubmitInput } from '../dialogs/PublishDialog';
import { RebaseDialog } from '../dialogs/RebaseDialog';
import { formatVersion } from '../knowledgeAdminModel';
import { knowledgeAdminErrorMessage } from './errorMessage';

export type VersionsTabProps = {
  api: KnowledgeAdminApi;
  kb: KnowledgeBaseRead;
  onChanged?: () => void;
};

const STATE_LABEL_IDS: Record<string, 'knowledgeAdmin.versions.state.draft' | 'knowledgeAdmin.versions.state.released' | 'knowledgeAdmin.versions.state.rejected'> = {
  [PublicationState.Draft]: 'knowledgeAdmin.versions.state.draft',
  [PublicationState.Released]: 'knowledgeAdmin.versions.state.released',
  [PublicationState.Rejected]: 'knowledgeAdmin.versions.state.rejected',
};

export function VersionsTab({ api, kb, onChanged }: VersionsTabProps) {
  const { t } = useAppIntl();
  const [searchParams, setSearchParams] = useSearchParams();
  const [versions, setVersions] = useState<KnowledgeAdminVersionRead[]>([]);
  const [loading, setLoading] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  const [publishTarget, setPublishTarget] = useState<KnowledgeAdminVersionRead | null>(null);
  const [publishing, setPublishing] = useState(false);

  const [rebaseTarget, setRebaseTarget] = useState<KnowledgeAdminVersionRead | null>(null);

  const [rejectTarget, setRejectTarget] = useState<KnowledgeAdminVersionRead | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectReasonError, setRejectReasonError] = useState(false);
  const [rejecting, setRejecting] = useState(false);

  const [rollbackTarget, setRollbackTarget] = useState<KnowledgeAdminVersionRead | null>(null);
  const [rollbackReason, setRollbackReason] = useState('');
  const [rollbackReasonError, setRollbackReasonError] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const result = await api.listVersions(kb.id);
      setVersions(Array.isArray(result) ? result : []);
    } catch (error) {
      notify.error(knowledgeAdminErrorMessage(error, 'knowledgeAdmin.toast.loadFailed', { t }));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, kb.id]);

  /**
   * 跳到内容 Tab 对应草稿视图；`reviewIntent=true` 时额外带上 `publish`/`review=1`——
   * 版本 Tab 自己的发布框状态（`publishTarget`）在切 Tab 时随组件卸载丢失，无法直接带
   * 过去，改为让内容 Tab 按这两个 URL 参数自己重新打开审阅框并在应用后回到发布框
   * （同一份草稿），见 ContentTab.tsx 里消费这两个参数的 effect。
   */
  function openDraftContent(versionId: string, options: { reviewIntent?: boolean } = {}) {
    const params = new URLSearchParams(searchParams);
    params.set('tab', 'content');
    params.set('view', versionId);
    if (options.reviewIntent) {
      params.set('publish', versionId);
      params.set('review', '1');
    }
    setSearchParams(params);
  }

  async function handleCreateDraft(input: { changeReason: string }) {
    setCreating(true);
    try {
      await api.createDraft(kb.id, {
        teamId: null,
        changeReason: input.changeReason,
        expectedPublishedVersionId: kb.published_version_id ?? undefined,
      });
      notify.successText(t('knowledgeAdmin.toast.createDraftSuccess'));
      setCreateOpen(false);
      await load();
      onChanged?.();
    } catch (error) {
      notify.error(knowledgeAdminErrorMessage(error, 'knowledgeAdmin.toast.createError', { t }));
    } finally {
      setCreating(false);
    }
  }

  async function handlePublish(input: PublishDialogSubmitInput) {
    if (!publishTarget) return;
    setPublishing(true);
    try {
      await api.publishDraft(kb.id, publishTarget.id, {
        teamId: publishTarget.source_team_id ?? null,
        expectedPublishedVersionId: kb.published_version_id ?? publishTarget.parent_version_id ?? '',
        changeReason: input.changeReason,
        level: input.level,
        forceOverwrite: input.forceOverwrite,
      });
      notify.successText(t('knowledgeAdmin.toast.publishSuccess'));
      setPublishTarget(null);
      await load();
      onChanged?.();
    } catch (error) {
      notify.error(knowledgeAdminErrorMessage(error, 'knowledgeAdmin.toast.updateError', { t }));
    } finally {
      setPublishing(false);
    }
  }

  // 变基落库后：旧草稿快照已被 `superseded_by` 替换，关掉发布框与变基框，重新拉取版本列表
  // （新快照才会出现在其中；本 Tab 不像内容 Tab 需要切换 `view`，行随列表刷新自然更新）。
  function handleRebased(_result: RebaseResult) {
    setRebaseTarget(null);
    setPublishTarget(null);
    void load();
    onChanged?.();
  }

  async function handleReject() {
    if (!rejectTarget) return;
    const trimmed = rejectReason.trim();
    if (!trimmed) {
      setRejectReasonError(true);
      return;
    }
    setRejecting(true);
    try {
      await api.rejectDraft(kb.id, rejectTarget.id, {
        teamId: rejectTarget.source_team_id ?? null,
        changeReason: trimmed,
      });
      notify.successText(t('knowledgeAdmin.toast.rejectSuccess'));
      setRejectTarget(null);
      await load();
      onChanged?.();
    } catch (error) {
      notify.error(knowledgeAdminErrorMessage(error, 'knowledgeAdmin.toast.updateError', { t }));
    } finally {
      setRejecting(false);
    }
  }

  async function handleRollback() {
    if (!rollbackTarget) return;
    const trimmed = rollbackReason.trim();
    if (!trimmed) {
      setRollbackReasonError(true);
      return;
    }
    setRollingBack(true);
    try {
      await api.rollbackVersion(kb.id, {
        teamId: null,
        targetVersionId: rollbackTarget.id,
        expectedPublishedVersionId: kb.published_version_id ?? '',
        changeReason: trimmed,
      });
      notify.successText(t('knowledgeAdmin.toast.rollbackSuccess'));
      setRollbackTarget(null);
      await load();
      onChanged?.();
    } catch (error) {
      notify.error(knowledgeAdminErrorMessage(error, 'knowledgeAdmin.toast.updateError', { t }));
    } finally {
      setRollingBack(false);
    }
  }

  function renderSource(version: KnowledgeAdminVersionRead) {
    if (!version.source_team_id) return t('knowledgeAdmin.versions.sourceAdmin');
    return <RawIdentifier value={version.source_team_id} />;
  }

  function renderActions(version: KnowledgeAdminVersionRead) {
    if (version.publication_state === PublicationState.Draft) {
      return (
        <div className="flex flex-wrap justify-end gap-[6px]">
          <Button variant="outline" onClick={() => openDraftContent(version.id)} className={OUTLINE_ACTION_BUTTON_SM_CLASS}>
            {t('knowledgeAdmin.versions.actions.viewChanges')}
          </Button>
          <Button variant="outline" onClick={() => setPublishTarget(version)} className={OUTLINE_ACTION_BUTTON_SM_CLASS}>
            {t('knowledgeAdmin.versions.actions.publish')}
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setRejectTarget(version);
              setRejectReason('');
              setRejectReasonError(false);
            }}
            className={OUTLINE_ACTION_BUTTON_SM_CLASS}
          >
            {t('knowledgeAdmin.versions.actions.reject')}
          </Button>
        </div>
      );
    }
    if (version.publication_state === PublicationState.Released && !version.is_published_head) {
      return (
        <div className="flex justify-end">
          <Button
            variant="outline"
            onClick={() => {
              setRollbackTarget(version);
              setRollbackReason('');
              setRollbackReasonError(false);
            }}
            className={OUTLINE_ACTION_BUTTON_SM_CLASS}
          >
            {t('knowledgeAdmin.versions.actions.rollback')}
          </Button>
        </div>
      );
    }
    return null;
  }

  const columns: DataTableColumn<KnowledgeAdminVersionRead>[] = [
    {
      key: 'version',
      title: t('knowledgeAdmin.versions.columns.version'),
      render: (row) => (
        <div className="flex items-center gap-[6px]">
          <RawIdentifier value={row.draft_name || formatVersion(row.version)} />
          {row.is_published_head && (
            <span className="rounded-full bg-[#e9f7ef] px-[8px] py-[2px] text-[11px] font-medium text-[#2cb360]">
              {t('knowledgeAdmin.versions.currentBadge')}
            </span>
          )}
          {row.is_stale && (
            <span
              title={t('knowledgeAdmin.content.banner.staleNotice', {
                published: formatVersion(kb.published_version),
                base: formatVersion(row.base_version),
              })}
              className="rounded-full bg-[#fce7e7] px-[8px] py-[2px] text-[11px] font-medium text-[#d20b0b]"
            >
              {t('knowledgeAdmin.detail.badges.stale')}
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'state',
      title: t('knowledgeAdmin.versions.columns.state'),
      width: 100,
      render: (row) => t(STATE_LABEL_IDS[row.publication_state ?? ''] ?? 'knowledgeAdmin.versions.state.draft'),
    },
    { key: 'source', title: t('knowledgeAdmin.versions.columns.source'), width: 160, render: renderSource },
    { key: 'createdAt', title: t('knowledgeAdmin.versions.columns.createdAt'), width: 160, render: (row) => formatDateTime(row.created_at) },
    { key: 'actions', title: t('knowledgeAdmin.versions.columns.actions'), align: 'right', render: renderActions },
  ];

  return (
    <div className="flex flex-col gap-[12px]">
      <div className="flex justify-end">
        <Button onClick={() => setCreateOpen(true)} className={cn(OUTLINE_ACTION_BUTTON_SM_CLASS, 'bg-[#18181a] text-white hover:bg-[#303030] hover:text-white')}>
          {t('knowledgeAdmin.versions.actions.createDraft')}
        </Button>
      </div>

      <DataTable
        columns={columns}
        data={versions}
        rowKey={(row) => row.id}
        loading={loading}
        emptyText={t('knowledgeAdmin.versions.empty')}
        aria-label={t('knowledgeAdmin.detail.tabs.versions')}
      />

      <CreateDraftDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        submitting={creating}
        onSubmit={(input) => void handleCreateDraft(input)}
      />

      <PublishDialog
        open={Boolean(publishTarget)}
        onOpenChange={(next) => !next && setPublishTarget(null)}
        api={api}
        kbId={kb.id}
        draft={publishTarget}
        submitting={publishing}
        onSubmit={(input) => void handlePublish(input)}
        onRebase={(versionId) => setRebaseTarget(versions.find((version) => version.id === versionId) ?? publishTarget)}
        onReview={publishTarget ? () => openDraftContent(publishTarget.id, { reviewIntent: true }) : undefined}
      />

      <RebaseDialog
        open={Boolean(rebaseTarget)}
        onOpenChange={(next) => !next && setRebaseTarget(null)}
        api={api}
        kbId={kb.id}
        draft={rebaseTarget}
        onRebased={handleRebased}
      />

      <Dialog open={Boolean(rejectTarget)} onOpenChange={(next) => !rejecting && !next && setRejectTarget(null)}>
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
            <Button variant="outline" disabled={rejecting} onClick={() => setRejectTarget(null)} className={DIALOG_CANCEL_BUTTON_CLASS}>
              {t('knowledgeAdmin.content.rejectDialog.cancel')}
            </Button>
            <Button disabled={rejecting} onClick={() => void handleReject()} className="h-[32px] min-w-[80px] rounded-[10px] bg-[#d20b0b] px-[12px] text-[14px] font-normal text-white hover:bg-[#b80909]">
              {t('knowledgeAdmin.content.rejectDialog.confirm')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(rollbackTarget)} onOpenChange={(next) => !rollingBack && !next && setRollbackTarget(null)}>
        <DialogContent className="w-[min(440px,calc(100vw-32px))] gap-0 overflow-hidden rounded-[16px] border-0 bg-white p-0 shadow-[0px_12px_32px_rgba(0,0,0,0.16)]">
          <DialogTitle className="px-[24px] pt-[20px] pb-[12px] text-[16px] font-semibold text-[#18181a]">
            {t('knowledgeAdmin.versions.rollbackDialog.title')}
          </DialogTitle>
          <div className="flex flex-col gap-[6px] px-[24px] pb-[16px]">
            <span className="text-[12px] font-medium text-[#464c5e]">{t('knowledgeAdmin.versions.rollbackDialog.reasonLabel')}</span>
            <Textarea
              value={rollbackReason}
              disabled={rollingBack}
              aria-invalid={rollbackReasonError}
              aria-label={t('knowledgeAdmin.versions.rollbackDialog.reasonLabel')}
              onChange={(event) => {
                setRollbackReason(event.target.value);
                setRollbackReasonError(false);
              }}
            />
            {rollbackReasonError && (
              <span role="alert" className="text-[12px] text-[#d20b0b]">
                {t('knowledgeAdmin.versions.rollbackDialog.reasonRequired')}
              </span>
            )}
          </div>
          <div className={DIALOG_FOOTER_CLASS}>
            <Button variant="outline" disabled={rollingBack} onClick={() => setRollbackTarget(null)} className={DIALOG_CANCEL_BUTTON_CLASS}>
              {t('knowledgeAdmin.versions.rollbackDialog.cancel')}
            </Button>
            <Button disabled={rollingBack} onClick={() => void handleRollback()} className={DIALOG_PRIMARY_BUTTON_CLASS}>
              {t('knowledgeAdmin.versions.rollbackDialog.confirm')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
