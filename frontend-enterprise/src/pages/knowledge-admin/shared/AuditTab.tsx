/**
 * 知识库管理 · 详情页「审计日志」Tab（FR-070）：共享库审计流水，
 * 支持按动作 / 群组 / 操作者 / 版本筛选，分页「加载更多」。
 * 操作者名、群组名、原因等来自审计事件的自由文本字段，一律用 `RawContent` 包裹。
 */

import { useEffect, useMemo, useState } from 'react';

import { createKnowledgeAdminApi } from '@/api/knowledgeAdmin';
import { DataTable, type DataTableColumn } from '@/components/DataTable';
import { Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { notify } from '@/components/ui/app-toast';
import { useAppIntl } from '@/i18n';
import { RawContent } from '@/i18n/RawContent';
import { formatDateTime, OUTLINE_ACTION_BUTTON_SM_CLASS, SELECT_TRIGGER_CLASS } from '@/lib/enterprise-ui';
import { cn } from '@/lib/utils';
import type { KnowledgeBaseAuditEventRead, KnowledgeBaseRead } from '@/types';
import type { KnowledgeAdminVersionRead } from '@/types/knowledgeAdmin';

import { formatVersion } from '../knowledgeAdminModel';
import { knowledgeAdminErrorMessage } from './errorMessage';

export type AuditTabProps = {
  api: ReturnType<typeof createKnowledgeAdminApi>;
  kb: KnowledgeBaseRead;
};

const PAGE_LIMIT = 20;
const ALL_VALUE = 'all';

const AUDIT_ACTIONS = [
  'draft_created',
  'draft_reviewed',
  'draft_rebased',
  'published',
  'rejected',
  'rolled_back',
] as const;

/** 共享库审计流水：筛选条件变化时重取第一页，「加载更多」在现有结果后追加下一页。 */
export function AuditTab({ api, kb }: AuditTabProps) {
  const { t } = useAppIntl();
  const [items, setItems] = useState<KnowledgeBaseAuditEventRead[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [versions, setVersions] = useState<KnowledgeAdminVersionRead[]>([]);
  const [action, setAction] = useState<string>(ALL_VALUE);
  const [teamId, setTeamId] = useState('');
  const [actorId, setActorId] = useState('');
  const [versionId, setVersionId] = useState<string>(ALL_VALUE);

  const queryFilters = useMemo(
    () => ({
      action: action === ALL_VALUE ? undefined : action,
      teamId: teamId.trim() || undefined,
      actorId: actorId.trim() || undefined,
      versionId: versionId === ALL_VALUE ? undefined : versionId,
    }),
    [action, teamId, actorId, versionId],
  );

  async function loadPage(offset: number, append: boolean) {
    (append ? setLoadingMore : setLoading)(true);
    try {
      const page = await api.listAuditEvents(kb.id, { ...queryFilters, offset, limit: PAGE_LIMIT });
      setItems((prev) => (append ? [...prev, ...page.items] : page.items));
      setTotal(page.total);
      setHasMore(page.has_more);
    } catch (error) {
      notify.error(knowledgeAdminErrorMessage(error, 'knowledgeAdmin.toast.loadFailed', { t }));
    } finally {
      (append ? setLoadingMore : setLoading)(false);
    }
  }

  useEffect(() => {
    void loadPage(0, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, kb.id, queryFilters]);

  useEffect(() => {
    void api.listVersions(kb.id).then(setVersions).catch(() => setVersions([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, kb.id]);

  const columns: DataTableColumn<KnowledgeBaseAuditEventRead>[] = [
    { key: 'action', title: t('knowledgeAdmin.audit.columns.action'), width: 140, render: (row) => <RawContent value={row.action} /> },
    { key: 'actor', title: t('knowledgeAdmin.audit.columns.actor'), width: 140, render: (row) => <RawContent value={row.actor_name || row.actor_id} /> },
    { key: 'team', title: t('knowledgeAdmin.audit.columns.team'), width: 120, render: (row) => (row.team_name ? <RawContent value={row.team_name} /> : '-') },
    { key: 'version', title: t('knowledgeAdmin.audit.columns.version'), width: 100, render: (row) => (row.knowledge_base_version ? formatVersion(row.knowledge_base_version) : '-') },
    { key: 'reason', title: t('knowledgeAdmin.audit.columns.reason'), render: (row) => (row.reason ? <RawContent value={row.reason} /> : '-') },
    { key: 'createdAt', title: t('knowledgeAdmin.audit.columns.createdAt'), width: 160, render: (row) => formatDateTime(row.created_at) },
  ];

  return (
    <div className="flex flex-col gap-[12px]">
      <div className="flex flex-wrap items-center gap-[10px]">
        <Select value={action} onValueChange={setAction}>
          <SelectTrigger className={cn(SELECT_TRIGGER_CLASS, 'w-[160px]')} aria-label={t('knowledgeAdmin.audit.filters.action')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_VALUE}>{t('knowledgeAdmin.audit.filters.actionAll')}</SelectItem>
            {AUDIT_ACTIONS.map((value) => (
              <SelectItem key={value} value={value}>{value}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={versionId} onValueChange={setVersionId}>
          <SelectTrigger className={cn(SELECT_TRIGGER_CLASS, 'w-[160px]')} aria-label={t('knowledgeAdmin.audit.filters.version')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_VALUE}>{t('knowledgeAdmin.audit.filters.versionAll')}</SelectItem>
            {versions.map((version) => (
              <SelectItem key={version.id} value={version.id}>
                {version.draft_name ? version.draft_name : formatVersion(version.version)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          value={teamId}
          placeholder={t('knowledgeAdmin.audit.filters.teamPlaceholder')}
          aria-label={t('knowledgeAdmin.audit.filters.team')}
          onChange={(event) => setTeamId(event.target.value)}
          className="h-[34px] w-[160px] rounded-[10px] border-[0.5px] border-[#e3e7f1] bg-white text-[12px]"
        />
        <Input
          value={actorId}
          placeholder={t('knowledgeAdmin.audit.filters.actorPlaceholder')}
          aria-label={t('knowledgeAdmin.audit.filters.actor')}
          onChange={(event) => setActorId(event.target.value)}
          className="h-[34px] w-[160px] rounded-[10px] border-[0.5px] border-[#e3e7f1] bg-white text-[12px]"
        />
      </div>

      <DataTable
        columns={columns}
        data={items}
        rowKey={(row) => row.id}
        loading={loading}
        emptyText={t('knowledgeAdmin.audit.empty')}
        aria-label={t('knowledgeAdmin.detail.tabs.audit')}
      />

      {hasMore && items.length < total && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            disabled={loadingMore}
            onClick={() => void loadPage(items.length, true)}
            className={OUTLINE_ACTION_BUTTON_SM_CLASS}
          >
            {t('knowledgeAdmin.audit.loadMore')}
          </Button>
        </div>
      )}
    </div>
  );
}
