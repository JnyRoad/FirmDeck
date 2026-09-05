/**
 * 知识库管理 · 详情页：面包屑返回、标题（名称 + 类型/状态徽章）、描述，
 * 按 `mode` 渲染不同 Tab 集（共享：content/versions/grants/audit/settings；
 * 私有：content/branch/settings），`?tab=` 与 URL 同步、刷新后保持（FR-002）。
 * 私有库标题栏额外提供「转换为共享知识库」入口（US5，FR-082），archived 时禁用，
 * 打开既有 `SharedKnowledgeConversionDialog`（内部实现不动）；成功后跳转到新共享库
 * 的「群组与权限」页。私有库详情本身需要归属员工 id/展示名（`kb.metadata.owner_agent_id`
 * + `listAgents()`）驱动内容/分支 Tab 与向导的分支范围调用。
 * 页面不读取 `readEmployeeScope`，也不监听 agent-scope 事件。
 * `load()` 用 admin-first 的 `getAdminKnowledgeBase(kbId)`（不需要 `agent_id`）作为详情的
 * 主数据源——员工侧 `getKnowledgeBase` 不带 `agent_id` 只暴露开放广场库，管理员打开共享/
 * 专用库会 404 卡在 Loading（T077 缺陷 1）。专用库额外用换来的归属员工 id 补一次员工侧
 * `getKnowledgeBase(kbId, ownerId)`，取 admin 列表项没有的 `bucket_count`/`chunk_count`/
 * 真实 `branch_*` 字段；该次补拉失败时退回 admin 映射结果，页面仍可渲染。
 */

import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { createKnowledgeAdminApi } from '@/api/knowledgeAdmin';
import AppHeader from '@/components/AppHeader';
import { SharedKnowledgeConversionDialog } from '@/components/knowledge/SharedKnowledgeConversionDialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { useTenantSession } from '@/contexts/TenantSessionContext';
import { PublicationState } from '@/enums/knowledge';
import { EnterpriseRoute } from '@/enums/routes';
import { useAppIntl, type MessageId } from '@/i18n';
import { createMessageDescriptor } from '@/i18n/descriptors';
import { RawContent } from '@/i18n/RawContent';
import type { KnowledgeBaseConversionRead, KnowledgeBaseRead } from '@/types';
import type { KnowledgeAdminListItem } from '@/types/knowledgeAdmin';

import type { EnterpriseAuthUser } from '../../auth';
import { BranchTab as PrivateBranchTab } from './private/BranchTab';
import { ContentTab as PrivateContentTab } from './private/ContentTab';
import { AuditTab } from './shared/AuditTab';
import { ContentTab } from './shared/ContentTab';
import { useKnowledgeAdminToast } from './shared/errorMessage';
import { useGuardedLoad } from './shared/useGuardedLoad';
import { GrantsTab } from './shared/GrantsTab';
import { PlaceholderTab } from './shared/PlaceholderTab';
import { SettingsTab } from './shared/SettingsTab';
import { VersionsTab } from './shared/VersionsTab';

/** `kb.metadata.owner_agent_id` 是私有库唯一归属员工的存放位置（见 `app/agents/branching.py`）。 */
function ownerAgentIdOf(kb: KnowledgeBaseRead): string {
  const value = kb.metadata?.owner_agent_id;
  return typeof value === 'string' ? value : '';
}

/**
 * 把 admin-first 详情（`KnowledgeAdminListItem`，见 A1 列表项契约）映射成页面/子 Tab
 * 消费的 `KnowledgeBaseRead` 形状。用于：(1) 共享库——admin 端点即最终数据源，不再
 * 走员工侧 `getKnowledgeBase`；(2) 专用库——作为员工侧按归属员工重新查询之前/失败时的
 * 兜底（此时页面仍可渲染，只是 `bucket_count`/`chunk_count` 等 admin 列表项没有的字段
 * 取不到真实值，退化为 0）。
 */
function mapAdminItemToKb(item: KnowledgeAdminListItem, tenantId: string): KnowledgeBaseRead {
  return {
    id: item.id,
    tenant_id: tenantId,
    name: item.name,
    description: item.description ?? undefined,
    capability_scope: item.capability_scope,
    status: item.status,
    mode: item.mode,
    published_version_id: item.published_version_id,
    published_version: item.published_version,
    bound_team_count: item.bound_teams.length,
    version: item.published_version ?? undefined,
    branch_sync_state: item.branch?.sync_state,
    branch_base_version: item.branch?.base_version,
    branch_head_version: item.branch?.head_version,
    metadata: item.owner_agent ? { owner_agent_id: item.owner_agent.id } : undefined,
    document_count: item.document_count,
    bucket_count: 0,
    chunk_count: 0,
    created_at: item.updated_at,
    updated_at: item.updated_at,
  };
}

const SHARED_TABS = ['content', 'versions', 'grants', 'audit', 'settings'] as const;
const DEDICATED_TABS = ['content', 'branch', 'settings'] as const;

const TAB_LABEL_IDS: Record<string, MessageId> = {
  content: 'knowledgeAdmin.detail.tabs.content',
  versions: 'knowledgeAdmin.detail.tabs.versions',
  branch: 'knowledgeAdmin.detail.tabs.branch',
  grants: 'knowledgeAdmin.detail.tabs.grants',
  audit: 'knowledgeAdmin.detail.tabs.audit',
  settings: 'knowledgeAdmin.detail.tabs.settings',
};

export type KnowledgeAdminDetailPageProps = {
  currentUser?: EnterpriseAuthUser;
  onLogout?: () => void;
};

export default function KnowledgeAdminDetailPage({ currentUser, onLogout }: KnowledgeAdminDetailPageProps = {}) {
  const { kbId = '' } = useParams<{ kbId: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { t } = useAppIntl();
  const toast = useKnowledgeAdminToast();
  const tenantContext = useTenantSession();
  const api = useMemo(() => createKnowledgeAdminApi(tenantContext), [tenantContext]);

  const [kb, setKb] = useState<KnowledgeBaseRead | null>(null);
  const [loading, setLoading] = useState(false);
  /** `load()` 失败且尚无 `kb` 可渲染时为 true（I11）：驱动下面带「重试」按钮的错误态，
   * 避免加载失败后页面永远卡在「加载中…」。成功渲染过一次后 `kb` 不再是 `null`，
   * 后续刷新失败改由各 Tab/子组件自己的错误态处理，不影响这里。 */
  const [loadFailed, setLoadFailed] = useState(false);
  /** 设置 Tab 删除确认展示的进行中草稿数；私有库分支没有独立草稿概念，恒为 0。 */
  const [draftCount, setDraftCount] = useState(0);
  /** 草稿数是否未知（`listVersions` 单独失败）；与 `draftCount` 分开，避免把失败悄悄当成 0。 */
  const [draftCountUnknown, setDraftCountUnknown] = useState(false);
  /** 私有库归属员工 id/展示名；私有 Tab 集（内容/分支）与转共享向导都靠它驱动分支范围调用。 */
  const [ownerAgentName, setOwnerAgentName] = useState('');
  const [conversionOpen, setConversionOpen] = useState(false);
  /**
   * 过期响应护栏（I1）：`load()` 串了 4 个 await（admin 详情 → 员工侧详情 → 员工列表 →
   * 版本列表），而 effect 的依赖里有 `kbId`——在两个知识库之间来回跳转时，先发出的那一
   * 轮完全可能后返回，把上一个库的名称/模式/归属员工/草稿数整套盖到当前页面上。
   * 租户代际检查（原本只有这一道）拦不住同租户内的换库。用序号线一并覆盖两种情况。
   */
  const detailLoad = useGuardedLoad();

  async function load() {
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined || !kbId) return;
    const token = detailLoad.begin();
    setLoading(true);
    setLoadFailed(false);
    try {
      // Admin-first：员工侧 `GET /knowledge-bases/{id}` 不带 `agent_id` 时只暴露"开放广场"
      // 库，管理员打开共享/专用库详情会 404（`KNOWLEDGE_BASE_VERSION_NOT_VISIBLE`），页面
      // 卡在 Loading（T077 缺陷 1）。改用 admin 端点作为首次也是共享库唯一一次拉取，
      // 对共享/专用库都不需要 `agent_id` 即可读取。
      const adminItem = await api.getAdminKnowledgeBase(kbId);
      if (!detailLoad.isCurrent(token)) return;
      let result: KnowledgeBaseRead = mapAdminItemToKb(adminItem, context.tenantId);
      if (adminItem.mode === 'dedicated') {
        // admin 列表项没有 `bucket_count`/`chunk_count`，且 `branch_*` 由后端在拿到具体
        // agent 时才查询（`_knowledge_branch_meta`）；私有库详情/转共享向导需要这些真实
        // 字段，这里用刚拿到的归属员工 id 换取一次员工侧详情。查询失败时保留上面 admin
        // 映射出的 `result`（页面仍可用，只是这些字段会缺失/退化为 0），不整体判为加载失败。
        const ownerId = adminItem.owner_agent?.id || '';
        if (ownerId) {
          try {
            const scoped = await api.getKnowledgeBase(kbId, ownerId);
            if (!detailLoad.isCurrent(token)) return;
            result = scoped;
          } catch {
            if (!detailLoad.isCurrent(token)) return;
          }
          try {
            const agents = await api.listAgents();
            if (!detailLoad.isCurrent(token)) return;
            setOwnerAgentName(agents.find((agent) => agent.id === ownerId)?.name || '');
          } catch {
            if (!detailLoad.isCurrent(token)) return;
            setOwnerAgentName('');
          }
        } else {
          setOwnerAgentName('');
        }
      } else {
        setOwnerAgentName('');
      }
      setKb(result);
      if (result.mode === 'shared') {
        // 版本 Tab（占位中）本来就需要这份数据；这里顺带算出未发布草稿数供设置 Tab 的删除确认
        // 使用。单独包一层 try/catch：这一步失败不应触发上面 `detail.loadError` 那条"详情加载
        // 失败"的提示（详情本身已经加载成功、页面仍可用），也不应悄悄把草稿数按 0 处理——只标
        // 成"未知"，交给删除确认对话框自己的文案说明。
        try {
          const versions = await api.listVersions(kbId);
          if (!detailLoad.isCurrent(token)) return;
          setDraftCount(versions.filter((version) => version.publication_state === PublicationState.Draft).length);
          setDraftCountUnknown(false);
        } catch {
          if (!detailLoad.isCurrent(token)) return;
          setDraftCountUnknown(true);
        }
      } else {
        setDraftCount(0);
        setDraftCountUnknown(false);
      }
    } catch (error) {
      if (!detailLoad.isCurrent(token)) return;
      toast.error(error, 'knowledgeAdmin.detail.loadError');
      setLoadFailed(true);
    } finally {
      if (detailLoad.isCurrent(token)) setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // 仅在 api 实例（租户上下文）或路由参数变化时重新加载。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, kbId]);

  const tabs = kb?.mode === 'dedicated' ? DEDICATED_TABS : SHARED_TABS;
  const tabParam = searchParams.get('tab');
  const activeTab = tabParam && (tabs as readonly string[]).includes(tabParam) ? tabParam : tabs[0];

  function handleTabChange(next: string) {
    const params = new URLSearchParams(searchParams);
    params.set('tab', next);
    setSearchParams(params, { replace: true });
  }

  function handleUpdated(updated: KnowledgeBaseRead) {
    setKb(updated);
  }

  function handleDeleted() {
    navigate(EnterpriseRoute.KnowledgeAdmin);
  }

  const ownerAgentId = kb ? ownerAgentIdOf(kb) : '';

  /** 转共享成功：源库已归档、新共享库带首个正式版落地，跳到新库的「群组与权限」页。 */
  async function handleConverted(result: KnowledgeBaseConversionRead) {
    toast.success(createMessageDescriptor('knowledgeAdmin.toast.convertSuccess'));
    setConversionOpen(false);
    navigate(`${EnterpriseRoute.KnowledgeAdmin}/${result.new_knowledge_base.id}?tab=grants`, { replace: true });
  }

  return (
    <div className="min-h-full box-border px-[48px] pt-[32px] pb-[43px] max-[900px]:px-[16px]" aria-busy={loading}>
      <AppHeader onLogout={onLogout} userName={currentUser?.username} title={t('knowledgeAdmin.nav.title')} />

      <div className="mt-[16px]">
        <Button
          type="button"
          variant="outline"
          onClick={() => navigate(EnterpriseRoute.KnowledgeAdmin)}
          className="h-[32px] gap-[4px] rounded-[10px] border-[#e3e7f1] px-[12px] text-[12px] font-normal text-[#464c5e]"
        >
          <ChevronLeft className="size-[12px]" aria-hidden="true" />
          {t('knowledgeAdmin.detail.back')}
        </Button>
      </div>

      {!kb && loadFailed ? (
        <div className="mt-[24px] flex flex-col items-start gap-[10px]">
          <p role="alert" className="text-[13px] text-[#d20b0b]">{t('knowledgeAdmin.detail.loadError')}</p>
          <Button
            type="button"
            variant="outline"
            onClick={() => void load()}
            className="h-[32px] rounded-[10px] border-[#e3e7f1] px-[12px] text-[12px] font-normal text-[#464c5e]"
          >
            {t('knowledgeAdmin.detail.error.retry')}
          </Button>
        </div>
      ) : !kb ? (
        <p className="mt-[24px] text-[13px] text-[#858b9c]">{t('knowledgeAdmin.detail.loading')}</p>
      ) : (
        <>
          <div className="mt-[20px] flex flex-wrap items-center justify-between gap-[10px]">
            <div className="flex flex-wrap items-center gap-[10px]">
              <h1 className="text-[20px] font-semibold text-[#18181a]">
                <RawContent value={kb.name} />
              </h1>
              <span
                className={
                  kb.mode === 'dedicated'
                    ? 'inline-flex items-center rounded-full bg-[#eef2f7] px-[9px] py-[3px] text-[11px] font-medium text-[#596174]'
                    : 'inline-flex items-center rounded-full bg-[#ede9fe] px-[9px] py-[3px] text-[11px] font-medium text-[#6d28d9]'
                }
              >
                {t(kb.mode === 'dedicated' ? 'knowledgeAdmin.detail.badges.dedicated' : 'knowledgeAdmin.detail.badges.shared')}
              </span>
              <span
                className={
                  kb.status === 'active'
                    ? 'inline-flex items-center rounded-full bg-[#e9f7ef] px-[9px] py-[3px] text-[11px] font-medium text-[#2cb360]'
                    : 'inline-flex items-center rounded-full bg-[#f2f3f7] px-[9px] py-[3px] text-[11px] font-medium text-[#757f9c]'
                }
              >
                {t(kb.status === 'active' ? 'knowledgeAdmin.detail.badges.active' : 'knowledgeAdmin.detail.badges.archived')}
              </span>
            </div>
            {kb.mode === 'dedicated' && (
              <Button
                type="button"
                disabled={kb.status === 'archived' || !ownerAgentId}
                onClick={() => setConversionOpen(true)}
                className="h-[32px] rounded-[10px] bg-[#18181a] px-[14px] text-[12px] font-normal text-white hover:bg-[#303030] disabled:opacity-50"
              >
                {t('knowledgeAdmin.detail.actions.convertToShared')}
              </Button>
            )}
          </div>
          {kb.description && (
            <p className="mt-[6px] text-[13px] text-[#858b9c]">
              <RawContent value={kb.description} />
            </p>
          )}

          <Tabs value={activeTab} onValueChange={handleTabChange} className="mt-[20px]">
            <TabsList variant="line" aria-label={t('knowledgeAdmin.nav.title')}>
              {tabs.map((tabKey) => (
                <TabsTrigger key={tabKey} value={tabKey}>
                  {t(TAB_LABEL_IDS[tabKey])}
                </TabsTrigger>
              ))}
            </TabsList>
            {tabs.map((tabKey) => (
              <TabsContent key={tabKey} value={tabKey} className="mt-[16px]">
                {tabKey === 'settings' ? (
                  <SettingsTab
                    api={api}
                    kb={kb}
                    draftCount={draftCount}
                    draftCountUnknown={draftCountUnknown}
                    onUpdated={handleUpdated}
                    onDeleted={handleDeleted}
                  />
                ) : tabKey === 'content' && kb.mode === 'shared' ? (
                  <ContentTab api={api} kb={kb} onChanged={() => void load()} />
                ) : tabKey === 'content' && kb.mode === 'dedicated' ? (
                  <PrivateContentTab
                    api={api}
                    kb={kb}
                    ownerAgentId={ownerAgentId}
                    ownerAgentName={ownerAgentName}
                    onChanged={() => void load()}
                  />
                ) : tabKey === 'branch' ? (
                  <PrivateBranchTab
                    api={api}
                    kb={kb}
                    ownerAgentId={ownerAgentId}
                    ownerAgentName={ownerAgentName}
                    onChanged={() => void load()}
                  />
                ) : tabKey === 'versions' ? (
                  <VersionsTab api={api} kb={kb} onChanged={() => void load()} />
                ) : tabKey === 'audit' ? (
                  <AuditTab api={api} kb={kb} />
                ) : tabKey === 'grants' ? (
                  <GrantsTab api={api} kb={kb} />
                ) : (
                  <PlaceholderTab />
                )}
              </TabsContent>
            ))}
          </Tabs>
        </>
      )}

      {kb && kb.mode === 'dedicated' && (
        <SharedKnowledgeConversionDialog
          open={conversionOpen}
          knowledgeBase={kb}
          agentId={ownerAgentId}
          onClose={() => setConversionOpen(false)}
          onConverted={handleConverted}
        />
      )}
    </div>
  );
}
