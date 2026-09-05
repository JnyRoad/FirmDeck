/**
 * 知识库管理 · 私有库详情「分支」Tab（US5，FR-080、FR-081）：分支状态卡
 * （归属员工、广场基线、分支头、同步状态）+「从广场同步」「发布到广场为模板」+
 * 历史版本列表回滚。版本历史来自 B2 `listVersions(kb.id, ownerAgentId)`
 * （专用库分支返回 `is_head`/`is_base` 标记，见契约 B2 说明），基线/分支头版本号
 * 直接从这份列表里按标记取，不额外拼一份状态请求。
 *
 * 三个写操作都复用既有专用库端点（`KnowledgePage.tsx` 同款内联调用迁移到
 * `api/knowledgeAdmin.ts`）：`syncFromOverall`/`promoteToOverall` 都不需要变更原因
 * （对应后端 `sync-from-overall`/`promote-to-overall` 路由本身不接受 `change_reason`），
 * `rollbackDedicatedBranch` 同理（专用库 `KnowledgeBaseRollbackRequest` 只有
 * `tenant_id`/`agent_id`/`version` 三个字段，不像共享库回滚那样要求填写原因）。
 * 三者成功后都重新拉取版本列表并调用 `onChanged?.()` 让详情页顶部徽章一并刷新。
 */

import { useEffect, useMemo, useState } from 'react';

import { ConfirmDialog } from '@/components/ConfirmDialog';
import { DataTable, type DataTableColumn } from '@/components/DataTable';
import { Button } from '@/components/ui/button';
import { useAppIntl } from '@/i18n';
import { createMessageDescriptor } from '@/i18n/descriptors';
import { RawIdentifier } from '@/i18n/RawContent';
import { formatDateTime, OUTLINE_ACTION_BUTTON_SM_CLASS } from '@/lib/enterprise-ui';
import type { KnowledgeAdminApi } from '@/api/knowledgeAdmin';
import type { KnowledgeBaseRead } from '@/types';
import type { KnowledgeAdminVersionRead } from '@/types/knowledgeAdmin';

import { formatVersion } from '../knowledgeAdminModel';
import { useKnowledgeAdminToast } from '../shared/errorMessage';
import { useGuardedLoad } from '../shared/useGuardedLoad';
import { branchSyncMessageId } from './branchStatus';

export type PrivateBranchTabProps = {
  api: KnowledgeAdminApi;
  kb: KnowledgeBaseRead;
  ownerAgentId: string;
  ownerAgentName: string;
  onChanged?: () => void;
};

/** 私有库分支 Tab：状态卡 + 同步/发布到广场 + 历史版本回滚。 */
export function BranchTab({ api, kb, ownerAgentId, ownerAgentName, onChanged }: PrivateBranchTabProps) {
  const { t } = useAppIntl();
  const toast = useKnowledgeAdminToast();
  // 过期响应护栏（I1）：分支版本列表的请求序号 + 租户代际。
  const versionsLoad = useGuardedLoad();
  const [versions, setVersions] = useState<KnowledgeAdminVersionRead[]>([]);
  const [loading, setLoading] = useState(false);

  const [syncOpen, setSyncOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [rollbackTarget, setRollbackTarget] = useState<KnowledgeAdminVersionRead | null>(null);
  const [rollingBack, setRollingBack] = useState(false);

  const headVersion = useMemo(() => versions.find((version) => version.is_head) || null, [versions]);
  const baseVersion = useMemo(() => versions.find((version) => version.is_base) || null, [versions]);

  async function load() {
    if (!ownerAgentId) return;
    const token = versionsLoad.begin();
    setLoading(true);
    try {
      const rows = await api.listVersions(kb.id, ownerAgentId);
      // 过期响应（切换归属员工 / 租户代际已变）整个丢弃，见 useGuardedLoad（I1）。
      if (!versionsLoad.isCurrent(token)) return;
      setVersions(Array.isArray(rows) ? rows : []);
    } catch (error) {
      if (!versionsLoad.isCurrent(token)) return;
      toast.error(error, 'knowledgeAdmin.toast.loadFailed');
    } finally {
      if (versionsLoad.isCurrent(token)) setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, kb.id, ownerAgentId]);

  async function handleSync() {
    setSyncing(true);
    try {
      await api.syncFromOverall(kb.id, ownerAgentId);
      toast.success(createMessageDescriptor('knowledgeAdmin.private.branch.toast.syncSuccess'));
      setSyncOpen(false);
      await load();
      onChanged?.();
    } catch (error) {
      toast.error(error, 'knowledgeAdmin.toast.updateError');
    } finally {
      setSyncing(false);
    }
  }

  async function handlePromote() {
    setPromoting(true);
    try {
      await api.promoteToOverall(kb.id, ownerAgentId);
      toast.success(createMessageDescriptor('knowledgeAdmin.private.branch.toast.promoteSuccess'));
      setPromoteOpen(false);
      await load();
      onChanged?.();
    } catch (error) {
      toast.error(error, 'knowledgeAdmin.toast.updateError');
    } finally {
      setPromoting(false);
    }
  }

  async function handleRollback() {
    if (!rollbackTarget) return;
    setRollingBack(true);
    try {
      await api.rollbackDedicatedBranch(kb.id, { agentId: ownerAgentId, version: rollbackTarget.version });
      toast.success(
        createMessageDescriptor('knowledgeAdmin.private.branch.toast.rollbackSuccess', { version: formatVersion(rollbackTarget.version) }),
      );
      setRollbackTarget(null);
      await load();
      onChanged?.();
    } catch (error) {
      toast.error(error, 'knowledgeAdmin.toast.updateError');
    } finally {
      setRollingBack(false);
    }
  }

  const columns: DataTableColumn<KnowledgeAdminVersionRead>[] = [
    {
      key: 'version',
      title: t('knowledgeAdmin.private.branch.table.version'),
      width: 140,
      render: (row) => (
        <span className="flex items-center gap-[6px]">
          {formatVersion(row.version)}
          {row.is_head && (
            <span className="rounded-full bg-[#eef2f7] px-[7px] py-[1px] text-[10px] font-medium text-[#596174]">
              {t('knowledgeAdmin.private.branch.badges.head')}
            </span>
          )}
          {row.is_base && (
            <span className="rounded-full bg-[#ede9fe] px-[7px] py-[1px] text-[10px] font-medium text-[#6d28d9]">
              {t('knowledgeAdmin.private.branch.badges.base')}
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'updatedAt',
      title: t('knowledgeAdmin.list.columns.updatedAt'),
      width: 160,
      render: (row) => formatDateTime(row.updated_at),
    },
    {
      key: 'actions',
      title: t('knowledgeAdmin.content.table.actions'),
      width: 140,
      align: 'right',
      render: (row) => (
        <Button
          variant="outline"
          disabled={row.is_head}
          onClick={() => setRollbackTarget(row)}
          className={OUTLINE_ACTION_BUTTON_SM_CLASS}
        >
          {t('knowledgeAdmin.private.branch.actions.rollback')}
        </Button>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-[16px]">
      <section
        aria-label={t('knowledgeAdmin.private.branch.statusCard.title')}
        className="rounded-[14px] border-[0.5px] border-[#e3e7f1] bg-white p-[16px]"
      >
        <h2 className="text-[14px] font-semibold text-[#18181a]">{t('knowledgeAdmin.private.branch.statusCard.title')}</h2>
        <dl className="mt-[12px] grid grid-cols-2 gap-[12px] sm:grid-cols-4">
          <div>
            <dt className="text-[11px] text-[#858b9c]">{t('knowledgeAdmin.private.branch.statusCard.owner')}</dt>
            <dd className="mt-[2px] text-[13px] font-medium text-[#18181a]">
              <RawIdentifier value={ownerAgentName || ownerAgentId} />
            </dd>
          </div>
          <div>
            <dt className="text-[11px] text-[#858b9c]">{t('knowledgeAdmin.private.branch.statusCard.baseVersion')}</dt>
            <dd className="mt-[2px] text-[13px] font-medium text-[#18181a]">{formatVersion(baseVersion?.version) || '-'}</dd>
          </div>
          <div>
            <dt className="text-[11px] text-[#858b9c]">{t('knowledgeAdmin.private.branch.statusCard.headVersion')}</dt>
            <dd className="mt-[2px] text-[13px] font-medium text-[#18181a]">{formatVersion(headVersion?.version) || '-'}</dd>
          </div>
          <div>
            <dt className="text-[11px] text-[#858b9c]">{t('knowledgeAdmin.private.branch.statusCard.syncState')}</dt>
            <dd className="mt-[2px] text-[13px] font-medium text-[#18181a]">{t(branchSyncMessageId(kb.branch_sync_state))}</dd>
          </div>
        </dl>
        <div className="mt-[14px] flex flex-wrap gap-[8px]">
          <Button
            variant="outline"
            disabled={!ownerAgentId}
            onClick={() => setSyncOpen(true)}
            className={OUTLINE_ACTION_BUTTON_SM_CLASS}
          >
            {t('knowledgeAdmin.private.branch.actions.syncFromOverall')}
          </Button>
          <Button
            variant="outline"
            disabled={!ownerAgentId}
            onClick={() => setPromoteOpen(true)}
            className={OUTLINE_ACTION_BUTTON_SM_CLASS}
          >
            {t('knowledgeAdmin.private.branch.actions.promoteToOverall')}
          </Button>
        </div>
      </section>

      <DataTable
        columns={columns}
        data={versions}
        rowKey={(row) => row.id}
        loading={loading}
        emptyText={t('knowledgeAdmin.private.branch.table.empty')}
        aria-label={t('knowledgeAdmin.detail.tabs.branch')}
      />

      <ConfirmDialog
        open={syncOpen}
        onOpenChange={(open) => { if (!open && !syncing) setSyncOpen(false); }}
        title={t('knowledgeAdmin.private.branch.syncDialog.title')}
        description={t('knowledgeAdmin.private.branch.syncDialog.description')}
        confirmText={t('knowledgeAdmin.private.branch.syncDialog.confirm')}
        cancelText={t('knowledgeAdmin.private.branch.syncDialog.cancel')}
        destructive={false}
        loading={syncing}
        onConfirm={() => void handleSync()}
      />

      <ConfirmDialog
        open={promoteOpen}
        onOpenChange={(open) => { if (!open && !promoting) setPromoteOpen(false); }}
        title={t('knowledgeAdmin.private.branch.promoteDialog.title')}
        description={t('knowledgeAdmin.private.branch.promoteDialog.description')}
        confirmText={t('knowledgeAdmin.private.branch.promoteDialog.confirm')}
        cancelText={t('knowledgeAdmin.private.branch.promoteDialog.cancel')}
        destructive={false}
        loading={promoting}
        onConfirm={() => void handlePromote()}
      />

      <ConfirmDialog
        open={Boolean(rollbackTarget)}
        onOpenChange={(open) => { if (!open && !rollingBack) setRollbackTarget(null); }}
        title={rollbackTarget
          ? t('knowledgeAdmin.private.branch.rollbackDialog.title', { version: formatVersion(rollbackTarget.version) })
          : ''}
        description={t('knowledgeAdmin.private.branch.rollbackDialog.description')}
        confirmText={t('knowledgeAdmin.private.branch.rollbackDialog.confirm')}
        cancelText={t('knowledgeAdmin.private.branch.rollbackDialog.cancel')}
        destructive
        loading={rollingBack}
        onConfirm={() => void handleRollback()}
      />
    </div>
  );
}
