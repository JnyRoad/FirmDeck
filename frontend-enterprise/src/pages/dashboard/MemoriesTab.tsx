import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { DataTable, type DataTableColumn } from '@/components/DataTable';
import { DetailField } from '@/components/DetailField';
import { Paginator } from '@/components/Paginator';
import { Button as UIButton } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  Select as UISelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui';
import { notify } from '@/components/ui/app-toast';
import { RawContent, RawIdentifier } from '@/i18n/RawContent';
import { useAppIntl } from '@/i18n/useAppIntl';
import { apiErrorMessage } from '@/lib/apiErrorMessages';
import { cn } from '@/lib/utils';
import { MOBILE_CARD_CLASS, formatDateTime } from '@/lib/enterprise-ui';

import { createTenantClient } from '../../api/tenant-client';
import IconListBulleted from '../../assets/icons/list-bulleted.svg?react';
import IconHistory from '../../assets/icons/profile-history.svg?react';
import IconRefresh from '../../assets/icons/refresh.svg?react';
import IconSearch from '../../assets/icons/search.svg?react';
import type { EnterpriseAuthUser } from '../../auth';
import { useTenantSession } from '../../contexts/TenantSessionContext';
import { canManageEmployeeAgent } from '../../employee';
import { useClientPagination } from '../../hooks/useClientPagination';
import { isTeamScope, readEmployeeScope } from '../../lib/agent-scope-storage';
import { tenantUserStorageKey } from '../../lib/tenant-storage';
import type { AgentProfileRead, MemoryRead } from '../../types';

const MEMORY_PAGE_SIZE = 10;
const ALL_USERS_VALUE = '__all__';
const MEMORY_FILTER_FEATURE = 'memories-filter';

type MemoryFilter = {
  username: string;
  user_id: string;
  q: string;
};

type MemoryUserGroup = {
  key: string;
  username?: string;
  user_id: string;
  memories: MemoryRead[];
  kinds: string[];
  latest_at: string;
  preview: string;
};

const EMPTY_FILTER: MemoryFilter = { username: '', user_id: '', q: '' };

/** Generate the tenant/user namespace for the memories filter state. */
function memoryFilterStorageKey(tenantId: string, userId: string): string {
  return tenantUserStorageKey(tenantId, userId, MEMORY_FILTER_FEATURE);
}

/** Read a validated memories filter without adopting any legacy unscoped value. */
function readMemoryFilter(tenantId: string, userId: string): MemoryFilter {
  try {
    const raw = window.localStorage.getItem(memoryFilterStorageKey(tenantId, userId));
    if (!raw) return EMPTY_FILTER;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return EMPTY_FILTER;
    return {
      username: typeof parsed.username === 'string' ? parsed.username : '',
      user_id: typeof parsed.user_id === 'string' ? parsed.user_id : '',
      q: typeof parsed.q === 'string' ? parsed.q : '',
    };
  } catch {
    return EMPTY_FILTER;
  }
}

/** Persist the memories filter only under the verified tenant/user namespace. */
function persistMemoryFilter(tenantId: string, userId: string, filter: MemoryFilter): void {
  try {
    window.localStorage.setItem(memoryFilterStorageKey(tenantId, userId), JSON.stringify(filter));
  } catch {
    // A blocked or full browser store must not affect server-backed memories.
  }
}

/** 将未知异常折叠为安全语义错误，避免把原始 Error.message 直接显示给用户。 */
function memoryTabErrorMessage(
  error: unknown,
  fallback: string,
  genericMessage: string,
): string {
  const message = apiErrorMessage(error, 'common.error.generic');
  return message === genericMessage ? fallback : message;
}

/** 按当前 locale 格式化记忆条数，避免把数字拼到固定语言片段里。 */
function formatMemoryCount(
  count: number,
  noun: 'memory' | 'entry',
  translate: ReturnType<typeof useAppIntl>['t'],
): string {
  return noun === 'memory'
    ? translate('dashboard.memories.count.memories', { count })
    : translate('dashboard.memories.count.entries', { count });
}

/** 将已知记忆类型映射为语义标签；未知类型保持原始标识，不写入产品文案。 */
function memoryKindLabel(kind: string, translate: ReturnType<typeof useAppIntl>['t']): string | null {
  if (kind === 'profile') return translate('dashboard.memories.kind.profile');
  if (kind === 'summary') return translate('dashboard.memories.kind.summary');
  return null;
}

export default function MemoriesTab({
  currentUser,
  agent,
}: {
  currentUser?: EnterpriseAuthUser;
  agent?: AgentProfileRead | null;
} = {}) {
  const { t } = useAppIntl();
  const tenantContext = useTenantSession();
  const tenantClient = useMemo(() => createTenantClient(tenantContext), [tenantContext]);
  const tenantId = tenantContext?.tenantId || '';
  const userId = tenantContext?.userId || '';
  const tenantScopeKey = tenantContext
    ? `${tenantId}:${userId}:${tenantContext.generation}`
    : '';
  const scopeKeyRef = useRef('');
  const loadControllerRef = useRef<AbortController | null>(null);
  const agentIdRef = useRef('');
  const scopeRevisionRef = useRef(0);
  const actionControllersRef = useRef(new Set<AbortController>());
  const [scopeReady, setScopeReady] = useState(false);
  const [rows, setRows] = useState<MemoryRead[]>([]);
  const [detail, setDetail] = useState<MemoryUserGroup | null>(null);
  const [loading, setLoading] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [agentId, setAgentId] = useState('');
  const [filter, setFilter] = useState<MemoryFilter>(EMPTY_FILTER);
  // Keep the latest selected employee visible to in-flight callbacks before passive effects run.
  agentIdRef.current = agentId;

  /** Abort destructive actions when the employee scope changes or this tab unmounts. */
  function cancelActionControllers() {
    actionControllersRef.current.forEach((controller) => controller.abort());
    actionControllersRef.current.clear();
  }

  /** Advance the employee scope revision synchronously and clear stale action UI. */
  function updateAgentScope(nextAgentId: string) {
    agentIdRef.current = nextAgentId;
    scopeRevisionRef.current += 1;
    cancelActionControllers();
    setClearing(false);
    setRows([]);
    setDetail(null);
    setAgentId(nextAgentId);
  }

  useEffect(() => () => cancelActionControllers(), [tenantContext?.generation]);

  /** 读取当前筛选下的记忆列表；未知异常统一回退到安全语义错误。 */
  const load = useCallback(async (next: MemoryFilter) => {
    if (!tenantContext || !tenantId || !userId || !scopeReady || scopeKeyRef.current !== tenantScopeKey) return;
    loadControllerRef.current?.abort();
    const requestController = new AbortController();
    loadControllerRef.current = requestController;
    const generation = tenantContext.generation;
    const capturedAgentId = agentId;
    const capturedScopeRevision = scopeRevisionRef.current;
    const isCurrent = () => (
      !requestController.signal.aborted
      && tenantContext.isCurrentGeneration(generation)
      && scopeKeyRef.current === tenantScopeKey
      && agentIdRef.current === capturedAgentId
      && scopeRevisionRef.current === capturedScopeRevision
    );
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (agentId) params.set('agent_id', agentId);
      if (next.username.trim()) params.set('username', next.username.trim());
      if (next.user_id.trim()) params.set('user_id', next.user_id.trim());
      if (next.q.trim()) params.set('q', next.q.trim());
      params.set('limit', '500');
      const result = await tenantClient.get<MemoryRead[]>(`/api/enterprise/memories?${params.toString()}`, {
        signal: requestController.signal,
      });
      if (!isCurrent()) return;
      setRows(result);
    } catch (error) {
      if (isCurrent()) {
        notify.error(memoryTabErrorMessage(error, t('dashboard.memories.toast.loadFailed'), t('common.error.generic')));
      }
    } finally {
      if (loadControllerRef.current === requestController) {
        loadControllerRef.current = null;
        if (isCurrent()) setLoading(false);
      }
    }
  }, [agentId, scopeReady, t, tenantClient, tenantContext, tenantId, tenantScopeKey, userId]);

  useEffect(() => {
    if (!tenantContext || !tenantId || !userId) {
      scopeKeyRef.current = '';
      agentIdRef.current = '';
      scopeRevisionRef.current += 1;
      cancelActionControllers();
      setScopeReady(false);
      setAgentId('');
      setRows([]);
      setFilter(EMPTY_FILTER);
      return;
    }
    scopeKeyRef.current = tenantScopeKey;
    const nextAgentId = readEmployeeScope(tenantId, userId);
    agentIdRef.current = nextAgentId;
    scopeRevisionRef.current += 1;
    cancelActionControllers();
    setAgentId(nextAgentId);
    setRows([]);
    setFilter(readMemoryFilter(tenantId, userId));
    setScopeReady(true);
  }, [tenantContext, tenantId, tenantScopeKey, userId]);

  useEffect(() => {
    const onScopeChange = (event: Event) => {
      const next = (event as CustomEvent<{ agentId?: string }>).detail?.agentId || '';
      if (!tenantContext || !tenantId || !userId || scopeKeyRef.current !== tenantScopeKey) return;
      updateAgentScope(next && !isTeamScope(next) ? next : readEmployeeScope(tenantId, userId));
    };
    window.addEventListener('ultrarag-enterprise-agent-scope-change', onScopeChange);
    return () => window.removeEventListener('ultrarag-enterprise-agent-scope-change', onScopeChange);
  }, [tenantContext, tenantId, tenantScopeKey, userId]);

  useEffect(() => {
    void load(filter);
    return () => {
      loadControllerRef.current?.abort();
    };
  }, [agentId, load]);

  useEffect(() => {
    if (!tenantContext || !tenantId || !userId || !scopeReady || scopeKeyRef.current !== tenantScopeKey) return;
    persistMemoryFilter(tenantId, userId, filter);
  }, [filter, scopeReady, tenantContext, tenantId, tenantScopeKey, userId]);

  const groups = useMemo(() => groupMemories(rows), [rows]);
  const pagination = useClientPagination(groups, MEMORY_PAGE_SIZE, groups);
  const canFilterUsers = agent ? canManageEmployeeAgent(agent, currentUser) : false;
  const userOptions = useMemo(() => {
    const map = new Map<string, string>();
    rows.forEach((row) => {
      if (row.user_id && !map.has(row.user_id)) {
        map.set(row.user_id, row.username || row.user_id);
      }
    });
    return Array.from(map.entries()).map(([user_id, label]) => ({ user_id, label }));
  }, [rows]);
  const emptyText = agentId
    ? t('dashboard.memories.empty.scoped')
    : t('dashboard.memories.empty.global');

  /** 重置当前筛选并重新加载列表，避免保留跨用户的旧查询条件。 */
  function resetFilter() {
    setFilter(EMPTY_FILTER);
    void load(EMPTY_FILTER);
  }

  /** Fence destructive memory actions to the captured employee and scope revision. */
  function beginActionFence() {
    if (!tenantContext || !tenantId || !userId || !scopeReady || scopeKeyRef.current !== tenantScopeKey) return null;
    const requestController = new AbortController();
    actionControllersRef.current.add(requestController);
    const generation = tenantContext.generation;
    const capturedAgentId = agentId;
    const capturedScopeRevision = scopeRevisionRef.current;
    return {
      signal: requestController.signal,
      isCurrent: () => (
        !requestController.signal.aborted
        && tenantContext.isCurrentGeneration(generation)
        && scopeKeyRef.current === tenantScopeKey
        && agentIdRef.current === capturedAgentId
        && scopeRevisionRef.current === capturedScopeRevision
      ),
      release: () => actionControllersRef.current.delete(requestController),
    };
  }

  /** 仅清空当前用户在当前作用域下的长期记忆，不影响其他用户数据。 */
  async function clearOwnMemories() {
    const confirmed = window.confirm(
      agentId
        ? t('dashboard.memories.confirm.clearScoped')
        : t('dashboard.memories.confirm.clearGlobal'),
    );
    if (!confirmed) return;

    const fence = beginActionFence();
    if (!fence) return;
    if (!tenantContext || !tenantId || !userId || !scopeReady || !fence.isCurrent()) {
      fence.release();
      return;
    }
    setClearing(true);
    try {
      const params = new URLSearchParams();
      if (agentId) params.set('agent_id', agentId);
      const result = await tenantClient.delete<{ deleted: number }>(
        `/api/enterprise/memories/me?${params.toString()}`,
        undefined,
        { signal: fence.signal },
      );
      if (!fence.isCurrent()) return;
      notify.successText(
        result.deleted > 0
          ? t('dashboard.memories.toast.clearSuccess', { count: result.deleted })
          : t('dashboard.memories.toast.clearEmpty'),
      );
      if (!fence.isCurrent()) return;
      setDetail(null);
      await load(filter);
    } catch (error) {
      if (fence.isCurrent()) {
        notify.error(memoryTabErrorMessage(error, t('dashboard.memories.toast.clearFailed'), t('common.error.generic')));
      }
    } finally {
      if (fence.isCurrent()) setClearing(false);
      fence.release();
    }
  }

  const columns: DataTableColumn<MemoryUserGroup>[] = [
    {
      key: 'username',
      title: t('dashboard.memories.table.column.username'),
      width: 200,
      className: 'align-top whitespace-normal text-[#18181a]',
      render: (row) => (
        <span className="block max-w-full break-all leading-[1.55]" title={row.username || undefined}>
          {row.username ? <RawContent value={row.username} /> : t('dashboard.memories.value.none')}
        </span>
      ),
    },
    {
      key: 'user_id',
      title: t('dashboard.memories.table.column.userId'),
      width: 180,
      className: 'align-top whitespace-normal',
      render: (row) => (
        <span className="block max-w-full break-all leading-[1.55]" title={row.user_id}>
          <RawIdentifier value={row.user_id} />
        </span>
      ),
    },
    {
      key: 'kinds',
      title: t('dashboard.memories.table.column.type'),
      width: 120,
      render: (row) => (
        <div className="flex flex-wrap gap-[4px]">
          {row.kinds.map((kind) => (
            <MemoryKindBadge key={kind} kind={kind} />
          ))}
        </div>
      ),
    },
    {
      key: 'count',
      title: t('dashboard.memories.table.column.count'),
      width: 100,
      render: (row) => formatMemoryCount(row.memories.length, 'entry', t),
    },
    {
      key: 'latest',
      title: t('dashboard.memories.table.column.latest'),
      width: 170,
      render: (row) => formatDateTime(row.latest_at),
    },
    {
      key: 'preview',
      title: t('dashboard.memories.table.column.summary'),
      className: 'whitespace-normal',
      render: (row) => (
        <span className="wrap-break-word">
          {row.preview ? <RawContent value={row.preview} /> : t('dashboard.memories.value.none')}
        </span>
      ),
    },
    {
      key: 'actions',
      title: t('dashboard.memories.table.column.actions'),
      width: 100,
      render: (row) => (
        <UIButton
          variant="link"
          onClick={() => setDetail(row)}
          className="h-auto p-0 text-[12px] font-normal text-[#1a71ff] hover:text-[#4a8dff] hover:no-underline"
        >
          {t('dashboard.memories.action.view')}
        </UIButton>
      ),
    },
  ];

  /** 复用桌面表格字段语义生成移动卡片，保证移动端与桌面端一致。 */
  const renderMobileCard = (row: MemoryUserGroup) => (
    <article className={MOBILE_CARD_CLASS} key={row.key}>
      <div className="flex min-w-0 items-start justify-between gap-[10px]">
        <strong className="min-w-0 truncate text-[14px] font-semibold text-[#18181a]">
          {row.username ? <RawContent value={row.username} /> : <RawIdentifier value={row.user_id} />}
        </strong>
        <UIButton
          variant="link"
          onClick={() => setDetail(row)}
          className="h-auto shrink-0 p-0 text-[12px] font-normal text-[#1a71ff] hover:text-[#4a8dff] hover:no-underline"
        >
          {t('dashboard.memories.action.view')}
        </UIButton>
      </div>
      <div className="mt-[8px] flex flex-wrap gap-[4px]">
        {row.kinds.map((kind) => (
          <MemoryKindBadge key={kind} kind={kind} />
        ))}
      </div>
      <p className="mt-[8px] line-clamp-2 text-[12px] leading-[1.55] text-[#858b9c]">
        {row.preview ? <RawContent value={row.preview} /> : t('dashboard.memories.value.none')}
      </p>
      <div className="mt-[10px] flex items-center justify-between text-[12px] text-[#858b9c]">
        <span>{formatMemoryCount(row.memories.length, 'memory', t)}</span>
        <span>{formatDateTime(row.latest_at)}</span>
      </div>
    </article>
  );

  return (
    <>
      <section
        aria-busy={loading}
        className="relative mt-[-2px] flex w-full min-w-0 max-w-full flex-col gap-[24px] overflow-hidden rounded-[18px] bg-white p-[14px] shadow-[0_20px_42px_rgba(21,26,38,0.045)] min-[521px]:p-[18px]"
      >
        <div className="flex flex-col gap-[18px]">
          <div className="flex items-center gap-[6px] px-[12px] text-[#757f9c]">
            <IconHistory className="size-[14px] shrink-0" />
            <span className="text-[14px] font-normal leading-none">{t('dashboard.memories.section.title')}</span>
          </div>

          <form
            className="flex flex-wrap items-center gap-[16px]"
            onSubmit={(event) => {
              event.preventDefault();
              void load(filter);
            }}
          >
            {canFilterUsers && (
              <label className="flex h-[34px] w-[260px] items-center overflow-hidden rounded-[10px] border-[0.5px] border-[#e3e7f1] bg-white transition-colors focus-within:border-primary max-[900px]:w-full">
                <span className="flex h-full w-[58px] shrink-0 items-center justify-center border-r-[0.5px] border-[#e3e7f1] bg-[#f6f6f6] text-[12px] text-[#858b9c]">
                  {t('dashboard.memories.filter.userScope')}
                </span>
                <UISelect
                  value={filter.user_id || ALL_USERS_VALUE}
                  onValueChange={(value) => {
                    const next = {
                      ...filter,
                      user_id: value === ALL_USERS_VALUE ? '' : value,
                    };
                    setFilter(next);
                    void load(next);
                  }}
                >
                  <SelectTrigger className="h-full min-w-0 flex-1 rounded-none border-0 px-[12px] text-[12px] shadow-none focus:ring-0">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_USERS_VALUE}>{t('dashboard.memories.filter.allUsers')}</SelectItem>
                    {userOptions.map((option) => (
                      <SelectItem key={option.user_id} value={option.user_id}>
                        <RawContent value={option.label} />
                      </SelectItem>
                    ))}
                  </SelectContent>
                </UISelect>
              </label>
            )}
            <PrefixInput
              label={t('dashboard.memories.filter.usernameLabel')}
              placeholder={t('dashboard.memories.filter.exampleUsername')}
              value={filter.username}
              onChange={(value) => setFilter((prev) => ({ ...prev, username: value }))}
            />
            <PrefixInput
              label={t('dashboard.memories.filter.userIdLabel')}
              placeholder={t('dashboard.memories.filter.exampleUsername')}
              value={filter.user_id}
              onChange={(value) => setFilter((prev) => ({ ...prev, user_id: value }))}
            />
            <PrefixInput
              label={t('dashboard.memories.filter.searchLabel')}
              placeholder={t('dashboard.memories.filter.searchPlaceholder')}
              value={filter.q}
              onChange={(value) => setFilter((prev) => ({ ...prev, q: value }))}
            />
            <UIButton
              type="submit"
              disabled={loading}
              className="h-[34px] w-[80px] gap-[4px] rounded-[10px] bg-primary px-[20px] text-[12px] font-normal text-white hover:bg-primary/80"
            >
              <IconSearch className="size-[14px]" />
              {t('dashboard.memories.action.search')}
            </UIButton>
            <UIButton
              type="button"
              variant="outline"
              onClick={resetFilter}
              disabled={loading}
              className="h-[34px] w-[80px] gap-[4px] rounded-[10px] border-[0.5px] border-[#e3e7f1] bg-white px-[20px] text-[12px] font-normal text-[#757f9c] hover:border-[#cbd3e6] hover:bg-white hover:text-primary"
            >
              <IconRefresh className={cn('size-[14px]', loading && 'animate-spin')} />
              {t('dashboard.memories.action.reset')}
            </UIButton>
            <UIButton
              type="button"
              variant="outline"
              onClick={clearOwnMemories}
              disabled={loading || clearing}
              className="h-[34px] w-[112px] rounded-[10px] border-[0.5px] border-[#f0d3d3] bg-white px-[16px] text-[12px] font-normal text-[#c43d3d] hover:border-[#e1a8a8] hover:bg-[#fff7f7] hover:text-[#a92d2d]"
            >
              {clearing ? t('dashboard.memories.action.clearing') : t('dashboard.memories.action.clear')}
            </UIButton>
          </form>

          <div className="grid gap-[10px] md:hidden">
            {groups.length ? (
              pagination.pagedItems.map(renderMobileCard)
            ) : (
              <div className="py-[40px] text-center text-[13px] text-[#858b9c]">{emptyText}</div>
            )}
          </div>

          <div className="hidden md:block">
            <DataTable
              aria-label={t('dashboard.memories.table.ariaLabel')}
              columns={columns}
              data={pagination.pagedItems}
              rowKey={(row) => row.key}
              loading={loading}
              emptyText={emptyText}
            />
          </div>

          {groups.length > 0 && (
            <Paginator
              aria-label={t('dashboard.memories.pagination.ariaLabel')}
              className="mt-0 mb-[6px]"
              page={pagination.page}
              pageCount={pagination.pageCount}
              onChange={pagination.setPage}
            />
          )}
        </div>
      </section>

      <MemoryDetailDialog detail={detail} onClose={() => setDetail(null)} />
    </>
  );
}

function PrefixInput({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex h-[34px] w-[260px] items-center overflow-hidden rounded-[10px] border-[0.5px] border-[#e3e7f1] bg-white transition-colors focus-within:border-primary max-[900px]:w-full">
      <span className="flex h-full w-[58px] shrink-0 items-center justify-center border-r-[0.5px] border-[#e3e7f1] bg-[#f6f6f6] text-[12px] text-[#858b9c]">
        {label}
      </span>
      <input
        autoComplete="off"
        data-1p-ignore="true"
        data-lpignore="true"
        data-bwignore="true"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="h-full min-w-0 flex-1 bg-transparent px-[12px] text-[12px] text-[#17191f] outline-none placeholder:text-[#c0c6d4]"
      />
    </label>
  );
}

function MemoryKindBadge({ kind }: { kind: string }) {
  const { t } = useAppIntl();
  const tone = MEMORY_KIND_TONE[kind] ?? 'gray';
  const label = memoryKindLabel(kind, t);
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-[12px] py-[4px] text-[12px] leading-none capitalize whitespace-nowrap',
        MEMORY_KIND_TONE_CLASS[tone],
      )}
    >
      {label ? label : <RawIdentifier value={kind} />}
    </span>
  );
}

function MemoryDetailDialog({
  detail,
  onClose,
}: {
  detail: MemoryUserGroup | null;
  onClose: () => void;
}) {
  const { t } = useAppIntl();
  return (
    <Dialog open={Boolean(detail)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        aria-describedby={undefined}
        className="flex max-h-[calc(100dvh-4rem)] w-[calc(100%-2rem)] flex-col gap-[16px] overflow-hidden rounded-[14px] px-[20px] py-[16px] sm:max-w-[720px]"
      >
        <div className="flex items-center gap-[6px] px-[12px] text-[#757f9c]">
          <IconListBulleted className="size-[14px] shrink-0" />
          <DialogTitle className="text-[14px] font-normal leading-none text-[#757f9c]">
            {t('dashboard.memories.detail.title')}
          </DialogTitle>
        </div>

        {detail && (
          <div className="flex min-h-0 flex-1 flex-col gap-[16px] overflow-y-auto px-[12px]">
            <div className="grid grid-cols-2 gap-[10px] max-[520px]:grid-cols-1">
              <DetailField label={t('dashboard.memories.detail.username')}>
                {detail.username ? <RawContent value={detail.username} /> : t('dashboard.memories.value.none')}
              </DetailField>
              <DetailField label={t('dashboard.memories.detail.userId')}><RawIdentifier value={detail.user_id} /></DetailField>
              <DetailField label={t('dashboard.memories.detail.count')}>
                {formatMemoryCount(detail.memories.length, 'memory', t)}
              </DetailField>
              <DetailField label={t('dashboard.memories.detail.type')}>
                <div className="flex flex-wrap gap-[4px]">
                  {detail.kinds.map((kind) => (
                    <MemoryKindBadge key={kind} kind={kind} />
                  ))}
                </div>
              </DetailField>
            </div>

            <div className="flex flex-col gap-[12px]">
              {detail.memories.map((item) => (
                <article
                  key={item.id}
                  className="rounded-[12px] border border-[#eef0f4] bg-white p-[14px]"
                >
                  <div className="flex items-center justify-between gap-[10px]">
                    <MemoryKindBadge kind={item.kind} />
                    <span className="text-[12px] text-[#858b9c]">{formatDateTime(item.updated_at)}</span>
                  </div>
                  <div className="mt-[10px] flex flex-wrap gap-x-[16px] gap-y-[4px] text-[12px] text-[#858b9c]">
                    <span>{t('dashboard.memories.detail.importance')}: {item.importance}</span>
                    <span>{t('dashboard.memories.detail.session')}: {item.session_id || t('dashboard.memories.value.none')}</span>
                  </div>
                  <p className="mt-[8px] text-[13px] leading-[1.6] text-[#18181a] wrap-break-word">
                    <RawContent value={item.content} />
                  </p>
                  {Object.keys(item.metadata || {}).length > 0 && (
                    <details className="mt-[10px] text-[12px] text-[#858b9c]">
                      <summary className="cursor-pointer select-none">{t('dashboard.memories.detail.metadata')}</summary>
                      <pre className="mt-[6px] overflow-x-auto rounded-[8px] bg-[#f6f6f6] p-[10px] text-[11px] leading-normal text-[#464c5e]">
                        {JSON.stringify(item.metadata, null, 2)}
                      </pre>
                    </details>
                  )}
                </article>
              ))}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

type MemoryTone = 'blue' | 'green' | 'gray';

const MEMORY_KIND_TONE: Record<string, MemoryTone> = {
  profile: 'blue',
  summary: 'green',
};

const MEMORY_KIND_TONE_CLASS: Record<MemoryTone, string> = {
  blue: 'bg-[#e8f0ff] text-[#1a71ff]',
  green: 'bg-[#e9f7ef] text-[#2cb360]',
  gray: 'bg-[#f2f3f7] text-[#858b9c]',
};

/** 按用户聚合原始记忆列表，保留每条原文内容和最近更新时间，供表格与详情共用。 */
function groupMemories(rows: MemoryRead[]): MemoryUserGroup[] {
  const map = new Map<string, MemoryRead[]>();
  rows.forEach((row) => {
    const key = row.username || row.user_id;
    const existing = map.get(key) || [];
    existing.push(row);
    map.set(key, existing);
  });
  return Array.from(map.entries())
    .map(([key, memories]) => {
      const sorted = [...memories].sort(
        (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
      );
      const kinds = Array.from(new Set(sorted.map((item) => item.kind))).sort();
      return {
        key,
        username: sorted[0]?.username,
        user_id: sorted[0]?.user_id || key,
        memories: sorted,
        kinds,
        latest_at: sorted[0]?.updated_at,
        preview: sorted
          .map((item) => item.content.replace(/\s+/g, ' ').trim())
          .filter(Boolean)
          .join(' / '),
      };
    })
    .sort((a, b) => new Date(b.latest_at).getTime() - new Date(a.latest_at).getTime());
}
