/**
 * 知识库管理 · 列表页：租户管理员总览全部共享库与私有库（US1）。
 * 统计卡（总数/共享/私有/文档数）、类型页签、四类筛选 + 搜索、新建、
 * 行 `⋯` 菜单（按 mode 差异）、上线/下线与删除二次确认。
 * 表格分页走服务端 offset/limit（US5，T073）：`Paginator` 只切 `page`，不改任何
 * 筛选条件；筛选/类型页签变化会把 `page` 重置回第 1 页并带着新筛选重新请求。
 * `pageCount` 以 A1 响应 `total` 为准，`has_more=true` 时至少多留一页兜底。
 * 页面不读取 `readEmployeeScope`，也不监听 agent-scope 事件；数据只经
 * `api/knowledgeAdmin.ts`。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { createKnowledgeAdminApi } from '@/api/knowledgeAdmin';
import AppHeader from '@/components/AppHeader';
import { DataTable, type DataTableColumn } from '@/components/DataTable';
import { KnowledgeTypeBadge } from '@/components/knowledge/KnowledgeTypeBadge';
import { SharedKnowledgeConversionDialog } from '@/components/knowledge/SharedKnowledgeConversionDialog';
import { Paginator } from '@/components/Paginator';
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
import { useKnowledgeAdminToast } from './shared/errorMessage';
import {
  ALL_FILTER_VALUE,
  defaultKnowledgeAdminListFilters,
  isUnboundSharedKnowledgeBase,
  knowledgeAdminSyncStateBadge,
  knowledgeAdminVersionBadge,
  sortKnowledgeAdminListItems,
  type KnowledgeAdminListFilters,
} from './knowledgeAdminModel';

/** 搜索输入防抖时长；避免每次按键都触发一次服务端请求。 */
const SEARCH_DEBOUNCE_MS = 300;

/** A1 每页条数；`Paginator` 按 `Math.ceil(total / LIST_PAGE_SIZE)` 算总页数。 */
const LIST_PAGE_SIZE = 20;

/** 把筛选态里的 `'all'` 哨兵值折叠为 `undefined`，交给 `appendQuery` 从请求里整体省略该参数。 */
function toApiFilterValue(value: string): string | undefined {
  return value === ALL_FILTER_VALUE ? undefined : value;
}

const EMPTY_SUMMARY: KnowledgeAdminListSummary = { total: 0, shared: 0, dedicated: 0, documents: 0 };

export type KnowledgeAdminListPageProps = {
  currentUser?: EnterpriseAuthUser;
  onLogout?: () => void;
};

export default function KnowledgeAdminListPage({ currentUser, onLogout }: KnowledgeAdminListPageProps = {}) {
  const navigate = useNavigate();
  const { t, locale } = useAppIntl();
  const toast = useKnowledgeAdminToast();
  const tenantContext = useTenantSession();
  const api = useMemo(() => createKnowledgeAdminApi(tenantContext), [tenantContext]);
  const uiSinks = useMemo(() => createUiSinks({ t }), [t]);
  /**
   * 已绑定群组名的连接方式必须跟随界面语言：中文的顿号「、」在英文里应当是 `, `。
   * `type: 'conjunction' + style: 'narrow'` 是唯一同时给出 zh 顿号和 en 逗号的组合
   * （`type: 'unit'` 在 zh 下退化成完全没有分隔符）。
   */
  const teamNameListFormat = useMemo(
    () => new Intl.ListFormat(locale, { type: 'conjunction', style: 'narrow' }),
    [locale],
  );

  const [items, setItems] = useState<KnowledgeAdminListItem[]>([]);
  const [summary, setSummary] = useState<KnowledgeAdminListSummary>(EMPTY_SUMMARY);
  const [agents, setAgents] = useState<AgentProfileRead[]>([]);
  const [teams, setTeams] = useState<KnowledgeAdminTeamOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState<KnowledgeAdminListFilters>(defaultKnowledgeAdminListFilters());
  const [searchInput, setSearchInput] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<KnowledgeAdminListItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [conversionState, setConversionState] = useState<{ kb: KnowledgeBaseRead; agentId: string } | null>(null);

  // 服务端 offset/limit 分页：`page` 是 1-based 当前页，`total`/`hasMore` 取自 A1 响应，
  // 供 `Paginator` 算总页数与"是否还有更多"判断用；筛选变化时重置回第 1 页（见下方
  // effect），翻页不改变任何筛选条件（仅带着当前筛选换 `offset`）。
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  // 优先信任 `total`；但如果服务端 `has_more=true` 而 `total` 暂时算不出足够页数
  // （例如响应字段不一致），至少多留一页，不让"下一页"按钮被误禁用。
  const pageCount = Math.max(1, Math.ceil(total / LIST_PAGE_SIZE), hasMore ? page + 1 : page);

  // 每类请求各自的递增序号；只有仍是"当前最新一次"的响应才会落到 state 上，防止筛选/页签快速
  // 切换时旧请求晚于新请求返回，把已经过期的数据覆盖回去（`isCurrentGeneration` 只保护跨租户/
  // 跨登录会话的场景，不感知同一会话内筛选态的变化，所以需要单独加这层）。
  const listRequestSeqRef = useRef(0);
  const summaryRequestSeqRef = useRef(0);

  function updateFilter<K extends keyof KnowledgeAdminListFilters>(key: K, value: KnowledgeAdminListFilters[K]) {
    setFilters((prev) => ({ ...prev, [key]: value }));
  }

  /** 搜索输入框先落到本地状态，300ms 内无新输入才折算进 `filters.q` 并触发服务端请求。 */
  useEffect(() => {
    const handle = window.setTimeout(() => updateFilter('q', searchInput), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  /**
   * 按当前全部筛选（含类型）+ 当前页向 A1 请求表格行；类型页签/筛选切换会触发重新请求
   * （并在下面的 effect 里先把 `page` 重置为 1），翻页只改变 `offset`。
   */
  async function loadList(targetPage: number = page) {
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return;
    const seq = ++listRequestSeqRef.current;
    setLoading(true);
    try {
      const listResult = await api.listKnowledgeBases({
        mode: toApiFilterValue(filters.mode) as KnowledgeBaseMode | undefined,
        status: toApiFilterValue(filters.status) as 'active' | 'archived' | undefined,
        ownerAgentId: toApiFilterValue(filters.ownerAgentId),
        teamId: toApiFilterValue(filters.teamId),
        q: filters.q,
        offset: (targetPage - 1) * LIST_PAGE_SIZE,
        limit: LIST_PAGE_SIZE,
      });
      if (!context.isCurrentGeneration(generation) || listRequestSeqRef.current !== seq) return;
      setItems(sortKnowledgeAdminListItems(Array.isArray(listResult?.items) ? listResult.items : []));
      setTotal(listResult?.total ?? 0);
      setHasMore(Boolean(listResult?.has_more));
    } catch (error) {
      if (!context.isCurrentGeneration(generation) || listRequestSeqRef.current !== seq) return;
      toast.error(error, 'knowledgeAdmin.toast.loadFailed');
    } finally {
      if (context.isCurrentGeneration(generation) && listRequestSeqRef.current === seq) setLoading(false);
    }
  }

  /**
   * 统计卡与类型页签计数共用同一份 `summary`：请求时刻意不带 `mode`，这样切换页签本身
   * 不会让其它页签的计数跟着归零，三个数字始终来自服务端同一个口径、互相一致。
   */
  async function loadSummary() {
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return;
    const seq = ++summaryRequestSeqRef.current;
    try {
      const result = await api.listKnowledgeBases({
        status: toApiFilterValue(filters.status) as 'active' | 'archived' | undefined,
        ownerAgentId: toApiFilterValue(filters.ownerAgentId),
        teamId: toApiFilterValue(filters.teamId),
        q: filters.q,
        limit: 1,
      });
      if (!context.isCurrentGeneration(generation) || summaryRequestSeqRef.current !== seq) return;
      setSummary(result?.summary ?? EMPTY_SUMMARY);
    } catch (error) {
      if (!context.isCurrentGeneration(generation) || summaryRequestSeqRef.current !== seq) return;
      toast.error(error, 'knowledgeAdmin.toast.loadFailed');
    }
  }

  /**
   * 归属员工 / 可绑定群组候选与当前筛选无关，只需要在挂载与手动刷新时拉取一次。
   *
   * T077 rerun Defect D5b 修复：`is_overall` 的"整体智能体"是系统资源池（开放广场载体），
   * 不是能被指定为私有知识库归属方的真实数字员工——这里排除它，与 `AgentsPage.tsx`、
   * `ChannelsPage.tsx`、`TeamDetailPage.tsx` 等页面对同一份 `listAgents()` 结果的既有过滤
   * 约定（`!agent.is_overall`）保持一致。此前遗漏这条过滤，"归属员工"筛选下拉与
   * `CreateKnowledgeBaseDialog` 的归属选择器（两者共用这份 `agents` state）都会连带带出
   * "整体智能体"这一行；en-US 下尤其显眼，因为它是业务数据（agent.name，经 `RawContent`
   * 逐字展示），本身从不参与产品文案翻译。
   */
  async function loadFilterOptions() {
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return;
    try {
      const [agentsResult, teamsResult] = await Promise.all([api.listAgents(), api.listBindableTeams({})]);
      if (!context.isCurrentGeneration(generation)) return;
      setAgents(Array.isArray(agentsResult) ? agentsResult.filter((agent) => !agent.is_overall) : []);
      setTeams(Array.isArray(teamsResult) ? teamsResult : []);
    } catch (error) {
      if (!context.isCurrentGeneration(generation)) return;
      toast.error(error, 'knowledgeAdmin.toast.loadFailed');
    }
  }

  /** 手动刷新按钮：同时重取列表、统计与筛选候选。 */
  async function refreshAll() {
    await Promise.all([loadList(), loadSummary(), loadFilterOptions()]);
  }

  useEffect(() => {
    void loadFilterOptions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  // 筛选（含类型页签）变化时把页码重置回第 1 页，且这次重置要用的页码在同一个 effect
  // 里同步算出来并直接发起请求；`lastLoadKeyRef` 记录"筛选 key + 页码"这个组合最近一次
  // 已经加载过，用来在 `setPage(1)` 引发的下一次 effect 重跑（`page` 依赖变化）里判断
  // 出那其实是这次重置的回显，从而跳过重复请求——避免旧写法里"筛选变化但仍在旧页码
  // 请求一次、`page` 变成 1 后又用新页码请求一次"的两次请求。`prevApiRef` 单独跟踪
  // `api`（租户切换会换一个新实例），保证租户切换即使筛选/页码都没变也照常重新加载。
  const lastLoadKeyRef = useRef('');
  const prevApiRef = useRef<typeof api | null>(null);

  useEffect(() => {
    const filtersKey = JSON.stringify([filters.mode, filters.status, filters.ownerAgentId, filters.teamId, filters.q]);
    const apiChanged = prevApiRef.current !== null && prevApiRef.current !== api;
    prevApiRef.current = api;
    const filtersChanged = lastLoadKeyRef.current !== '' && !lastLoadKeyRef.current.startsWith(`${filtersKey}|`);
    const targetPage = filtersChanged ? 1 : page;
    if (filtersChanged && page !== targetPage) setPage(targetPage);

    const loadKey = `${filtersKey}|${targetPage}`;
    if (!apiChanged && loadKey === lastLoadKeyRef.current) return;
    lastLoadKeyRef.current = loadKey;
    void loadList(targetPage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, filters.mode, filters.status, filters.ownerAgentId, filters.teamId, filters.q, page]);

  useEffect(() => {
    void loadSummary();
    // mode 不影响统计口径，故不在依赖里——切换类型页签不重取统计。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, filters.status, filters.ownerAgentId, filters.teamId, filters.q]);

  async function toggleStatus(row: KnowledgeAdminListItem) {
    try {
      await api.updateKnowledgeBase(row.id, { status: row.status === 'active' ? 'archived' : 'active' });
      toast.success(createMessageDescriptor('knowledgeAdmin.toast.updateSuccess'));
      await Promise.all([loadList(), loadSummary()]);
    } catch (error) {
      toast.error(error, 'knowledgeAdmin.toast.updateError');
    }
  }

  async function handleExport(row: KnowledgeAdminListItem) {
    try {
      const blob = await api.exportOkf(row.id, row.owner_agent?.id);
      uiSinks.download(blob, createMessageDescriptor('knowledgePage.download.backupPrefix'), row.name, 'okf.zip');
      toast.success(createMessageDescriptor('knowledgeAdmin.toast.exportSuccess'));
    } catch (error) {
      toast.error(error, 'knowledgeAdmin.toast.exportError');
    }
  }

  async function handleLint(row: KnowledgeAdminListItem) {
    try {
      const result = await api.lintOkf(row.id, row.owner_agent?.id);
      toast.success(
        result.issue_count
          ? createMessageDescriptor('knowledgeAdmin.toast.lintIssues', { count: result.issue_count })
          : createMessageDescriptor('knowledgeAdmin.toast.lintPassed'),
      );
    } catch (error) {
      toast.error(error, 'knowledgeAdmin.toast.lintError');
    }
  }

  async function openConversion(row: KnowledgeAdminListItem) {
    if (!row.owner_agent) return;
    try {
      const full = await api.getKnowledgeBase(row.id, row.owner_agent.id);
      setConversionState({ kb: full, agentId: row.owner_agent.id });
    } catch (error) {
      toast.error(error, 'knowledgeAdmin.toast.loadFailed');
    }
  }

  async function handleConverted() {
    toast.success(createMessageDescriptor('knowledgeAdmin.toast.convertSuccess'));
    setConversionState(null);
    await Promise.all([loadList(), loadSummary()]);
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
      toast.success(createMessageDescriptor('knowledgeAdmin.toast.createSuccess'));
      setCreateOpen(false);
      navigate(`${EnterpriseRoute.KnowledgeAdmin}/${created.id}`);
    } catch (error) {
      toast.error(error, 'knowledgeAdmin.toast.createError');
    } finally {
      setCreating(false);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.deleteKnowledgeBase(deleteTarget.id);
      toast.success(createMessageDescriptor('knowledgeAdmin.toast.deleteSuccess'));
      setDeleteTarget(null);
      await Promise.all([loadList(), loadSummary()]);
    } catch (error) {
      toast.error(error, 'knowledgeAdmin.toast.deleteError');
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
    return <RawContent value={teamNameListFormat.format(row.bound_teams.map((team) => team.name))} />;
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
            <TabsTrigger value={ALL_FILTER_VALUE}>{t('knowledgeAdmin.list.tabs.all')} ({summary.total})</TabsTrigger>
            <TabsTrigger value={KnowledgeBaseMode.Shared}>{t('knowledgeAdmin.list.tabs.shared')} ({summary.shared})</TabsTrigger>
            <TabsTrigger value={KnowledgeBaseMode.Dedicated}>{t('knowledgeAdmin.list.tabs.dedicated')} ({summary.dedicated})</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-[8px]">
          <Button
            variant="outline"
            onClick={() => void refreshAll()}
            disabled={loading}
            className={OUTLINE_ACTION_BUTTON_CLASS}
          >
            <IconRefresh className={cn('size-[14px]', loading && 'animate-spin')} />
            {t('knowledgeAdmin.list.actions.refresh')}
          </Button>
          <Button
            onClick={() => setCreateOpen(true)}
            className="h-[34px] gap-[4px] rounded-[10px] bg-primary px-[20px] text-[12px] font-normal text-white hover:bg-primary/80"
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
          value={searchInput}
          placeholder={t('knowledgeAdmin.list.filters.searchPlaceholder')}
          onChange={(event) => setSearchInput(event.target.value)}
          className="h-[34px] w-[220px] rounded-[10px] border-[0.5px] border-[#e3e7f1] bg-white text-[12px]"
        />
      </div>

      <div className="mt-[16px]">
        <DataTable
          columns={columns}
          data={items}
          rowKey={(row) => row.id}
          loading={loading}
          emptyText={t('knowledgeAdmin.list.empty')}
          onRowClick={(row) => navigate(`${EnterpriseRoute.KnowledgeAdmin}/${row.id}`)}
          aria-label={t('knowledgeAdmin.list.title')}
        />
        {pageCount > 1 && (
          <Paginator
            page={page}
            pageCount={pageCount}
            onChange={setPage}
            aria-label={t('knowledgeAdmin.list.pagination.ariaLabel')}
          />
        )}
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
