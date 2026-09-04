/**
 * 知识库管理 · 详情页：面包屑返回、标题（名称 + 类型/状态徽章）、描述，
 * 按 `mode` 渲染不同 Tab 集（共享：content/versions/grants/audit/settings；
 * 私有：content/branch/settings），`?tab=` 与 URL 同步、刷新后保持（FR-002）。
 * 页面不读取 `readEmployeeScope`，也不监听 agent-scope 事件。
 */

import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { createKnowledgeAdminApi } from '@/api/knowledgeAdmin';
import AppHeader from '@/components/AppHeader';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { notify } from '@/components/ui/app-toast';
import { useTenantSession } from '@/contexts/TenantSessionContext';
import { PublicationState } from '@/enums/knowledge';
import { EnterpriseRoute } from '@/enums/routes';
import { useAppIntl, type MessageId } from '@/i18n';
import { RawContent } from '@/i18n/RawContent';
import type { KnowledgeBaseRead } from '@/types';

import type { EnterpriseAuthUser } from '../../auth';
import { AuditTab } from './shared/AuditTab';
import { ContentTab } from './shared/ContentTab';
import { knowledgeAdminErrorMessage } from './shared/errorMessage';
import { PlaceholderTab } from './shared/PlaceholderTab';
import { SettingsTab } from './shared/SettingsTab';
import { VersionsTab } from './shared/VersionsTab';

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
  const tenantContext = useTenantSession();
  const api = useMemo(() => createKnowledgeAdminApi(tenantContext), [tenantContext]);

  const [kb, setKb] = useState<KnowledgeBaseRead | null>(null);
  const [loading, setLoading] = useState(false);
  /** 设置 Tab 删除确认展示的进行中草稿数；私有库分支没有独立草稿概念，恒为 0。 */
  const [draftCount, setDraftCount] = useState(0);
  /** 草稿数是否未知（`listVersions` 单独失败）；与 `draftCount` 分开，避免把失败悄悄当成 0。 */
  const [draftCountUnknown, setDraftCountUnknown] = useState(false);

  async function load() {
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined || !kbId) return;
    setLoading(true);
    try {
      const result = await api.getKnowledgeBase(kbId);
      if (!context.isCurrentGeneration(generation)) return;
      setKb(result);
      if (result.mode === 'shared') {
        // 版本 Tab（占位中）本来就需要这份数据；这里顺带算出未发布草稿数供设置 Tab 的删除确认
        // 使用。单独包一层 try/catch：这一步失败不应触发上面 `detail.loadError` 那条"详情加载
        // 失败"的提示（详情本身已经加载成功、页面仍可用），也不应悄悄把草稿数按 0 处理——只标
        // 成"未知"，交给删除确认对话框自己的文案说明。
        try {
          const versions = await api.listVersions(kbId);
          if (!context.isCurrentGeneration(generation)) return;
          setDraftCount(versions.filter((version) => version.publication_state === PublicationState.Draft).length);
          setDraftCountUnknown(false);
        } catch {
          if (!context.isCurrentGeneration(generation)) return;
          setDraftCountUnknown(true);
        }
      } else {
        setDraftCount(0);
        setDraftCountUnknown(false);
      }
    } catch (error) {
      if (!context.isCurrentGeneration(generation)) return;
      notify.error(knowledgeAdminErrorMessage(error, 'knowledgeAdmin.detail.loadError', { t }));
    } finally {
      if (context.isCurrentGeneration(generation)) setLoading(false);
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

      {!kb ? (
        <p className="mt-[24px] text-[13px] text-[#858b9c]">{t('knowledgeAdmin.detail.loading')}</p>
      ) : (
        <>
          <div className="mt-[20px] flex flex-wrap items-center gap-[10px]">
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
                ) : tabKey === 'versions' ? (
                  <VersionsTab api={api} kb={kb} onChanged={() => void load()} />
                ) : tabKey === 'audit' ? (
                  <AuditTab api={api} kb={kb} />
                ) : (
                  <PlaceholderTab />
                )}
              </TabsContent>
            ))}
          </Tabs>
        </>
      )}
    </div>
  );
}
