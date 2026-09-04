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
import { useAppIntl } from '@/i18n';
import { RawContent, RawIdentifier } from '@/i18n/RawContent';
import { formatDateTime, OUTLINE_ACTION_BUTTON_SM_CLASS, SELECT_TRIGGER_CLASS } from '@/lib/enterprise-ui';
import { cn } from '@/lib/utils';
import type { KnowledgeBaseAuditEventRead, KnowledgeBaseRead } from '@/types';
import type { KnowledgeAdminVersionRead } from '@/types/knowledgeAdmin';

import { formatVersion } from '../knowledgeAdminModel';
import { useKnowledgeAdminToast } from './errorMessage';
import { useGuardedLoad } from './useGuardedLoad';

export type AuditTabProps = {
  api: ReturnType<typeof createKnowledgeAdminApi>;
  kb: KnowledgeBaseRead;
};

const PAGE_LIMIT = 20;
const ALL_VALUE = 'all';

/** 自由文本筛选（群组 ID / 操作者 ID）的防抖时长，与列表页搜索框一致。 */
const FILTER_DEBOUNCE_MS = 300;

/**
 * 审计动作码 → 语义消息 id（I8）。这些码是 StaffDeck 自己定义的后端枚举，不是用户
 * 原始内容，必须本地化；旧实现把码本身当作筛选项标签与表格单元格文案直接显示，还
 * 用 `RawContent` 包了一层——那是"逐字保留用户/第三方原文"的标记，用在自有枚举上
 * 属于误用。落键模式抄 `VersionsTab.tsx` 的 `STATE_LABEL_IDS`。
 */
const AUDIT_ACTION_LABEL_IDS: Record<
  string,
  | 'knowledgeAdmin.audit.actions.draftCreated'
  | 'knowledgeAdmin.audit.actions.draftReviewed'
  | 'knowledgeAdmin.audit.actions.draftRebased'
  | 'knowledgeAdmin.audit.actions.published'
  | 'knowledgeAdmin.audit.actions.rejected'
  | 'knowledgeAdmin.audit.actions.rolledBack'
> = {
  draft_created: 'knowledgeAdmin.audit.actions.draftCreated',
  draft_reviewed: 'knowledgeAdmin.audit.actions.draftReviewed',
  draft_rebased: 'knowledgeAdmin.audit.actions.draftRebased',
  published: 'knowledgeAdmin.audit.actions.published',
  rejected: 'knowledgeAdmin.audit.actions.rejected',
  rolled_back: 'knowledgeAdmin.audit.actions.rolledBack',
};

const AUDIT_ACTIONS = Object.keys(AUDIT_ACTION_LABEL_IDS);

/** 共享库审计流水：筛选条件变化时重取第一页，「加载更多」在现有结果后追加下一页。 */
export function AuditTab({ api, kb }: AuditTabProps) {
  const { t } = useAppIntl();
  const toast = useKnowledgeAdminToast();
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
  // 两个自由文本筛选先落到本地输入态，300ms 内无新输入才折算进请求条件（I1）——
  // 之前 `queryFilters` 直接 memo 在输入值上，每敲一个字符就打一次 A7，且没有任何
  // 请求序号护栏，先发后到的响应会把列表覆盖成过期结果。
  const [debouncedTeamId, setDebouncedTeamId] = useState('');
  const [debouncedActorId, setDebouncedActorId] = useState('');
  const pageLoad = useGuardedLoad();
  const versionsLoad = useGuardedLoad();

  useEffect(() => {
    const handle = window.setTimeout(() => {
      setDebouncedTeamId(teamId.trim());
      setDebouncedActorId(actorId.trim());
    }, FILTER_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [teamId, actorId]);

  const queryFilters = useMemo(
    () => ({
      action: action === ALL_VALUE ? undefined : action,
      teamId: debouncedTeamId || undefined,
      actorId: debouncedActorId || undefined,
      versionId: versionId === ALL_VALUE ? undefined : versionId,
    }),
    [action, debouncedTeamId, debouncedActorId, versionId],
  );

  async function loadPage(offset: number, append: boolean) {
    const token = pageLoad.begin();
    (append ? setLoadingMore : setLoading)(true);
    try {
      const page = await api.listAuditEvents(kb.id, { ...queryFilters, offset, limit: PAGE_LIMIT });
      if (!pageLoad.isCurrent(token)) return;
      setItems((prev) => (append ? [...prev, ...page.items] : page.items));
      setTotal(page.total);
      setHasMore(page.has_more);
    } catch (error) {
      if (!pageLoad.isCurrent(token)) return;
      toast.error(error, 'knowledgeAdmin.toast.loadFailed');
    } finally {
      if (pageLoad.isCurrent(token)) (append ? setLoadingMore : setLoading)(false);
    }
  }

  useEffect(() => {
    void loadPage(0, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, kb.id, queryFilters]);

  useEffect(() => {
    const token = versionsLoad.begin();
    void api.listVersions(kb.id).then(
      (rows) => {
        if (versionsLoad.isCurrent(token)) setVersions(Array.isArray(rows) ? rows : []);
      },
      () => {
        if (versionsLoad.isCurrent(token)) setVersions([]);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, kb.id]);

  const columns: DataTableColumn<KnowledgeBaseAuditEventRead>[] = [
    {
      key: 'action',
      title: t('knowledgeAdmin.audit.columns.action'),
      width: 140,
      // 已登记的动作码翻译为产品文案；出现未登记的新码时原样显示码本身（可诊断），
      // 不再套 `RawContent`——那是给用户/第三方原文用的标记。
      render: (row) => {
        const labelId = AUDIT_ACTION_LABEL_IDS[row.action];
        return labelId ? t(labelId) : row.action;
      },
    },
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
              <SelectItem key={value} value={value}>{t(AUDIT_ACTION_LABEL_IDS[value])}</SelectItem>
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
                {/* 草稿名是用户填写的自由文本，与 VersionsTab 一致地用 RawIdentifier 包裹（I9）。 */}
                {version.draft_name
                  ? <RawIdentifier value={version.draft_name} />
                  : formatVersion(version.version)}
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
