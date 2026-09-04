/**
 * 知识库管理 · 列表页：租户管理员总览全部共享库与私有库（US1）。
 * 统计卡（总数/共享/私有/文档数）、类型页签、四类筛选 + 搜索、新建、
 * 行 `⋯` 菜单（按 mode 差异）、上线/下线与删除二次确认。
 * 页面不读取 `readEmployeeScope`，也不监听 agent-scope 事件；数据只经
 * `api/knowledgeAdmin.ts`。
 */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { createKnowledgeAdminApi } from '@/api/knowledgeAdmin';
import AppHeader from '@/components/AppHeader';
import { DataTable, type DataTableColumn } from '@/components/DataTable';
import { KnowledgeTypeBadge } from '@/components/knowledge/KnowledgeTypeBadge';
import { SharedKnowledgeConversionDialog } from '@/components/knowledge/SharedKnowledgeConversionDialog';
import { StatCard } from '@/components/StatCard';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsList,
  TabsTrigger,
} from '@/components/ui';
import { Button } from '@/components/ui/button';
import { notify } from '@/components/ui/app-toast';
import { useTenantSession } from '@/contexts/TenantSessionContext';
import { KnowledgeBaseMode } from '@/enums/knowledge';
import { EnterpriseRoute } from '@/enums/routes';
import { useAppIntl } from '@/i18n';
import { createMessageDescriptor } from '@/i18n/descriptors';
import { RawContent } from '@/i18n/RawContent';
import { createUiSinks } from '@/i18n/sinks';
import {
  MENU_CONTENT_CLASS,
  MENU_ITEM_CLASS,
  MENU_ITEM_DANGER_CLASS,
  OUTLINE_ACTION_BUTTON_CLASS,
  SELECT_TRIGGER_CLASS,
  formatDateTime,
} from '@/lib/enterprise-ui';
import { cn } from '@/lib/utils';
import type { AgentProfileRead, KnowledgeBaseRead } from '@/types';
import type { KnowledgeAdminListItem, KnowledgeAdminListSummary, KnowledgeAdminTeamOption } from '@/types/knowledgeAdmin';

import IconAdd from '../../assets/icons/add.svg?react';
import IconMore from '../../assets/icons/more.svg?react';
import IconRefresh from '../../assets/icons/refresh.svg?react';
import type { EnterpriseAuthUser } from '../../auth';
import { CreateKnowledgeBaseDialog, type CreateKnowledgeBaseDraft } from './dialogs/CreateKnowledgeBaseDialog';
import { DeleteDialog } from './dialogs/DeleteDialog';
import { knowledgeAdminErrorMessage } from './shared/errorMessage';
import {
  ALL_FILTER_VALUE,
  computeKnowledgeAdminListSummary,
  defaultKnowledgeAdminListFilters,
  isUnboundSharedKnowledgeBase,
  knowledgeAdminSyncStateBadge,
  knowledgeAdminVersionBadge,
  matchesKnowledgeAdminFilters,
  sortKnowledgeAdminListItems,
  type KnowledgeAdminListFilters,
} from './knowledgeAdminModel';

const EMPTY_SUMMARY: KnowledgeAdminListSummary = { total: 0, shared: 0, dedicated: 0, documents: 0 };

export type KnowledgeAdminListPageProps = {
  currentUser?: EnterpriseAuthUser;
  onLogout?: () => void;
};

export default function KnowledgeAdminListPage({ currentUser, onLogout }: KnowledgeAdminListPageProps = {}) {
  const navigate = useNavigate();
  const { t } = useAppIntl();
  const tenantContext = useTenantSession();
  const api = useMemo(() => createKnowledgeAdminApi(tenantContext), [tenantContext]);
  const uiSinks = useMemo(() => createUiSinks({ t }), [t]);

  const [items, setItems] = useState<KnowledgeAdminListItem[]>([]);
  const [summary, setSummary] = useState<KnowledgeAdminListSummary>(EMPTY_SUMMARY);
  const [agents, setAgents] = useState<AgentProfileRead[]>([]);
  const [teams, setTeams] = useState<KnowledgeAdminTeamOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState<KnowledgeAdminListFilters>(defaultKnowledgeAdminListFilters());
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<KnowledgeAdminListItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [conversionState, setConversionState] = useState<{ kb: KnowledgeBaseRead; agentId: string } | null>(null);

  /** 拉取列表、统计、归属员工与可绑定群组候选；单次请求失败不影响其余数据展示。 */
  async function load() {
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return;
    setLoading(true);
    try {
      const [listResult, agentsResult, teamsResult] = await Promise.all([
        api.listKnowledgeBases({ limit: 20 }),
        api.listAgents(),
        api.listBindableTeams({}),
      ]);
      if (!context.isCurrentGeneration(generation)) return;
      setItems(Array.isArray(listResult?.items) ? listResult.items : []);
      setSummary(listResult?.summary ?? EMPTY_SUMMARY);
      setAgents(Array.isArray(agentsResult) ? agentsResult : []);
      setTeams(Array.isArray(teamsResult) ? teamsResult : []);
    } catch (error) {
      if (!context.isCurrentGeneration(generation)) return;
      notify.error(knowledgeAdminErrorMessage(error, 'knowledgeAdmin.toast.loadFailed', { t }));
    } finally {
      if (context.isCurrentGeneration(generation)) setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  /** 类型页签计数：忽略当前 mode 筛选，但保留状态/归属/群组/搜索，方便切页签时看到一致的其它维度筛选结果。 */
  const tabCounts = useMemo(
    () => computeKnowledgeAdminListSummary(items.filter((item) => matchesKnowledgeAdminFilters(item, { ...filters, mode: ALL_FILTER_VALUE }))),
    [items, filters],
  );
  const visibleItems = useMemo(
    () => sortKnowledgeAdminListItems(items.filter((item) => matchesKnowledgeAdminFilters(item, filters))),
    [items, filters],
  );

  function updateFilter<K extends keyof KnowledgeAdminListFilters>(key: K, value: KnowledgeAdminListFilters[K]) {
    setFilters((prev) => ({ ...prev, [key]: value }));
  }

  async function toggleStatus(row: KnowledgeAdminListItem) {
    try {
      await api.updateKnowledgeBase(row.id, { status: row.status === 'active' ? 'archived' : 'active' });
      notify.successText(t('knowledgeAdmin.toast.updateSuccess'));
      await load();
    } catch (error) {
      notify.error(knowledgeAdminErrorMessage(error, 'knowledgeAdmin.toast.updateError', { t }));
    }
  }

  async function handleExport(row: KnowledgeAdminListItem) {
    try {
      const blob = await api.exportOkf(row.id, row.owner_agent?.id);
      uiSinks.download(blob, createMessageDescriptor('knowledgePage.download.backupPrefix'), row.name, 'okf.zip');
      notify.successText(t('knowledgeAdmin.toast.exportSuccess'));
    } catch (error) {
      notify.error(knowledgeAdminErrorMessage(error, 'knowledgeAdmin.toast.exportError', { t }));
    }
  }

  async function handleLint(row: KnowledgeAdminListItem) {
    try {
      const result = await api.lintOkf(row.id, row.owner_agent?.id);
      notify.successText(
        result.issue_count
          ? t('knowledgeAdmin.toast.lintIssues', { count: result.issue_count })
          : t('knowledgeAdmin.toast.lintPassed'),
      );
    } catch (error) {
      notify.error(knowledgeAdminErrorMessage(error, 'knowledgeAdmin.toast.lintError', { t }));
    }
  }

  async function openConversion(row: KnowledgeAdminListItem) {
    if (!row.owner_agent) return;
    try {
      const full = await api.getKnowledgeBase(row.id, row.owner_agent.id);
      setConversionState({ kb: full, agentId: row.owner_agent.id });
    } catch (error) {
      notify.error(knowledgeAdminErrorMessage(error, 'knowledgeAdmin.toast.loadFailed', { t }));
    }
  }

  async function handleConverted() {
    notify.successText(t('knowledgeAdmin.toast.convertSuccess'));
    setConversionState(null);
    await load();
  }

  async function handleCreate(draft: CreateKnowledgeBaseDraft) {
    setCreating(true);
    try {
      const created = await api.createKnowledgeBase({
        name: draft.name,
        description: draft.description || undefined,
        mode: draft.mode,
        agentId: draft.mode === KnowledgeBaseMode.Dedicated ? draft.ownerAgentId : undefined,
      });
      notify.successText(t('knowledgeAdmin.toast.createSuccess'));
      setCreateOpen(false);
      navigate(`${EnterpriseRoute.KnowledgeAdmin}/${created.id}`);
    } catch (error) {
      notify.error(knowledgeAdminErrorMessage(error, 'knowledgeAdmin.toast.createError', { t }));
    } finally {
      setCreating(false);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.deleteKnowledgeBase(deleteTarget.id);
      notify.successText(t('knowledgeAdmin.toast.deleteSuccess'));
      setDeleteTarget(null);
      await load();
    } catch (error) {
      notify.error(knowledgeAdminErrorMessage(error, 'knowledgeAdmin.toast.deleteError', { t }));
    } finally {
      setDeleting(false);
    }
  }

  function renderOwnership(row: KnowledgeAdminListItem) {
    if (row.mode === KnowledgeBaseMode.Dedicated) {
      return row.owner_agent ? <RawContent value={row.owner_agent.name} /> : null;
    }
    if (isUnboundSharedKnowledgeBase(row)) {
      return <span className="text-[#c65f00]">{t('knowledgeAdmin.list.unbound')}</span>;
    }
    return <RawContent value={row.bound_teams.map((team) => team.name).join('、')} />;
  }

  function renderVersionStatus(row: KnowledgeAdminListItem) {
    const badge = knowledgeAdminVersionBadge(row);
    const sync = knowledgeAdminSyncStateBadge(row);
    return (
      <div className="flex flex-col gap-[2px]">
        <span>{t(badge.messageId, badge.values)}</span>
        {sync && <span className="text-[11px] text-[#a2a8b8]">{t(sync.messageId)}</span>}
      </div>
    );
  }

  function renderStatusBadge(row: KnowledgeAdminListItem) {
    const active = row.status === 'active';
    return (
      <span
        className={cn(
          'inline-flex items-center rounded-full px-[9px] py-[3px] text-[11px] font-medium',
          active ? 'bg-[#e9f7ef] text-[#2cb360]' : 'bg-[#f2f3f7] text-[#757f9c]',
        )}
      >
        {t(active ? 'knowledgeAdmin.detail.badges.active' : 'knowledgeAdmin.detail.badges.archived')}
      </span>
    );
  }

  function renderRowMenu(row: KnowledgeAdminListItem) {
    const isShared = row.mode === KnowledgeBaseMode.Shared;
    return (
      <div onClick={(event) => event.stopPropagation()}>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={t('knowledgeAdmin.list.menu.ariaLabel')}
            className="ml-auto grid size-7 place-items-center rounded-[8px] text-[#1a71ff] transition-colors outline-none hover:bg-black/5 hover:text-[#4a8dff] focus-visible:bg-black/5"
          >
            <IconMore className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className={MENU_CONTENT_CLASS}>
            <DropdownMenuItem
              className={MENU_ITEM_CLASS}
              onSelect={() => navigate(`${EnterpriseRoute.KnowledgeAdmin}/${row.id}?tab=settings`)}
            >
              {t('knowledgeAdmin.list.menu.edit')}
            </DropdownMenuItem>
            <DropdownMenuItem
              className={MENU_ITEM_CLASS}
              onSelect={() => navigate(`${EnterpriseRoute.KnowledgeAdmin}/${row.id}?tab=${isShared ? 'versions' : 'branch'}`)}
            >
              {t('knowledgeAdmin.list.menu.versions')}
            </DropdownMenuItem>
            {isShared && (
              <DropdownMenuItem
                className={MENU_ITEM_CLASS}
                onSelect={() => navigate(`${EnterpriseRoute.KnowledgeAdmin}/${row.id}?tab=grants`)}
              >
                {t('knowledgeAdmin.list.menu.grants')}
              </DropdownMenuItem>
            )}
            {!isShared && (
              <DropdownMenuItem
                className={MENU_ITEM_CLASS}
                disabled={row.status === 'archived'}
                onSelect={() => void openConversion(row)}
              >
                {t('knowledgeAdmin.list.menu.convertToShared')}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => void handleExport(row)}>
              {t('knowledgeAdmin.list.menu.exportBackup')}
            </DropdownMenuItem>
            <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => void handleLint(row)}>
              {t('knowledgeAdmin.list.menu.graphCheck')}
            </DropdownMenuItem>
            <DropdownMenuSeparator className="my-[2px] bg-[#eef0f4]" />
            <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => void toggleStatus(row)}>
              {row.status === 'active' ? t('knowledgeAdmin.list.menu.archive') : t('knowledgeAdmin.list.menu.activate')}
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              className={MENU_ITEM_DANGER_CLASS}
              onSelect={() => setDeleteTarget(row)}
            >
              {t('knowledgeAdmin.list.menu.delete')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  }

  const columns: DataTableColumn<KnowledgeAdminListItem>[] = [
    {
      key: 'name',
      title: t('knowledgeAdmin.list.columns.name'),
      render: (row) => (
        <div className="min-w-0">
          <div className="truncate font-medium text-[#18181a]">
            <RawContent value={row.name} />
          </div>
          {row.description && (
            <div className="mt-[2px] truncate text-[11px] text-[#a2a8b8]">
              <RawContent value={row.description} />
            </div>
          )}
        </div>
      ),
    },
    { key: 'mode', title: t('knowledgeAdmin.list.columns.mode'), width: 96, render: (row) => <KnowledgeTypeBadge mode={row.mode} /> },
    { key: 'owner', title: t('knowledgeAdmin.list.columns.owner'), width: 160, render: renderOwnership },
    { key: 'version', title: t('knowledgeAdmin.list.columns.publishedVersion'), width: 200, render: renderVersionStatus },
    { key: 'documents', title: t('knowledgeAdmin.list.columns.documentCount'), width: 96, render: (row) => row.document_count },
    { key: 'status', title: t('knowledgeAdmin.list.columns.status'), width: 96, render: renderStatusBadge },
    { key: 'updatedAt', title: t('knowledgeAdmin.list.columns.updatedAt'), width: 160, render: (row) => formatDateTime(row.updated_at) },
    { key: 'actions', title: t('knowledgeAdmin.list.columns.actions'), width: 60, align: 'right', render: renderRowMenu },
  ];

  return (
    <div className="min-h-full box-border px-[48px] pt-[32px] pb-[43px] max-[900px]:px-[16px]" aria-busy={loading}>
      <AppHeader onLogout={onLogout} userName={currentUser?.username} title={t('knowledgeAdmin.list.title')} description={t('knowledgeAdmin.list.description')} />

      <div className="mt-[20px] flex flex-wrap gap-[12px]" aria-label={t('knowledgeAdmin.list.stats.label')}>
        <StatCard value={summary.total} label={t('knowledgeAdmin.list.stats.total')} />
        <StatCard value={summary.shared} label={t('knowledgeAdmin.list.stats.shared')} />
        <StatCard value={summary.dedicated} label={t('knowledgeAdmin.list.stats.dedicated')} />
        <StatCard value={summary.documents} label={t('knowledgeAdmin.list.stats.documents')} />
      </div>

      <div className="mt-[20px] flex flex-wrap items-center justify-between gap-[12px]">
        <Tabs value={filters.mode} onValueChange={(value) => updateFilter('mode', value as KnowledgeAdminListFilters['mode'])}>
          <TabsList variant="line" aria-label={t('knowledgeAdmin.list.tabs.ariaLabel')}>
            <TabsTrigger value={ALL_FILTER_VALUE}>{t('knowledgeAdmin.list.tabs.all')} ({tabCounts.total})</TabsTrigger>
            <TabsTrigger value={KnowledgeBaseMode.Shared}>{t('knowledgeAdmin.list.tabs.shared')} ({tabCounts.shared})</TabsTrigger>
            <TabsTrigger value={KnowledgeBaseMode.Dedicated}>{t('knowledgeAdmin.list.tabs.dedicated')} ({tabCounts.dedicated})</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-[8px]">
          <Button
            variant="outline"
            onClick={() => void load()}
            disabled={loading}
            className={OUTLINE_ACTION_BUTTON_CLASS}
          >
            <IconRefresh className={cn('size-[14px]', loading && 'animate-spin')} />
            {t('knowledgeAdmin.list.actions.refresh')}
          </Button>
          <Button
            onClick={() => setCreateOpen(true)}
            className="h-[34px] gap-[4px] rounded-[10px] bg-[#18181a] px-[20px] text-[12px] font-normal text-white hover:bg-[#303030]"
          >
            <IconAdd className="size-[14px]" />
            {t('knowledgeAdmin.list.actions.create')}
          </Button>
        </div>
      </div>

      <div className="mt-[12px] flex flex-wrap items-center gap-[10px]">
        <Select value={filters.status} onValueChange={(value) => updateFilter('status', value as KnowledgeAdminListFilters['status'])}>
          <SelectTrigger className={cn(SELECT_TRIGGER_CLASS, 'w-[140px]')} aria-label={t('knowledgeAdmin.list.filters.status')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_FILTER_VALUE}>{t('knowledgeAdmin.list.filters.statusAll')}</SelectItem>
            <SelectItem value="active">{t('knowledgeAdmin.list.filters.statusActive')}</SelectItem>
            <SelectItem value="archived">{t('knowledgeAdmin.list.filters.statusArchived')}</SelectItem>
          </SelectContent>
        </Select>
        <Select value={filters.ownerAgentId} onValueChange={(value) => updateFilter('ownerAgentId', value)}>
          <SelectTrigger className={cn(SELECT_TRIGGER_CLASS, 'w-[160px]')} aria-label={t('knowledgeAdmin.list.filters.owner')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_FILTER_VALUE}>{t('knowledgeAdmin.list.filters.ownerAll')}</SelectItem>
            {agents.map((agent) => (
              <SelectItem key={agent.id} value={agent.id}>
                <RawContent value={agent.name} />
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filters.teamId} onValueChange={(value) => updateFilter('teamId', value)}>
          <SelectTrigger className={cn(SELECT_TRIGGER_CLASS, 'w-[160px]')} aria-label={t('knowledgeAdmin.list.filters.team')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_FILTER_VALUE}>{t('knowledgeAdmin.list.filters.teamAll')}</SelectItem>
            {teams.map((team) => (
              <SelectItem key={team.id} value={team.id}>
                <RawContent value={team.name} />
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          value={filters.q}
          placeholder={t('knowledgeAdmin.list.filters.searchPlaceholder')}
          onChange={(event) => updateFilter('q', event.target.value)}
          className="h-[34px] w-[220px] rounded-[10px] border-[0.5px] border-[#e3e7f1] bg-white text-[12px]"
        />
      </div>

      <div className="mt-[16px]">
        <DataTable
          columns={columns}
          data={visibleItems}
          rowKey={(row) => row.id}
          loading={loading}
          emptyText={t('knowledgeAdmin.list.empty')}
          onRowClick={(row) => navigate(`${EnterpriseRoute.KnowledgeAdmin}/${row.id}`)}
          aria-label={t('knowledgeAdmin.list.title')}
        />
      </div>

      <CreateKnowledgeBaseDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        agents={agents}
        submitting={creating}
        onSubmit={(draft) => void handleCreate(draft)}
      />

      <DeleteDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        name={deleteTarget?.name || ''}
        draftCount={deleteTarget?.draft_count || 0}
        loading={deleting}
        onConfirm={() => void confirmDelete()}
      />

      <SharedKnowledgeConversionDialog
        open={Boolean(conversionState)}
        knowledgeBase={conversionState?.kb ?? null}
        agentId={conversionState?.agentId ?? ''}
        onClose={() => setConversionState(null)}
        onConverted={() => void handleConverted()}
      />
    </div>
  );
}
