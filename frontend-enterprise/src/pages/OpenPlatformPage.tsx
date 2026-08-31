import {
  FileSearchOutlined,
  ProfileOutlined,
  SolutionOutlined,
  ToolOutlined,
  UsergroupAddOutlined,
} from '../icons';
import { notify } from '@/components/ui';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { RawContent } from '@/i18n/RawContent';
import { useAppIntl } from '@/i18n/useAppIntl';
import { apiErrorMessage } from '@/lib/apiErrorMessages';
import type { ComponentType, ReactNode, SVGProps } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, TENANT_ID } from '../api/client';
import { isGalleryEmployee, type EnterpriseAuthUser } from '../auth';
import EmployeeAvatar from '../components/EmployeeAvatar';
import IconAgents from '../assets/icons/nav-agents.svg?react';
import IconFolder from '../assets/icons/cap-folder.svg?react';
import IconMagicWand from '../assets/icons/cap-magicwand.svg?react';
import IconClipboard from '../assets/icons/cap-clipboard.svg?react';
import IconBriefcase from '../assets/icons/cap-briefcase.svg?react';
import plazaKnowledgeIcon from '../assets/icons/plaza-knowledge.svg';
import plazaSkillIcon from '../assets/icons/plaza-skill.svg';
import plazaSopIcon from '../assets/icons/plaza-sop.svg';
import plazaToolIcon from '../assets/icons/plaza-tool.svg';
import {
  agentResourceCount,
  canManageEmployeeAgent,
  employeeDisplayNameWithCreator,
  employeeProfile,
  resourceDisplayNameWithCreator,
} from '../employee';
import type { AgentProfileRead, GeneralSkillRead, KnowledgeBaseRead, SkillRead, ToolRead } from '../types';

import AppHeader from '@/components/AppHeader';
import {
  PlatformCategoryPanel,
  PlatformEmployeeCard,
  PlatformEmployeeDrawer,
  PlatformKindDetailView,
  PlatformResourceCard,
  PlatformResourceDrawer,
  type PlatformKind,
  type PlatformResourceAccent,
  type PlatformStat,
  type PlatformTabItem,
} from '@/components/openPlatform';
import { isTeamScope, readEmployeeScope } from '@/lib/agent-scope-storage';

const ENTERPRISE_AGENT_STORAGE_KEY = 'ultrarag_enterprise_agent_scope';

type PlatformConfig = {
  kind: PlatformKind;
  title: string;
  subtitle: string;
  detail: string;
  useLabel: string;
  metricLabel: string;
  searchPlaceholder: string;
  signals: string[];
  icon: ReactNode;
};

type PlatformCopyEntry = Omit<PlatformConfig, 'kind' | 'icon'>;

type PlatformItem = {
  id: string;
  deleteKey?: string;
  title: string;
  description: string;
  meta: string;
  tags: string[];
  agent?: AgentProfileRead;
};

/** 构造开放广场页的语义文案与平台配置，避免 file-local locale copy 常量继续扩散。 */
function buildOpenPlatformCopy(
  translate: ReturnType<typeof useAppIntl>['t'],
): {
  pageTitle: string;
  tabsLabel: string;
  countEmployees: string;
  countContent: string;
  statKnowledge: string;
  statSkill: string;
  statSop: string;
  searchEmpty: string;
  empty: string;
  emptyHint: string;
  searchEmptyHint: string;
  loadFailed: string;
  selectEmployeeFirst: string;
  noAgent: string;
  useAgentFailed: string;
  unpublishSuccess: string;
  removeSuccess: string;
  unpublishFailed: string;
  deleteFailed: string;
  missingOverall: string;
  createOpenSkill: string;
  backToMarketplace: string;
  refresh: string;
  searchPrefix: string;
  statsSuffix: string;
  previousItem: string;
  nextItem: string;
  previousEmployee: string;
  nextEmployee: string;
  close: string;
  category: string;
  roleLabel: string;
  descriptionLabel: string;
  deleteAction: string;
  useEmployee: string;
  confirmCancel: string;
  confirmDelete: string;
  confirmUnpublish: string;
  confirmUnpublishDescription: string;
  confirmDeleteDescription: string;
  statusOnline: string;
  statusOffline: string;
  unpublish: string;
  agentDescriptionFallback: string;
  knowledgeDescriptionFallback: string;
  generalSkillDescriptionFallback: string;
  sopDescriptionFallback: string;
  toolDescriptionFallback: string;
  documents: string;
  buckets: string;
  citations: string;
  plazaVersion: string;
  externalCapability: string;
  builtInCapability: string;
  enabled: string;
  disabled: string;
  businessProcess: string;
  callsSuffix: string;
  toolBucketFallback: string;
  agentSearch: string;
  knowledgeSearch: string;
  generalSkillSearch: string;
  sopSearch: string;
  toolSearch: string;
  platforms: Record<PlatformKind, PlatformCopyEntry>;
} {
  return {
    pageTitle: translate('openPlatformPage.pageTitle'),
    tabsLabel: translate('openPlatformPage.tabsLabel'),
    countEmployees: translate('openPlatformPage.count.employees'),
    countContent: translate('openPlatformPage.count.content'),
    statKnowledge: translate('openPlatformPage.stats.knowledge'),
    statSkill: translate('openPlatformPage.stats.skill'),
    statSop: translate('openPlatformPage.stats.sop'),
    searchEmpty: translate('openPlatformPage.empty.searchTitle'),
    empty: translate('openPlatformPage.empty.defaultTitle'),
    emptyHint: translate('openPlatformPage.empty.defaultHint'),
    searchEmptyHint: translate('openPlatformPage.empty.searchHint'),
    loadFailed: translate('openPlatformPage.error.loadFailed'),
    selectEmployeeFirst: translate('openPlatformPage.error.selectEmployeeFirst'),
    noAgent: translate('openPlatformPage.error.noAgent'),
    useAgentFailed: translate('openPlatformPage.error.useAgentFailed'),
    unpublishSuccess: translate('openPlatformPage.toast.unpublishSuccess'),
    removeSuccess: translate('openPlatformPage.toast.removeSuccess'),
    unpublishFailed: translate('openPlatformPage.error.unpublishFailed'),
    deleteFailed: translate('openPlatformPage.error.deleteFailed'),
    missingOverall: translate('openPlatformPage.error.missingOverall'),
    createOpenSkill: translate('openPlatformPage.actions.createOpenSkill'),
    backToMarketplace: translate('openPlatformPage.actions.back'),
    refresh: translate('openPlatformPage.actions.refresh'),
    searchPrefix: translate('openPlatformPage.copy.searchPrefix'),
    statsSuffix: translate('openPlatformPage.copy.statsSuffix'),
    previousItem: translate('openPlatformPage.drawer.previousItem'),
    nextItem: translate('openPlatformPage.drawer.nextItem'),
    previousEmployee: translate('openPlatformPage.drawer.previousEmployee'),
    nextEmployee: translate('openPlatformPage.drawer.nextEmployee'),
    close: translate('openPlatformPage.actions.close'),
    category: translate('openPlatformPage.labels.category'),
    roleLabel: translate('openPlatformPage.labels.role'),
    descriptionLabel: translate('openPlatformPage.labels.description'),
    deleteAction: translate('openPlatformPage.actions.delete'),
    useEmployee: translate('openPlatformPage.actions.useEmployee'),
    confirmCancel: translate('openPlatformPage.confirm.cancel'),
    confirmDelete: translate('openPlatformPage.confirm.delete'),
    confirmUnpublish: translate('openPlatformPage.confirm.unpublish'),
    confirmUnpublishDescription: translate('openPlatformPage.confirm.unpublishDescription'),
    confirmDeleteDescription: translate('openPlatformPage.confirm.deleteDescription'),
    statusOnline: translate('openPlatformPage.status.online'),
    statusOffline: translate('openPlatformPage.status.offline'),
    unpublish: translate('openPlatformPage.actions.unpublish'),
    agentDescriptionFallback: translate('openPlatformPage.fallback.agentDescription'),
    knowledgeDescriptionFallback: translate('openPlatformPage.fallback.knowledgeDescription'),
    generalSkillDescriptionFallback: translate('openPlatformPage.fallback.generalSkillDescription'),
    sopDescriptionFallback: translate('openPlatformPage.fallback.sopDescription'),
    toolDescriptionFallback: translate('openPlatformPage.fallback.toolDescription'),
    documents: translate('openPlatformPage.metrics.documents'),
    buckets: translate('openPlatformPage.metrics.buckets'),
    citations: translate('openPlatformPage.metrics.citations'),
    plazaVersion: translate('openPlatformPage.metrics.marketplaceVersion'),
    externalCapability: translate('openPlatformPage.metrics.externalCapability'),
    builtInCapability: translate('openPlatformPage.metrics.builtInCapability'),
    enabled: translate('openPlatformPage.status.enabled'),
    disabled: translate('openPlatformPage.status.disabled'),
    businessProcess: translate('openPlatformPage.metrics.businessProcess'),
    callsSuffix: translate('openPlatformPage.metrics.callsSuffix'),
    toolBucketFallback: translate('openPlatformPage.metrics.toolBucketFallback'),
    agentSearch: translate('openPlatformPage.search.agent'),
    knowledgeSearch: translate('openPlatformPage.search.knowledge'),
    generalSkillSearch: translate('openPlatformPage.search.generalSkill'),
    sopSearch: translate('openPlatformPage.search.sop'),
    toolSearch: translate('openPlatformPage.search.tool'),
    platforms: {
      agents: {
        title: translate('openPlatformPage.platform.agents.title'),
        subtitle: translate('openPlatformPage.platform.agents.subtitle'),
        detail: translate('openPlatformPage.platform.agents.detail'),
        useLabel: translate('openPlatformPage.platform.agents.useLabel'),
        metricLabel: translate('openPlatformPage.platform.agents.metricLabel'),
        searchPlaceholder: translate('openPlatformPage.platform.agents.searchPlaceholder'),
        signals: [
          translate('openPlatformPage.platform.agents.signal.chatReady'),
          translate('openPlatformPage.platform.agents.signal.conversationEnabled'),
          translate('openPlatformPage.platform.agents.signal.viewCapabilities'),
        ],
      },
      knowledge: {
        title: translate('openPlatformPage.platform.knowledge.title'),
        subtitle: translate('openPlatformPage.platform.knowledge.subtitle'),
        detail: translate('openPlatformPage.platform.knowledge.detail'),
        useLabel: translate('openPlatformPage.platform.knowledge.useLabel'),
        metricLabel: translate('openPlatformPage.platform.knowledge.metricLabel'),
        searchPlaceholder: translate('openPlatformPage.platform.knowledge.searchPlaceholder'),
        signals: [
          translate('openPlatformPage.platform.knowledge.signal.graph'),
          translate('openPlatformPage.platform.knowledge.signal.citations'),
          translate('openPlatformPage.platform.knowledge.signal.copyable'),
        ],
      },
      'general-skills': {
        title: translate('openPlatformPage.platform.generalSkills.title'),
        subtitle: translate('openPlatformPage.platform.generalSkills.subtitle'),
        detail: translate('openPlatformPage.platform.generalSkills.detail'),
        useLabel: translate('openPlatformPage.platform.generalSkills.useLabel'),
        metricLabel: translate('openPlatformPage.platform.generalSkills.metricLabel'),
        searchPlaceholder: translate('openPlatformPage.platform.generalSkills.searchPlaceholder'),
        signals: [
          translate('openPlatformPage.platform.generalSkills.signal.runtimeTested'),
          translate('openPlatformPage.platform.generalSkills.signal.mcpBrowser'),
          translate('openPlatformPage.platform.generalSkills.signal.reusableCapability'),
        ],
      },
      skills: {
        title: translate('openPlatformPage.platform.skills.title'),
        subtitle: translate('openPlatformPage.platform.skills.subtitle'),
        detail: translate('openPlatformPage.platform.skills.detail'),
        useLabel: translate('openPlatformPage.platform.skills.useLabel'),
        metricLabel: translate('openPlatformPage.platform.skills.metricLabel'),
        searchPlaceholder: translate('openPlatformPage.platform.skills.searchPlaceholder'),
        signals: [
          translate('openPlatformPage.platform.skills.signal.workflowProgression'),
          translate('openPlatformPage.platform.skills.signal.executionRules'),
          translate('openPlatformPage.platform.skills.signal.copyable'),
        ],
      },
      tools: {
        title: translate('openPlatformPage.platform.tools.title'),
        subtitle: translate('openPlatformPage.platform.tools.subtitle'),
        detail: translate('openPlatformPage.platform.tools.detail'),
        useLabel: translate('openPlatformPage.platform.tools.useLabel'),
        metricLabel: translate('openPlatformPage.platform.tools.metricLabel'),
        searchPlaceholder: translate('openPlatformPage.platform.tools.searchPlaceholder'),
        signals: [
          translate('openPlatformPage.platform.tools.signal.invocationPermissions'),
          translate('openPlatformPage.platform.tools.signal.testable'),
          translate('openPlatformPage.platform.tools.signal.configuration'),
        ],
      },
    },
  };
}

type OpenPlatformCopy = ReturnType<typeof buildOpenPlatformCopy>;

/** 用 ReactNode 生成确认框标题，保持 raw 名称独立边界而不拼进 catalog 文案。 */
function renderConfirmTitle(prefix: string, name: string, suffix = '？'): ReactNode {
  return (
    <>
      {prefix}
      <RawContent value={name} />
      {suffix}
    </>
  );
}

/** 返回开放广场页的本地语义文案；catalog 解锁前先以内嵌稳定键维护。 */
function useOpenPlatformCopy(): OpenPlatformCopy {
  const { t } = useAppIntl();
  return buildOpenPlatformCopy(t);
}

/** 构造当前 locale 的平台分类配置，避免类别标题和说明固定在中文。 */
function platformConfigs(copy: OpenPlatformCopy): PlatformConfig[] {
  return [
    {
      kind: 'agents',
      ...copy.platforms.agents,
      icon: <UsergroupAddOutlined />,
    },
    {
      kind: 'knowledge',
      ...copy.platforms.knowledge,
      icon: <FileSearchOutlined />,
    },
    {
      kind: 'general-skills',
      ...copy.platforms['general-skills'],
      icon: <SolutionOutlined />,
    },
    {
      kind: 'skills',
      ...copy.platforms.skills,
      icon: <ProfileOutlined />,
    },
    {
      kind: 'tools',
      ...copy.platforms.tools,
      icon: <ToolOutlined />,
    },
  ];
}

// SD1 line glyph shown in each column header, matching the sidebar mapping.
const PLATFORM_ICON: Record<PlatformKind, ComponentType<SVGProps<SVGSVGElement>>> = {
  agents: IconAgents,
  knowledge: IconFolder,
  'general-skills': IconMagicWand,
  skills: IconClipboard,
  tools: IconBriefcase,
};

// Colorful 3D module icon shown on each广场 resource card (agents use avatars instead).
const PLATFORM_RESOURCE_ICON: Partial<Record<PlatformKind, string>> = {
  knowledge: plazaKnowledgeIcon,
  'general-skills': plazaSkillIcon,
  skills: plazaSopIcon,
  tools: plazaToolIcon,
};

// Per-module accent color for the resource card meta line and tag pills (SD1 232:4634).
const PLATFORM_ACCENT: Partial<Record<PlatformKind, PlatformResourceAccent>> = {
  knowledge: 'green',
  'general-skills': 'indigo',
  skills: 'blue',
  tools: 'orange',
};

const LEGACY_UNBUCKETED_TOOL_BUCKET = '未分桶';

/** 生成当前分类下的计数单位，避免固定中文后缀。 */
function platformCountLabel(kind: PlatformKind, copy: OpenPlatformCopy): string {
  return kind === 'agents' ? copy.countEmployees : copy.countContent;
}

/** 精确归一化旧版空分桶标记；真实业务分桶名称继续原样展示。 */
function platformToolBucketLabel(bucket: string | undefined, copy: OpenPlatformCopy): string {
  return !bucket || bucket === LEGACY_UNBUCKETED_TOOL_BUCKET ? copy.toolBucketFallback : bucket;
}

/** 为员工广场卡片生成统计项，保证标签跟随当前 locale。 */
function employeeStats(agent: AgentProfileRead, copy: OpenPlatformCopy): PlatformStat[] {
  return [
    { value: agentResourceCount(agent, 'knowledge_base'), label: copy.statKnowledge },
    { value: agentResourceCount(agent, 'general_skill'), label: copy.statSkill },
    { value: agentResourceCount(agent, 'skill'), label: copy.statSop },
  ];
}

function resourceDrawerBadge(kind: PlatformKind, item: PlatformItem): string {
  if (kind === 'skills') {
    const parts = item.meta.split(' / ');
    return parts[parts.length - 1] || item.tags[0] || '';
  }
  return item.tags[0] || '';
}

// 按标题、描述、编号、标签做包含匹配过滤当前分类下的卡片，关键词为空时原样返回。
function filterPlatformItems(items: PlatformItem[], keyword: string): PlatformItem[] {
  const trimmed = keyword.trim().toLowerCase();
  if (!trimmed) return items;
  return items.filter((item) => [item.title, item.description, item.meta, item.tags.join(' ')]
    .some((value) => value.toLowerCase().includes(trimmed)));
}

/** 把未知异常折叠为安全语义错误，避免把原始 Error.message 暴露为最终 UI。 */
function platformErrorMessage(error: unknown, fallback: string): string {
  const message = apiErrorMessage(error, 'common.error.generic');
  return message === '发生错误，请稍后重试' || message === 'Something went wrong. Please try again later.'
    ? fallback
    : message;
}

/** 页面内自绘 tablist，提供稳定的 aria-label 和不含计数的 tab accessible name。 */
function OpenPlatformTabList({
  items,
  activeKind,
  ariaLabel,
  onChange,
}: {
  items: PlatformTabItem[];
  activeKind: PlatformKind;
  ariaLabel: string;
  onChange: (kind: PlatformKind) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className="inline-flex max-w-full flex-nowrap items-center gap-[2px] overflow-x-auto rounded-[14px] bg-[#f1f2f4] p-[4px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {items.map((item) => {
        const isActive = item.kind === activeKind;
        return (
          <button
            key={item.kind}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-label={item.label}
            onClick={() => onChange(item.kind)}
            className={[
              'inline-flex shrink-0 items-center gap-[6px] whitespace-nowrap rounded-[11px] px-[16px] py-[9px] text-[13px] font-medium text-[#757f9c] transition-colors max-2xl:px-[12px] max-2xl:text-[12px]',
              isActive ? 'bg-white shadow-[0_1px_6px_rgba(15,23,42,0.10)] text-[#18181a]' : '',
            ].join(' ')}
          >
            <span className="flex size-[14px] shrink-0 items-center justify-center" aria-hidden="true">{item.icon}</span>
            <span>{item.label}</span>
            <span aria-hidden="true" className="text-[10.5px] font-normal text-[#98a2b3]">{item.count}</span>
          </button>
        );
      })}
    </div>
  );
}

export default function OpenPlatformPage({
  currentUser,
  isAdmin = false,
  onLogout,
}: {
  currentUser?: EnterpriseAuthUser;
  isAdmin?: boolean;
  onLogout?: () => void;
}) {
  const { locale } = useAppIntl();
  const copy = useOpenPlatformCopy();
  const navigate = useNavigate();
  const { kind } = useParams<{ kind?: PlatformKind }>();
  const platformConfigList = useMemo(() => platformConfigs(copy), [copy]);
  const platformByKind = useMemo(
    () => new Map(platformConfigList.map((item) => [item.kind, item])),
    [platformConfigList],
  );
  const selectedKind = kind && platformByKind.has(kind) ? kind : undefined;
  const [agents, setAgents] = useState<AgentProfileRead[]>([]);
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBaseRead[]>([]);
  const [generalSkills, setGeneralSkills] = useState<GeneralSkillRead[]>([]);
  const [skills, setSkills] = useState<SkillRead[]>([]);
  const [tools, setTools] = useState<ToolRead[]>([]);
  const [loading, setLoading] = useState(false);
  const [deletingItemKey, setDeletingItemKey] = useState('');
  const [agentId, setAgentId] = useState(readEmployeeScope);
  const [detailItem, setDetailItem] = useState<{ kind: PlatformKind; item: PlatformItem } | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<{ kind: PlatformKind; item: PlatformItem } | null>(null);
  const [activeKind, setActiveKind] = useState<PlatformKind>('agents');
  const [searchText, setSearchText] = useState('');

  useEffect(() => {
    const onScopeChange = (event: Event) => {
      const next = (event as CustomEvent<{ agentId?: string }>).detail?.agentId || '';
      setAgentId(next && !isTeamScope(next) ? next : readEmployeeScope());
    };
    window.addEventListener('ultrarag-enterprise-agent-scope-change', onScopeChange);
    return () => window.removeEventListener('ultrarag-enterprise-agent-scope-change', onScopeChange);
  }, []);

  const loadPlatformData = useCallback(async () => {
    setLoading(true);
    try {
      const agentRows = await api.get<AgentProfileRead[]>(`/api/enterprise/agents?tenant_id=${TENANT_ID}`);
      const overall = agentRows.find((item) => item.is_overall);
      const overallSuffix = overall ? `&agent_id=${encodeURIComponent(overall.id)}` : '';
      const [kbRows, generalRows, skillRows, toolRows] = await Promise.all([
        api.get<KnowledgeBaseRead[]>(`/api/enterprise/knowledge-bases?tenant_id=${TENANT_ID}${overallSuffix}`),
        api.get<GeneralSkillRead[]>(`/api/enterprise/general-skills?tenant_id=${TENANT_ID}${overallSuffix}`),
        overall
          ? api.get<SkillRead[]>(`/api/enterprise/agents/${overall.id}/skills?tenant_id=${TENANT_ID}`)
          : Promise.resolve([]),
        api.get<ToolRead[]>(`/api/enterprise/tools?tenant_id=${TENANT_ID}${overallSuffix}`),
      ]);
      setAgents(agentRows);
      setKnowledgeBases(kbRows);
      setGeneralSkills(generalRows);
      setSkills(skillRows);
      setTools(toolRows);
    } catch (error) {
      notify.error(platformErrorMessage(error, copy.loadFailed));
    } finally {
      setLoading(false);
    }
  }, [copy.loadFailed]);

  useEffect(() => {
    void loadPlatformData();
  }, [loadPlatformData]);

  const visibleAgents = useMemo(
    () => agents.filter((item) => !item.is_overall && item.status === 'active' && isGalleryEmployee(item)),
    [agents],
  );
  const overallAgent = agents.find((item) => item.is_overall) || null;
  const canManagePlatform = isAdmin;
  const currentAgent = agents.find((item) => item.id === agentId);
  const targetEmployee = currentAgent && canManageEmployeeAgent(currentAgent, currentUser)
    ? currentAgent
    : agents.find((item) => canManageEmployeeAgent(item, currentUser) && !item.is_overall);

  const platformItems = useMemo<Record<PlatformKind, PlatformItem[]>>(() => ({
    agents: visibleAgents.map((item) => {
      const profile = employeeProfile(item);
      return {
        id: item.id,
        deleteKey: item.id,
        title: employeeDisplayNameWithCreator(item),
        description: item.description || copy.agentDescriptionFallback,
        meta: profile.roleName,
        tags: [
          item.status === 'active' ? copy.statusOnline : copy.statusOffline,
          `SOP ${agentResourceCount(item, 'skill')}`,
          `${copy.statSkill} ${agentResourceCount(item, 'general_skill')}`,
        ],
        agent: item,
      };
    }),
    knowledge: knowledgeBases
      .filter((item) => item.status === 'active' && !isEmptyDefaultKnowledgeBase(item))
      .map((item) => ({
        id: item.id,
        deleteKey: item.id,
        title: resourceDisplayNameWithCreator(item.name, item),
        description: item.description || copy.knowledgeDescriptionFallback,
        meta: `${item.document_count} ${copy.documents} / ${item.bucket_count} ${copy.buckets} / ${item.chunk_count} ${copy.citations}`,
        tags: [item.version || 'v1.0.0', item.branch_sync_state || copy.plazaVersion],
      })),
    'general-skills': generalSkills
      .filter((item) => item.status === 'published')
      .map((item) => ({
        id: item.id,
        deleteKey: item.slug,
        title: resourceDisplayNameWithCreator(item.name, item),
        description: item.description || copy.generalSkillDescriptionFallback,
        meta: item.slug,
        tags: [item.homepage ? copy.externalCapability : copy.builtInCapability, copy.enabled],
      })),
    skills: skills
      .filter((item) => item.status === 'published')
      .map((item) => ({
        id: item.id,
        deleteKey: item.skill_id,
        title: resourceDisplayNameWithCreator(item.name, item),
        description: item.description || copy.sopDescriptionFallback,
        meta: `${item.skill_id} / ${item.version}`,
        tags: [item.business_domain || copy.businessProcess, `${item.total_call_count || item.call_count || 0} ${copy.callsSuffix}`],
      })),
    tools: tools
      .filter((item) => item.enabled)
      .map((item) => ({
        id: item.id,
        deleteKey: item.id,
        title: resourceDisplayNameWithCreator(item.display_name || item.name, item),
        description: item.description || copy.toolDescriptionFallback,
        meta: `${platformToolBucketLabel(item.bucket, copy)} / ${item.tool_type.toUpperCase()}`,
        tags: [item.method, item.enabled ? copy.enabled : copy.disabled],
      })),
  }), [copy, generalSkills, knowledgeBases, skills, tools, visibleAgents]);

  const platformStats = platformConfigList.map((config) => ({
    ...config,
    count: platformItems[config.kind].length,
  }));

  function ensureTargetEmployee(): boolean {
    if (!targetEmployee) {
      notify.warning(copy.selectEmployeeFirst);
      return false;
    }
    if (targetEmployee.id !== agentId) {
      window.localStorage.setItem(ENTERPRISE_AGENT_STORAGE_KEY, targetEmployee.id);
      window.dispatchEvent(new CustomEvent('ultrarag-enterprise-agent-scope-change', { detail: { agentId: targetEmployee.id } }));
      setAgentId(targetEmployee.id);
    }
    return true;
  }

  async function markPlatformAgentUsed(agent: AgentProfileRead) {
    const metadata = agent.metadata || {};
    if (metadata.used_by_current_user !== true && metadata.chat_used_by_current_user !== true) {
      await api.post<AgentProfileRead>(`/api/chat/agents/${agent.id}/use?tenant_id=${TENANT_ID}`, {});
    }
    setAgents((current) => current.map((item) => (
      item.id === agent.id
        ? {
          ...item,
          metadata: {
            ...(item.metadata || {}),
            used_by_current_user: true,
            chat_used_by_current_user: true,
          },
        }
        : item
    )));
    window.localStorage.setItem(ENTERPRISE_AGENT_STORAGE_KEY, agent.id);
    window.dispatchEvent(new Event('ultrarag-enterprise-agent-scope-refresh'));
    window.dispatchEvent(new CustomEvent('ultrarag-enterprise-agent-scope-change', { detail: { agentId: agent.id } }));
    setAgentId(agent.id);
  }

  async function usePlatformItem(platformKind: PlatformKind, itemId?: string) {
    if (platformKind === 'agents') {
      const agent = visibleAgents.find((item) => item.id === itemId) || visibleAgents[0];
      if (!agent) {
        notify.warning(copy.noAgent);
        return;
      }
      try {
        await markPlatformAgentUsed(agent);
        navigate('/enterprise/dashboard');
      } catch (error) {
        notify.error(platformErrorMessage(error, copy.useAgentFailed));
      }
      return;
    }
    if (!ensureTargetEmployee()) return;
    const resourceParam = itemId ? `&resourceId=${encodeURIComponent(itemId)}` : '';
    if (platformKind === 'knowledge') navigate(`/enterprise/knowledge?add=plaza${resourceParam}`);
    if (platformKind === 'general-skills') navigate(`/enterprise/general-skills?add=plaza${resourceParam}`);
    if (platformKind === 'skills') navigate(`/enterprise/skills?add=plaza${resourceParam}`);
    if (platformKind === 'tools') navigate('/enterprise/tools?add=plaza');
  }

  function platformItemDeleteKey(platformKind: PlatformKind, item: PlatformItem): string {
    return `${platformKind}:${item.deleteKey || item.id}`;
  }

  function platformDeleteUrl(platformKind: PlatformKind, item: PlatformItem): string {
    const resourceKey = encodeURIComponent(item.deleteKey || item.id);
    const overallSuffix = overallAgent ? `&agent_id=${encodeURIComponent(overallAgent.id)}` : '';
    if (platformKind === 'agents') return `/api/enterprise/agents/${resourceKey}?tenant_id=${TENANT_ID}`;
    if (platformKind === 'knowledge') return `/api/enterprise/knowledge-bases/${resourceKey}?tenant_id=${TENANT_ID}${overallSuffix}`;
    if (platformKind === 'general-skills') return `/api/enterprise/general-skills/${resourceKey}?tenant_id=${TENANT_ID}${overallSuffix}`;
    if (platformKind === 'skills') return `/api/enterprise/skills/${resourceKey}?tenant_id=${TENANT_ID}${overallSuffix}`;
    return `/api/enterprise/tools/${resourceKey}?tenant_id=${TENANT_ID}${overallSuffix}`;
  }

  async function runDelete() {
    if (!confirmTarget) return;
    const { kind: platformKind, item } = confirmTarget;
    const key = platformItemDeleteKey(platformKind, item);
    setDeletingItemKey(key);
    try {
      if (platformKind === 'agents' && item.agent) {
        await api.post<AgentProfileRead>(
          `/api/enterprise/agents/${encodeURIComponent(item.agent.id)}/gallery:unpublish?tenant_id=${encodeURIComponent(TENANT_ID)}`,
          {},
        );
        window.dispatchEvent(new Event('ultrarag-enterprise-agent-scope-refresh'));
      } else {
        await api.delete(platformDeleteUrl(platformKind, item));
      }
      notify.success(platformKind === 'agents' ? copy.unpublishSuccess : copy.removeSuccess);
      setDetailItem((current) => (
        current && current.kind === platformKind && current.item.id === item.id ? null : current
      ));
      setConfirmTarget(null);
      await loadPlatformData();
    } catch (error) {
      notify.error(platformErrorMessage(error, platformKind === 'agents' ? copy.unpublishFailed : copy.deleteFailed));
    } finally {
      setDeletingItemKey('');
    }
  }

  function navigateDetailItem(offset: -1 | 1) {
    if (!detailItem) return;
    const items = platformItems[detailItem.kind];
    const currentIndex = items.findIndex((entry) => entry.id === detailItem.item.id);
    const nextItem = items[currentIndex + offset];
    if (!nextItem) return;
    setDetailItem({ kind: detailItem.kind, item: nextItem });
  }

  function renderItemDrawer() {
    if (!detailItem) return null;
    const config = platformByKind.get(detailItem.kind) || platformConfigList[0];
    const { item } = detailItem;
    const deleteKey = platformItemDeleteKey(detailItem.kind, item);
    const drawerItems = platformItems[detailItem.kind];
    const drawerIndex = drawerItems.findIndex((entry) => entry.id === item.id);

    if (detailItem.kind === 'agents' && item.agent) {
      const profile = employeeProfile(item.agent);
      const detailText = item.agent.persona_prompt
        || item.agent.description
        || config.detail;
      return (
        <PlatformEmployeeDrawer
          open
          agent={item.agent}
          platformTitle={config.title}
          name={item.title}
          role={item.meta}
          description={item.description}
          detailText={detailText}
          workStyles={profile.workStyles}
          stats={employeeStats(item.agent, copy)}
          online={item.agent.status === 'active'}
          canManage={canManagePlatform}
          unpublishing={deletingItemKey === deleteKey}
          hasPrev={drawerIndex > 0}
          hasNext={drawerIndex >= 0 && drawerIndex < drawerItems.length - 1}
          onClose={() => setDetailItem(null)}
          onPrev={() => navigateDetailItem(-1)}
          onNext={() => navigateDetailItem(1)}
          onUnpublish={() => setConfirmTarget({ kind: detailItem.kind, item })}
          onUse={() => {
            setDetailItem(null);
            void usePlatformItem(detailItem.kind, item.id);
          }}
          copy={{
            previousLabel: copy.previousEmployee,
            nextLabel: copy.nextEmployee,
            closeLabel: copy.close,
            statusOnline: copy.statusOnline,
            statusOffline: copy.statusOffline,
            categoryLabel: copy.category,
            roleLabel: copy.roleLabel,
            descriptionLabel: copy.descriptionLabel,
            unpublishAction: copy.unpublish,
            useAction: copy.useEmployee,
          }}
        />
      );
    }

    return (
      <PlatformResourceDrawer
        open
        platformTitle={config.title}
        icon={PLATFORM_RESOURCE_ICON[detailItem.kind]
          ? <img src={PLATFORM_RESOURCE_ICON[detailItem.kind]} alt="" className="size-[36px] object-contain" />
          : <span className="grid size-[36px] place-items-center text-[#757f9c]">{config.icon}</span>}
        accent={PLATFORM_ACCENT[detailItem.kind]}
        title={item.title}
        description={item.description}
        badge={resourceDrawerBadge(detailItem.kind, item)}
        categoryMeta={item.meta}
        detailText={config.detail}
        useLabel={config.useLabel}
        canManage={canManagePlatform}
        deleting={deletingItemKey === deleteKey}
        hasPrev={drawerIndex > 0}
        hasNext={drawerIndex >= 0 && drawerIndex < drawerItems.length - 1}
        onClose={() => setDetailItem(null)}
        onPrev={() => navigateDetailItem(-1)}
        onNext={() => navigateDetailItem(1)}
        onDelete={() => setConfirmTarget({ kind: detailItem.kind, item })}
        onUse={() => {
          setDetailItem(null);
          void usePlatformItem(detailItem.kind, item.id);
        }}
        copy={{
          previousLabel: copy.previousItem,
          nextLabel: copy.nextItem,
          closeLabel: copy.close,
          platformLabel: copy.category,
          categoryLabel: copy.category,
          descriptionLabel: copy.descriptionLabel,
          deleteAction: copy.deleteAction,
        }}
      />
    );
  }

  function renderConfirm() {
    const config = confirmTarget ? platformByKind.get(confirmTarget.kind) || platformConfigList[0] : null;
    return (
      <ConfirmDialog
        open={Boolean(confirmTarget)}
        onOpenChange={(next) => { if (!next) setConfirmTarget(null); }}
        title={confirmTarget && config
          ? confirmTarget.kind === 'agents'
            ? renderConfirmTitle(copy.unpublish, confirmTarget.item.title)
            : renderConfirmTitle(`${copy.deleteAction}${config.metricLabel}「`, confirmTarget.item.title, '」？')
          : ''}
        description={confirmTarget?.kind === 'agents'
          ? copy.confirmUnpublishDescription
          : copy.confirmDeleteDescription}
        confirmText={confirmTarget?.kind === 'agents' ? copy.confirmUnpublish : copy.confirmDelete}
        cancelText={copy.confirmCancel}
        loading={Boolean(confirmTarget) && deletingItemKey === (confirmTarget ? platformItemDeleteKey(confirmTarget.kind, confirmTarget.item) : '')}
        onConfirm={() => void runDelete()}
      />
    );
  }

  if (selectedKind) {
    const config = platformByKind.get(selectedKind) || platformConfigList[0];
    const PlatformIcon = PLATFORM_ICON[selectedKind];
    return (
      <>
        <PlatformKindDetailView
          kind={selectedKind}
          title={config.title}
          subtitle={config.subtitle}
          countLabel={platformCountLabel(selectedKind, copy)}
          signals={config.signals}
          icon={PlatformIcon}
          items={platformItems[selectedKind]}
          loading={loading}
          employeeStats={(agent) => employeeStats(agent, copy)}
          onBack={() => navigate('/enterprise/platform')}
          onRefresh={() => void loadPlatformData()}
          onCreate={selectedKind === 'general-skills' ? () => {
            const overall = agents.find((item) => item.is_overall);
            if (!overall) {
              notify.error(copy.missingOverall);
              return;
            }
            window.localStorage.setItem(ENTERPRISE_AGENT_STORAGE_KEY, overall.id);
            window.dispatchEvent(new CustomEvent('ultrarag-enterprise-agent-scope-change', {
              detail: { agentId: overall.id },
            }));
            navigate('/enterprise/general-skills/new?scope=gallery');
          } : undefined}
          onOpenItem={(item) => setDetailItem({ kind: selectedKind, item })}
          canManage={canManagePlatform && selectedKind === 'agents'}
          unpublishingItemId={deletingItemKey.startsWith('agents:')
            ? deletingItemKey.slice('agents:'.length)
            : undefined}
          onUnpublishItem={(item) => setConfirmTarget({ kind: 'agents', item })}
          onLogout={onLogout}
          userName={currentUser?.username}
          copy={{
            backAction: copy.backToMarketplace,
            createAction: copy.createOpenSkill,
            refreshAction: copy.refresh,
            statsAriaSuffix: copy.statsSuffix,
            searchPrefix: copy.searchPrefix,
            emptyText: copy.empty,
            searchEmptyText: copy.searchEmpty,
            employeeCard: {
              statusOnline: copy.statusOnline,
              statusOffline: copy.statusOffline,
              unpublishAria: copy.unpublish,
              unpublishTitle: copy.unpublish,
              unpublishAction: copy.deleteAction,
            },
          }}
        />
        {renderItemDrawer()}
        {renderConfirm()}
      </>
    );
  }

  const activeConfig = platformByKind.get(activeKind) || platformConfigList[0];
  const ActivePlatformIcon = PLATFORM_ICON[activeKind];
  const activeItems = platformItems[activeKind];
  const activeItemsFiltered = filterPlatformItems(activeItems, searchText);
  const tabItems: PlatformTabItem[] = platformStats.map((platform) => {
    const TabIcon = PLATFORM_ICON[platform.kind];
    return {
      kind: platform.kind,
      label: platform.title,
      count: platform.count,
      icon: <TabIcon className="size-[14px]" />,
    };
  });

  return (
    <div className="flex min-h-full flex-col box-border px-[48px] pt-[32px] pb-[43px] max-[900px]:px-[16px] xl:h-full xl:min-h-0 xl:overflow-hidden">
      <AppHeader
        className="mb-[24px]"
        onLogout={onLogout}
        userName={currentUser?.username}
        title={copy.pageTitle}
      />
      <div className="flex w-full flex-col items-center gap-[20px] xl:min-h-0 xl:flex-1">
        <OpenPlatformTabList
          items={tabItems}
          activeKind={activeKind}
          ariaLabel={copy.tabsLabel}
          onChange={(nextKind) => { setActiveKind(nextKind); setSearchText(''); }}
        />
        <PlatformCategoryPanel
          className="rounded-[14px] border-[0.5px] border-[#e3e7f1] px-[16px] py-[16px]"
          icon={<ActivePlatformIcon className="size-[16px]" />}
          title={activeConfig.title}
          count={activeItems.length}
          filters={activeConfig.signals}
          searchValue={searchText}
          searchPlaceholder={activeConfig.searchPlaceholder}
          onSearchChange={setSearchText}
          loading={loading}
          isEmpty={activeItemsFiltered.length === 0}
          emptyText={searchText.trim() ? copy.searchEmpty : copy.empty}
          emptyHint={searchText.trim() ? copy.searchEmptyHint : copy.emptyHint}
          emptyStateAriaLabel={searchText.trim() ? copy.searchEmpty : copy.empty}
          cardSize={activeKind === 'agents' ? 'employee' : 'resource'}
        >
          {activeItemsFiltered.map((item) => (
            activeKind === 'agents' && item.agent ? (
              <PlatformEmployeeCard
                key={item.id}
                avatar={(
                  <EmployeeAvatar
                    agent={item.agent}
                    width={80}
                    height={94}
                    fit="contain"
                    objectPosition="center bottom"
                    className="overflow-visible! rounded-none! border-0! bg-transparent! bg-none! shadow-none! after:hidden!"
                  />
                )}
                name={<RawContent value={item.title} />}
                role={<RawContent value={item.meta} />}
                online={item.agent.status === 'active'}
                description={item.agent.description ? <RawContent value={item.description} /> : item.description}
                stats={employeeStats(item.agent, copy)}
                onOpen={() => setDetailItem({ kind: activeKind, item })}
                onUnpublish={canManagePlatform ? () => setConfirmTarget({ kind: activeKind, item }) : undefined}
                unpublishing={deletingItemKey === platformItemDeleteKey(activeKind, item)}
                copy={{
                  statusOnline: copy.statusOnline,
                  statusOffline: copy.statusOffline,
                  unpublishAria: copy.unpublish,
                  unpublishTitle: copy.unpublish,
                  unpublishAction: copy.confirmUnpublish,
                }}
              />
            ) : (
              <PlatformResourceCard
                key={item.id}
                icon={PLATFORM_RESOURCE_ICON[activeKind]
                  ? <img src={PLATFORM_RESOURCE_ICON[activeKind]} alt="" className="size-[44px] shrink-0 object-contain" />
                  : undefined}
                accent={PLATFORM_ACCENT[activeKind]}
                title={item.title}
                meta={item.meta}
                description={item.description}
                tags={item.tags.slice(0, 2)}
                onClick={() => setDetailItem({ kind: activeKind, item })}
              />
            )
          ))}
        </PlatformCategoryPanel>
      </div>
      {renderItemDrawer()}
      {renderConfirm()}
    </div>
  );
}

function isEmptyDefaultKnowledgeBase(item: KnowledgeBaseRead): boolean {
  return item.name === '默认知识库' && item.document_count === 0 && item.bucket_count === 0 && item.chunk_count === 0;
}
