import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Ban, CircleCheck, Copy, Eye, RotateCcw, Upload, Users } from 'lucide-react';

import AppHeader from '@/components/AppHeader';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { DataTable, type DataTableColumn } from '@/components/DataTable';
import { Paginator } from '@/components/Paginator';
import { RawContent } from '@/i18n/RawContent';
import { useAppIntl } from '@/i18n/useAppIntl';
import { apiErrorMessage } from '@/lib/apiErrorMessages';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui';
import { Button as UIButton } from '@/components/ui/button';
import { notify } from '@/components/ui/app-toast';
import { cn } from '@/lib/utils';
import {
  MENU_CONTENT_CLASS,
  MENU_ITEM_CLASS,
  MENU_ITEM_DANGER_CLASS,
  MOBILE_CARD_CLASS,
  SELECT_TRIGGER_CLASS,
} from '@/lib/enterprise-ui';
import { DetailField } from '@/components/DetailField';
import { ResourceImportDialog } from '@/components/ResourceImportDialog';

import { createTenantClient } from '../api/tenant-client';
import IconAdd from '../assets/icons/add.svg?react';
import IconChevronDown from '../assets/icons/chevron-down.svg?react';
import IconClear from '../assets/icons/field-clear.svg?react';
import IconClipboard from '../assets/icons/cap-clipboard.svg?react';
import IconEdit from '../assets/icons/edit.svg?react';
import IconHistory from '../assets/icons/profile-history.svg?react';
import IconMore from '../assets/icons/more.svg?react';
import IconRefresh from '../assets/icons/refresh.svg?react';
import IconSearch from '../assets/icons/search.svg?react';
import IconSkill from '../assets/icons/plaza-skill.svg?react';
import IconTrash from '../assets/icons/trash.svg?react';
import { isEnterpriseAdmin, type EnterpriseAuthUser } from '../auth';
import { useTenantSession } from '../contexts/TenantSessionContext';
import {
  canManageEmployeeAgent,
  openGalleryAgentId,
  openGalleryImportSourceOptions,
  resourceCreatorName,
  visibleEmployeeAgents,
} from '../employee';
import { useClientPagination } from '../hooks/useClientPagination';
import { isTeamScope, readEmployeeScope } from '../lib/agent-scope-storage';
import { StatusBadge } from './scheduled-tasks/StatusBadge';
import type { BadgeTone } from './scheduled-tasks/shared';
import type { AgentProfileRead, SkillRead, SkillVersionRead } from '../types';

const SKILL_PAGE_SIZE = 10;
const RANKING_PAGE_SIZE = 10;

type SkillsPageCopy = {
  title: string;
  refresh: string;
  add: string;
  addBlank: string;
  copyFromMarketplace: string;
  copyFromEmployee: string;
  listOverall: string;
  listLocal: string;
  searchLabel: string;
  searchPlaceholder: string;
  clearSearch: string;
  statusFilter: string;
  statusAll: string;
  statusDraft: string;
  statusEnabled: string;
  statusArchived: string;
  branchFilter: string;
  branchAll: string;
  branchSynced: string;
  branchDiverged: string;
  listAria: string;
  paginationAria: string;
  actionAria: string;
  actionEdit: string;
  actionEditLocal: string;
  actionVersions: string;
  actionMarkDraft: string;
  actionArchive: string;
  actionArchiveLocal: string;
  actionPublish: string;
  actionPublishLocal: string;
  actionSync: string;
  actionPromote: string;
  actionDelete: string;
  actionRemove: string;
  columnName: string;
  columnId: string;
  columnDomain: string;
  columnVersion: string;
  columnBranch: string;
  columnCreator: string;
  columnStatus: string;
  columnCalls: string;
  columnPositiveRate: string;
  columnNegativeRate: string;
  columnActions: string;
  creatorPrefix: string;
  callPrefix: string;
  timesSuffix: string;
  positivePrefix: string;
  negativePrefix: string;
  emptyOverallManage: string;
  emptyOverallReadonly: string;
  emptyLocal: string;
  rankingCalls: string;
  rankingPositive: string;
  rankingNegative: string;
  rankingCurrent: string;
  rankingTotal: string;
  rankingMore: string;
  rankingEmpty: string;
  rankingTableAria: string;
  rankingPaginationAria: string;
  rankingTitleCalls: string;
  rankingTitlePositiveCurrent: string;
  rankingTitlePositiveTotal: string;
  rankingTitleNegativeCurrent: string;
  rankingTitleNegativeTotal: string;
  rankingMetricCalls: string;
  rankingMetricPositiveCurrent: string;
  rankingMetricPositiveTotal: string;
  rankingMetricNegativeCurrent: string;
  rankingMetricNegativeTotal: string;
  rankingFeedback: string;
  rankingRank: string;
  rankingVersionRange: string;
  importMarketplaceTitle: string;
  importEmployeeTitle: string;
  importMarketplacePlaceholder: string;
  importEmployeePlaceholder: string;
  importItemsLabel: string;
  importEmpty: string;
  importMarketplaceNote: string;
  importEmployeeNote: string;
  warningSelectEmployeeFirst: string;
  warningSelectMarketplace: string;
  warningSelectSourceEmployee: string;
  warningSelectSkills: string;
  copiedResult: string;
  copiedMissingSuffix: string;
  loadFailed: string;
  loadAgentsFailed: string;
  loadSourceFailed: string;
  copyFailed: string;
  enabledSuccess: string;
  enabledFailed: string;
  archivedSuccess: string;
  archivedFailed: string;
  draftSuccess: string;
  draftFailed: string;
  loadVersionsFailed: string;
  loadVersionDetailFailed: string;
  syncSuccess: string;
  syncFailed: string;
  removeSuccess: string;
  deleteSuccess: string;
  removeFailed: string;
  deleteFailed: string;
  rollbackSuccess: string;
  rollbackFailed: string;
  promoteSuccess: string;
  promoteFailed: string;
  versionActionAria: string;
  versionDetailAction: string;
  versionCurrentAction: string;
  versionRollbackAction: string;
  versionsTitle: string;
  versionsTitleEmpty: string;
  versionsTableAria: string;
  versionsEmpty: string;
  detailTitle: string;
  detailTitleEmpty: string;
  detailVersion: string;
  detailStatus: string;
  detailUpdatedAt: string;
  detailSourceAllVersions: string;
  deleteTitle: string;
  deleteDescriptionOverall: string;
  deleteDescriptionLocal: string;
  rollbackTitle: string;
  rollbackDescription: string;
  rollbackConfirm: string;
  promoteTitle: string;
  promoteDescription: string;
  promoteConfirm: string;
  detailNodesHeading: string;
  detailNodeTitle: string;
  detailNodeFallback: string;
};

/** 构造 SOP 页面产品文案，统一从语义 catalog 读取，避免 file-local locale copy 常量。 */
function buildSkillsPageCopy(translate: ReturnType<typeof useAppIntl>['t']): SkillsPageCopy {
  return {
    title: translate('skillsPage.title'),
    refresh: translate('skillsPage.refresh'),
    add: translate('skillsPage.add'),
    addBlank: translate('skillsPage.addBlank'),
    copyFromMarketplace: translate('skillsPage.copyFromMarketplace'),
    copyFromEmployee: translate('skillsPage.copyFromEmployee'),
    listOverall: translate('skillsPage.listOverall'),
    listLocal: translate('skillsPage.listLocal'),
    searchLabel: translate('skillsPage.searchLabel'),
    searchPlaceholder: translate('skillsPage.searchPlaceholder'),
    clearSearch: translate('skillsPage.clearSearch'),
    statusFilter: translate('skillsPage.statusFilter'),
    statusAll: translate('skillsPage.statusAll'),
    statusDraft: translate('skillsPage.statusDraft'),
    statusEnabled: translate('skillsPage.statusEnabled'),
    statusArchived: translate('skillsPage.statusArchived'),
    branchFilter: translate('skillsPage.branchFilter'),
    branchAll: translate('skillsPage.branchAll'),
    branchSynced: translate('skillsPage.branchSynced'),
    branchDiverged: translate('skillsPage.branchDiverged'),
    listAria: translate('skillsPage.listAria'),
    paginationAria: translate('skillsPage.paginationAria'),
    actionAria: translate('skillsPage.actionAria'),
    actionEdit: translate('skillsPage.actionEdit'),
    actionEditLocal: translate('skillsPage.actionEditLocal'),
    actionVersions: translate('skillsPage.actionVersions'),
    actionMarkDraft: translate('skillsPage.actionMarkDraft'),
    actionArchive: translate('skillsPage.actionArchive'),
    actionArchiveLocal: translate('skillsPage.actionArchiveLocal'),
    actionPublish: translate('skillsPage.actionPublish'),
    actionPublishLocal: translate('skillsPage.actionPublishLocal'),
    actionSync: translate('skillsPage.actionSync'),
    actionPromote: translate('skillsPage.actionPromote'),
    actionDelete: translate('skillsPage.actionDelete'),
    actionRemove: translate('skillsPage.actionRemove'),
    columnName: translate('skillsPage.columnName'),
    columnId: translate('skillsPage.columnId'),
    columnDomain: translate('skillsPage.columnDomain'),
    columnVersion: translate('skillsPage.columnVersion'),
    columnBranch: translate('skillsPage.columnBranch'),
    columnCreator: translate('skillsPage.columnCreator'),
    columnStatus: translate('skillsPage.columnStatus'),
    columnCalls: translate('skillsPage.columnCalls'),
    columnPositiveRate: translate('skillsPage.columnPositiveRate'),
    columnNegativeRate: translate('skillsPage.columnNegativeRate'),
    columnActions: translate('skillsPage.columnActions'),
    creatorPrefix: translate('skillsPage.creatorPrefix'),
    callPrefix: translate('skillsPage.callPrefix'),
    timesSuffix: translate('skillsPage.timesSuffix'),
    positivePrefix: translate('skillsPage.positivePrefix'),
    negativePrefix: translate('skillsPage.negativePrefix'),
    emptyOverallManage: translate('skillsPage.emptyOverallManage'),
    emptyOverallReadonly: translate('skillsPage.emptyOverallReadonly'),
    emptyLocal: translate('skillsPage.emptyLocal'),
    rankingCalls: translate('skillsPage.rankingCalls'),
    rankingPositive: translate('skillsPage.rankingPositive'),
    rankingNegative: translate('skillsPage.rankingNegative'),
    rankingCurrent: translate('skillsPage.rankingCurrent'),
    rankingTotal: translate('skillsPage.rankingTotal'),
    rankingMore: translate('skillsPage.rankingMore'),
    rankingEmpty: translate('skillsPage.rankingEmpty'),
    rankingTableAria: translate('skillsPage.rankingTableAria'),
    rankingPaginationAria: translate('skillsPage.rankingPaginationAria'),
    rankingTitleCalls: translate('skillsPage.rankingTitleCalls'),
    rankingTitlePositiveCurrent: translate('skillsPage.rankingTitlePositiveCurrent'),
    rankingTitlePositiveTotal: translate('skillsPage.rankingTitlePositiveTotal'),
    rankingTitleNegativeCurrent: translate('skillsPage.rankingTitleNegativeCurrent'),
    rankingTitleNegativeTotal: translate('skillsPage.rankingTitleNegativeTotal'),
    rankingMetricCalls: translate('skillsPage.rankingMetricCalls'),
    rankingMetricPositiveCurrent: translate('skillsPage.rankingMetricPositiveCurrent'),
    rankingMetricPositiveTotal: translate('skillsPage.rankingMetricPositiveTotal'),
    rankingMetricNegativeCurrent: translate('skillsPage.rankingMetricNegativeCurrent'),
    rankingMetricNegativeTotal: translate('skillsPage.rankingMetricNegativeTotal'),
    rankingFeedback: translate('skillsPage.rankingFeedback'),
    rankingRank: translate('skillsPage.rankingRank'),
    rankingVersionRange: translate('skillsPage.rankingVersionRange'),
    importMarketplaceTitle: translate('skillsPage.importMarketplaceTitle'),
    importEmployeeTitle: translate('skillsPage.importEmployeeTitle'),
    importMarketplacePlaceholder: translate('skillsPage.importMarketplacePlaceholder'),
    importEmployeePlaceholder: translate('skillsPage.importEmployeePlaceholder'),
    importItemsLabel: translate('skillsPage.importItemsLabel'),
    importEmpty: translate('skillsPage.importEmpty'),
    importMarketplaceNote: translate('skillsPage.importMarketplaceNote'),
    importEmployeeNote: translate('skillsPage.importEmployeeNote'),
    warningSelectEmployeeFirst: translate('skillsPage.warningSelectEmployeeFirst'),
    warningSelectMarketplace: translate('skillsPage.warningSelectMarketplace'),
    warningSelectSourceEmployee: translate('skillsPage.warningSelectSourceEmployee'),
    warningSelectSkills: translate('skillsPage.warningSelectSkills'),
    copiedResult: translate('skillsPage.copiedResult'),
    copiedMissingSuffix: translate('skillsPage.copiedMissingSuffix'),
    loadFailed: translate('skillsPage.loadFailed'),
    loadAgentsFailed: translate('skillsPage.loadAgentsFailed'),
    loadSourceFailed: translate('skillsPage.loadSourceFailed'),
    copyFailed: translate('skillsPage.copyFailed'),
    enabledSuccess: translate('skillsPage.enabledSuccess'),
    enabledFailed: translate('skillsPage.enabledFailed'),
    archivedSuccess: translate('skillsPage.archivedSuccess'),
    archivedFailed: translate('skillsPage.archivedFailed'),
    draftSuccess: translate('skillsPage.draftSuccess'),
    draftFailed: translate('skillsPage.draftFailed'),
    loadVersionsFailed: translate('skillsPage.loadVersionsFailed'),
    loadVersionDetailFailed: translate('skillsPage.loadVersionDetailFailed'),
    syncSuccess: translate('skillsPage.syncSuccess'),
    syncFailed: translate('skillsPage.syncFailed'),
    removeSuccess: translate('skillsPage.removeSuccess'),
    deleteSuccess: translate('skillsPage.deleteSuccess'),
    removeFailed: translate('skillsPage.removeFailed'),
    deleteFailed: translate('skillsPage.deleteFailed'),
    rollbackSuccess: translate('skillsPage.rollbackSuccess'),
    rollbackFailed: translate('skillsPage.rollbackFailed'),
    promoteSuccess: translate('skillsPage.promoteSuccess'),
    promoteFailed: translate('skillsPage.promoteFailed'),
    versionActionAria: translate('skillsPage.versionActionAria'),
    versionDetailAction: translate('skillsPage.versionDetailAction'),
    versionCurrentAction: translate('skillsPage.versionCurrentAction'),
    versionRollbackAction: translate('skillsPage.versionRollbackAction'),
    versionsTitle: translate('skillsPage.versionsTitle'),
    versionsTitleEmpty: translate('skillsPage.versionsTitleEmpty'),
    versionsTableAria: translate('skillsPage.versionsTableAria'),
    versionsEmpty: translate('skillsPage.versionsEmpty'),
    detailTitle: translate('skillsPage.detailTitle'),
    detailTitleEmpty: translate('skillsPage.detailTitleEmpty'),
    detailVersion: translate('skillsPage.detailVersion'),
    detailStatus: translate('skillsPage.detailStatus'),
    detailUpdatedAt: translate('skillsPage.detailUpdatedAt'),
    detailSourceAllVersions: translate('skillsPage.detailSourceAllVersions'),
    deleteTitle: translate('skillsPage.deleteTitle'),
    deleteDescriptionOverall: translate('skillsPage.deleteDescriptionOverall'),
    deleteDescriptionLocal: translate('skillsPage.deleteDescriptionLocal'),
    rollbackTitle: translate('skillsPage.rollbackTitle'),
    rollbackDescription: translate('skillsPage.rollbackDescription'),
    rollbackConfirm: translate('skillsPage.rollbackConfirm'),
    promoteTitle: translate('skillsPage.promoteTitle'),
    promoteDescription: translate('skillsPage.promoteDescription'),
    promoteConfirm: translate('skillsPage.promoteConfirm'),
    detailNodesHeading: translate('skillsPage.detailNodesHeading'),
    detailNodeTitle: translate('skillsPage.detailNodeTitle'),
    detailNodeFallback: translate('skillsPage.detailNodeFallback'),
  };
}

/** 返回当前 locale 的 SOP 页语义文案。 */
function useSkillsPageCopy(): SkillsPageCopy {
  const { t } = useAppIntl();
  return buildSkillsPageCopy(t);
}

/** 用当前 locale 格式化整数，避免把原始数字拼成固定语言文案。 */
function formatInteger(value: number | undefined, locale: 'zh-CN' | 'en-US'): string {
  return new Intl.NumberFormat(locale).format(value || 0);
}

/** 返回列表/排行里的“次数”显示，统一处理中英文后缀。 */
function callCountText(
  value: number | undefined,
  locale: 'zh-CN' | 'en-US',
  copy: SkillsPageCopy,
): string {
  const count = formatInteger(value, locale);
  return copy.timesSuffix ? `${count} ${copy.timesSuffix}` : count;
}

/** 返回移动卡片里的“调用 N 次 / Calls N”摘要。 */
function callSummaryText(
  value: number | undefined,
  locale: 'zh-CN' | 'en-US',
  copy: SkillsPageCopy,
): string {
  const count = formatInteger(value, locale);
  return copy.timesSuffix ? `${copy.callPrefix} ${count} ${copy.timesSuffix}` : `${copy.callPrefix} ${count}`;
}

/** 把稳定错误码投影为安全 UI 文案；未知异常只回退到当前页面的语义消息。 */
function skillsPageErrorMessage(
  error: unknown,
  fallback: string,
  t: ReturnType<typeof useAppIntl>['t'],
): string {
  const message = apiErrorMessage(error, 'common.error.generic', { t });
  return message === '发生错误，请稍后重试' || message === 'Something went wrong. Please try again later.'
    ? fallback
    : message;
}

/** 生成带可选 skipped 尾巴的复制结果，避免手工拼接中英顺序。 */
function copiedResultText(
  copy: SkillsPageCopy,
  locale: 'zh-CN' | 'en-US',
  importedCount: number,
  missingCount: number,
): string {
  const missing = missingCount
    ? copy.copiedMissingSuffix
      .replace('{count}', formatInteger(missingCount, locale))
    : '';
  return copy.copiedResult
    .replace('{imported}', formatInteger(importedCount, locale))
    .replace('{missing}', missing);
}

/** 统一状态 badge 的展示文案，未知状态继续保留原始值。 */
function statusBadgeText(status: SkillRead['status'], copy: SkillsPageCopy): string {
  if (status === 'draft') return copy.statusDraft;
  if (status === 'published') return copy.statusEnabled;
  if (status === 'archived') return copy.statusArchived;
  return status;
}

/** 返回当前状态 badge 的颜色和本地化文案。 */
function statusBadgePreset(status: SkillRead['status'], copy: SkillsPageCopy): { tone: BadgeTone; text: string } {
  if (status === 'draft') return { tone: 'blue', text: copy.statusDraft };
  if (status === 'published') return { tone: 'green', text: copy.statusEnabled };
  if (status === 'archived') return { tone: 'gray', text: copy.statusArchived };
  return { tone: 'gray', text: status };
}

type RankingMode = 'calls' | 'positive' | 'negative';
type RankingScope = 'current' | 'total';
type RankedSkill = SkillRead & { rank: number };
type RankingModalState = { mode: RankingMode; scope: RankingScope };
type SkillStatusFilter = 'all' | SkillRead['status'];
type BranchFilter = 'all' | 'synced' | 'diverged' | 'inactive';
type NumericSkillMetric =
  | 'call_count'
  | 'positive_feedback_count'
  | 'negative_feedback_count'
  | 'positive_rate'
  | 'negative_rate'
  | 'total_call_count'
  | 'total_positive_feedback_count'
  | 'total_negative_feedback_count'
  | 'total_positive_rate'
  | 'total_negative_rate'
  | 'recent_call_count'
  | 'recent_positive_feedback_count'
  | 'recent_negative_feedback_count'
  | 'recent_positive_rate'
  | 'recent_negative_rate';

export default function SkillsPage({
  currentUser,
  onLogout,
}: {
  currentUser?: EnterpriseAuthUser;
  onLogout?: () => void;
} = {}) {
  const { locale, t } = useAppIntl();
  const tenantContext = useTenantSession();
  const tenantClient = useMemo(() => createTenantClient(tenantContext), [tenantContext]);
  const tenantId = tenantContext?.tenantId || '';
  const userId = tenantContext?.userId || '';
  const copy = useSkillsPageCopy();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [rows, setRows] = useState<SkillRead[]>([]);
  const [versionRows, setVersionRows] = useState<SkillVersionRead[]>([]);
  const [versionSkill, setVersionSkill] = useState<SkillRead | null>(null);
  const [detailVersion, setDetailVersion] = useState<SkillVersionRead | null>(null);
  const [rankingModal, setRankingModal] = useState<RankingModalState | null>(null);
  const [positiveScope, setPositiveScope] = useState<RankingScope>('current');
  const [negativeScope, setNegativeScope] = useState<RankingScope>('current');
  const [versionModalOpen, setVersionModalOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [agentId, setAgentId] = useState(
    () => tenantId && userId ? readEmployeeScope(tenantId, userId) : '',
  );
  const [isOverallAgent, setIsOverallAgent] = useState(() => {
    const stored = tenantId && userId ? readEmployeeScope(tenantId, userId) : '';
    return !stored || stored.includes('overall');
  });
  const [searchText, setSearchText] = useState('');
  const [statusFilter, setStatusFilter] = useState<SkillStatusFilter>('all');
  const [branchFilter, setBranchFilter] = useState<BranchFilter>('all');
  const [agents, setAgents] = useState<AgentProfileRead[]>([]);
  const currentAgent = useMemo(() => agents.find((item) => item.id === agentId), [agents, agentId]);
  const canManageCurrentScope = currentAgent
    ? canManageEmployeeAgent(currentAgent, currentUser)
    : isEnterpriseAdmin(currentUser) && isOverallAgent;
  const [importOpen, setImportOpen] = useState(false);
  const [importMode, setImportMode] = useState<'plaza' | 'employee'>('plaza');
  const [importSourceAgentId, setImportSourceAgentId] = useState('');
  const [importSourceSkills, setImportSourceSkills] = useState<SkillRead[]>([]);
  const [importSelectedSkillIds, setImportSelectedSkillIds] = useState<string[]>([]);
  const [importLoading, setImportLoading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SkillRead | null>(null);
  const [rollbackTarget, setRollbackTarget] = useState<SkillVersionRead | null>(null);
  const [promoteTarget, setPromoteTarget] = useState<SkillRead | null>(null);
  const [confirmLoading, setConfirmLoading] = useState(false);
  const listLabel = isOverallAgent ? copy.listOverall : copy.listLocal;

  useEffect(() => {
    const scopedAgentId = tenantId && userId ? readEmployeeScope(tenantId, userId) : '';
    setAgentId(scopedAgentId);
    setIsOverallAgent(!scopedAgentId || scopedAgentId.includes('overall'));
    setRows([]);
    setAgents([]);
    setVersionRows([]);
    setVersionSkill(null);
  }, [tenantId, userId]);

  /** 加载当前作用域的 SOP 与员工列表，并把未知异常收敛到安全产品文案。 */
  const load = async () => {
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return;
    setLoading(true);
    try {
      const suffix = agentId ? `&agent_id=${encodeURIComponent(agentId)}` : '';
      const result = await tenantClient.get<SkillRead[]>(`/api/enterprise/skills?tenant_id=${tenantId}${suffix}`);
      if (!context.isCurrentGeneration(generation)) return;
      setRows(result);
      const agentRows = await tenantClient.get<AgentProfileRead[]>(`/api/enterprise/agents?tenant_id=${tenantId}`);
      if (!context.isCurrentGeneration(generation)) return;
      setAgents(agentRows);
      setIsOverallAgent(Boolean(agentRows.find((item) => item.id === agentId)?.is_overall ?? true));
    } catch (error) {
      if (!context.isCurrentGeneration(generation)) return;
      notify.error(skillsPageErrorMessage(error, copy.loadFailed, t));
    } finally {
      if (context.isCurrentGeneration(generation)) setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, tenantContext, tenantClient, tenantId]);

  useEffect(() => {
    if (searchParams.get('add') !== 'plaza') return;
    if (agents.length === 0) return;
    const resourceId = searchParams.get('resourceId') || undefined;
    if (isOverallAgent) {
      notify.warning(copy.warningSelectEmployeeFirst);
    } else {
      void openImport('plaza', resourceId);
    }
    const next = new URLSearchParams(searchParams);
    next.delete('add');
    next.delete('resourceId');
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents.length, isOverallAgent, searchParams, setSearchParams]);

  useEffect(() => {
    const onScopeChange = (event: Event) => {
      const next = (event as CustomEvent<{ agentId?: string }>).detail?.agentId || '';
      setAgentId(next && !isTeamScope(next) ? next : readEmployeeScope(tenantId, userId));
    };
    window.addEventListener('ultrarag-enterprise-agent-scope-change', onScopeChange);
    return () => window.removeEventListener('ultrarag-enterprise-agent-scope-change', onScopeChange);
  }, [tenantId, userId]);

  const filteredRows = useMemo(() => {
    const keyword = searchText.trim().toLowerCase();
    return rows.filter((row) => {
      const matchesKeyword =
        !keyword ||
        [
          row.name,
          row.skill_id,
          row.business_domain || '',
          row.description || '',
          row.version,
          resourceCreatorName(row),
        ].some((value) => value.toLowerCase().includes(keyword));
      const matchesStatus = statusFilter === 'all' || row.status === statusFilter;
      const branchState = row.branch_status === 'inactive' ? 'inactive' : row.branch_sync_state || 'synced';
      const matchesBranch = isOverallAgent || branchFilter === 'all' || branchState === branchFilter;
      return matchesKeyword && matchesStatus && matchesBranch;
    });
  }, [branchFilter, isOverallAgent, rows, searchText, statusFilter]);

  const pagination = useClientPagination(filteredRows, SKILL_PAGE_SIZE, `${searchText}|${statusFilter}|${branchFilter}`);

  const rankingRows = useMemo(
    () => ({
      calls: rankByMetric(rows, 'total_call_count'),
      positiveCurrent: rankByMetric(rows, 'positive_rate', 'positive_feedback_count', 'call_count'),
      positiveTotal: rankByMetric(rows, 'total_positive_rate', 'total_positive_feedback_count', 'total_call_count'),
      negativeCurrent: rankByMetric(rows, 'negative_rate', 'negative_feedback_count', 'call_count'),
      negativeTotal: rankByMetric(rows, 'total_negative_rate', 'total_negative_feedback_count', 'total_call_count'),
    }),
    [rows],
  );

  const positiveRankingRows = positiveScope === 'current' ? rankingRows.positiveCurrent : rankingRows.positiveTotal;
  const negativeRankingRows = negativeScope === 'current' ? rankingRows.negativeCurrent : rankingRows.negativeTotal;
  const rankingModalRows = rankingModal ? rankingRowsFor(rankingRows, rankingModal.mode, rankingModal.scope) : [];
  const rankingPagination = useClientPagination(rankingModalRows, RANKING_PAGE_SIZE, rankingModal);

  const columns: DataTableColumn<SkillRead>[] = [
    {
      key: 'name',
      title: copy.columnName,
      width: 170,
      className: 'text-[#18181a]',
      render: (row) => (
        <span className="block truncate" title={row.name}>
          <RawContent value={row.name} />
        </span>
      ),
    },
    {
      key: 'skill_id',
      title: copy.columnId,
      width: 170,
      render: (row) => (
        <span className="block truncate" title={row.skill_id}>
          <RawContent value={row.skill_id} />
        </span>
      ),
    },
    {
      key: 'business_domain',
      title: copy.columnDomain,
      width: 120,
      render: (row) => row.business_domain ? <span className="block truncate"><RawContent value={row.business_domain} /></span> : '-',
    },
    { key: 'version', title: copy.columnVersion, width: 80, render: (row) => row.version },
    {
      key: 'branch',
      title: copy.columnBranch,
      width: 110,
      render: (row) => renderBranchBadge(row, isOverallAgent, copy),
    },
    {
      key: 'creator',
      title: copy.columnCreator,
      width: 120,
      render: (row) => (
        <span className="block truncate text-[#858b9c]" title={resourceCreatorName(row)}>
          {resourceCreatorName(row) ? <RawContent value={resourceCreatorName(row) || ''} /> : '-'}
        </span>
      ),
    },
    {
      key: 'status',
      title: copy.columnStatus,
      width: 100,
      render: (row) => {
        const preset = statusBadgePreset(row.status, copy);
        return <StatusBadge tone={preset.tone}>{preset.text}</StatusBadge>;
      },
    },
    { key: 'call_count', title: copy.columnCalls, width: 90, render: (row) => callCountText(row.call_count, locale, copy) },
    { key: 'positive_rate', title: copy.columnPositiveRate, width: 90, render: (row) => percent(row.positive_rate, locale) },
    { key: 'negative_rate', title: copy.columnNegativeRate, width: 90, render: (row) => percent(row.negative_rate, locale) },
    {
      key: 'actions',
      title: copy.columnActions,
      width: 70,
      align: 'right',
      sticky: 'right',
      render: (row) => renderActions(row),
    },
  ];

  function renderActions(row: SkillRead) {
    if (isOverallAgent && !canManageCurrentScope) {
      return (
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={copy.actionAria}
            className="ml-auto grid size-7 place-items-center rounded-[8px] text-[#1a71ff] transition-colors outline-none hover:bg-black/5 hover:text-[#4a8dff] focus-visible:bg-black/5"
          >
            <IconMore className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className={MENU_CONTENT_CLASS}>
            <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => void openVersions(row)}>
              <IconHistory />
              {copy.actionVersions}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      );
    }
    return (
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={copy.actionAria}
          className="ml-auto grid size-7 place-items-center rounded-[8px] text-[#1a71ff] transition-colors outline-none hover:bg-black/5 hover:text-[#4a8dff] focus-visible:bg-black/5"
        >
          <IconMore className="size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className={MENU_CONTENT_CLASS}>
          <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => openEdit(row)}>
            <IconEdit />
            {isOverallAgent ? copy.actionEdit : copy.actionEditLocal}
          </DropdownMenuItem>
          <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => void openVersions(row)}>
            <IconHistory />
            {copy.actionVersions}
          </DropdownMenuItem>
          {isOverallAgent && row.status !== 'draft' && (
            <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => void markDraft(row)}>
              <IconEdit />
              {copy.actionMarkDraft}
            </DropdownMenuItem>
          )}
          {row.status === 'published' ? (
            <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => void archive(row)}>
              <Ban />
              {isOverallAgent ? copy.actionArchive : copy.actionArchiveLocal}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => void publish(row)}>
              <CircleCheck />
              {isOverallAgent ? copy.actionPublish : copy.actionPublishLocal}
            </DropdownMenuItem>
          )}
          {!isOverallAgent && (
            <>
              <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => void syncFromOverall(row)}>
                <IconRefresh />
                {copy.actionSync}
              </DropdownMenuItem>
              <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => setPromoteTarget(row)}>
                <Upload />
                {copy.actionPromote}
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuSeparator className="my-[2px] bg-[#eef0f4]" />
          <DropdownMenuItem
            variant="destructive"
            className={MENU_ITEM_DANGER_CLASS}
            onSelect={() => setDeleteTarget(row)}
          >
            <IconTrash />
            {isOverallAgent ? copy.actionDelete : copy.actionRemove}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  /** 渲染窄屏卡片，raw SOP 名称/ID/业务域保持逐字显示。 */
  const renderMobileCard = (row: SkillRead) => {
    const preset = statusBadgePreset(row.status, copy);
    return (
      <article className={MOBILE_CARD_CLASS} key={row.id}>
        <div className="flex min-w-0 items-start justify-between gap-[10px]">
          <div className="min-w-0">
            <strong className="block truncate text-[14px] font-semibold text-[#18181a]"><RawContent value={row.name} /></strong>
            <span className="mt-[2px] block truncate text-[12px] text-[#858b9c]"><RawContent value={row.skill_id} /></span>
            <span className="mt-[2px] block truncate text-[12px] text-[#858b9c]">
              {copy.creatorPrefix}
              {resourceCreatorName(row) ? <RawContent value={resourceCreatorName(row) || ''} /> : '-'}
            </span>
          </div>
          {renderActions(row)}
        </div>
        <div className="mt-[10px] flex flex-wrap items-center gap-[4px]">
          <StatusBadge tone={preset.tone}>{preset.text}</StatusBadge>
          {renderBranchBadge(row, isOverallAgent, copy)}
          {row.business_domain && <StatusBadge tone="gray"><RawContent value={row.business_domain} /></StatusBadge>}
        </div>
        <div className="mt-[10px] flex items-center justify-between gap-[10px] text-[12px] text-[#858b9c]">
          <span>{callSummaryText(row.call_count, locale, copy)}</span>
          <span>
            {copy.positivePrefix} {percent(row.positive_rate, locale)} · {copy.negativePrefix} {percent(row.negative_rate, locale)}
          </span>
        </div>
      </article>
    );
  };

  async function openImport(mode: 'plaza' | 'employee' = 'plaza', selectedResourceId?: string) {
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return;
    try {
      const agentRows = agents.length
        ? agents
        : await tenantClient.get<AgentProfileRead[]>(`/api/enterprise/agents?tenant_id=${tenantId}`);
      if (!context.isCurrentGeneration(generation)) return;
      setAgents(agentRows);
      setImportMode(mode);
      const firstSource = mode === 'plaza'
        ? openGalleryAgentId(agentRows)
        : visibleEmployeeAgents(agentRows, currentUser, { activeOnly: true, excludeAgentId: agentId })[0]?.id || '';
      setImportSourceAgentId(firstSource);
      setImportSelectedSkillIds([]);
      setImportOpen(true);
      if (firstSource) {
        const sourceRows = await loadImportSourceSkills(firstSource);
        if (!context.isCurrentGeneration(generation)) return;
        if (selectedResourceId && sourceRows.some((item) => item.id === selectedResourceId)) {
          setImportSelectedSkillIds([selectedResourceId]);
        }
      } else {
        setImportSourceSkills([]);
      }
    } catch (error) {
      if (!context.isCurrentGeneration(generation)) return;
      notify.error(skillsPageErrorMessage(error, copy.loadAgentsFailed, t));
    }
  }

  async function loadImportSourceSkills(sourceAgentId: string): Promise<SkillRead[]> {
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return [];
    setImportSourceSkills([]);
    setImportSelectedSkillIds([]);
    if (!sourceAgentId) return [];
    try {
      const sourceRows = await tenantClient.get<SkillRead[]>(`/api/enterprise/agents/${sourceAgentId}/skills?tenant_id=${tenantId}`);
      if (!context.isCurrentGeneration(generation)) return [];
      const publishedRows = sourceRows.filter((item) => item.status === 'published');
      setImportSourceSkills(publishedRows);
      return publishedRows;
    } catch (error) {
      if (!context.isCurrentGeneration(generation)) return [];
      notify.error(skillsPageErrorMessage(error, copy.loadSourceFailed, t));
      return [];
    }
  }

  async function submitImportSkills() {
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return;
    if (!agentId) {
      notify.warning(copy.warningSelectEmployeeFirst);
      return;
    }
    if (!importSourceAgentId) {
      notify.warning(importMode === 'plaza' ? copy.warningSelectMarketplace : copy.warningSelectSourceEmployee);
      return;
    }
    if (importSelectedSkillIds.length === 0) {
      notify.warning(copy.warningSelectSkills);
      return;
    }
    setImportLoading(true);
    try {
      const result = await tenantClient.post<{ imported: Array<Record<string, unknown>>; missing: Array<Record<string, unknown>> }>(
        `/api/enterprise/agents/${agentId}/resources/import`,
        {
          tenant_id: tenantId,
          source_agent_id: importSourceAgentId,
          resource_type: 'skill',
          resource_ids: importSelectedSkillIds,
        },
      );
      if (!context.isCurrentGeneration(generation)) return;
      const importedCount = result.imported?.length || 0;
      const missingCount = result.missing?.length || 0;
      notify.successText(copiedResultText(copy, locale, importedCount, missingCount));
      setImportOpen(false);
      await load();
    } catch (error) {
      if (!context.isCurrentGeneration(generation)) return;
      notify.error(skillsPageErrorMessage(error, copy.copyFailed, t));
    } finally {
      if (context.isCurrentGeneration(generation)) setImportLoading(false);
    }
  }

  function openCreate() {
    const params = new URLSearchParams({
      mode: 'create',
      workspace_id: createDistillWorkspaceId(),
    });
    if (agentId) params.set('agent_id', agentId);
    navigate(`/enterprise/skills/distill?${params.toString()}`);
  }

  function openEdit(row: SkillRead) {
    const suffix = agentId ? `&agent_id=${encodeURIComponent(agentId)}` : '';
    navigate(`/enterprise/skills/distill?skill_id=${encodeURIComponent(row.skill_id)}${suffix}`);
  }

  async function publish(row: SkillRead) {
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return;
    try {
      await tenantClient.post(`/api/enterprise/skills/${row.skill_id}/publish?tenant_id=${tenantId}${agentQuery()}`);
      if (!context.isCurrentGeneration(generation)) return;
      notify.successText(copy.enabledSuccess);
      await load();
    } catch (error) {
      if (!context.isCurrentGeneration(generation)) return;
      notify.error(skillsPageErrorMessage(error, copy.enabledFailed, t));
    }
  }

  async function archive(row: SkillRead) {
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return;
    try {
      await tenantClient.post(`/api/enterprise/skills/${row.skill_id}/archive?tenant_id=${tenantId}${agentQuery()}`);
      if (!context.isCurrentGeneration(generation)) return;
      notify.successText(copy.archivedSuccess);
      await load();
    } catch (error) {
      if (!context.isCurrentGeneration(generation)) return;
      notify.error(skillsPageErrorMessage(error, copy.archivedFailed, t));
    }
  }

  async function markDraft(row: SkillRead) {
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return;
    try {
      await tenantClient.post(`/api/enterprise/skills/${row.skill_id}/draft?tenant_id=${tenantId}${agentQuery()}`);
      if (!context.isCurrentGeneration(generation)) return;
      notify.successText(copy.draftSuccess);
      await load();
    } catch (error) {
      if (!context.isCurrentGeneration(generation)) return;
      notify.error(skillsPageErrorMessage(error, copy.draftFailed, t));
    }
  }

  async function openVersions(row: SkillRead) {
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return;
    setVersionSkill(row);
    setVersionModalOpen(true);
    setVersionRows([]);
    try {
      const result = await tenantClient.get<SkillVersionRead[]>(
        `/api/enterprise/skills/${encodeURIComponent(row.skill_id)}/versions?tenant_id=${tenantId}${agentQuery()}`,
      );
      if (!context.isCurrentGeneration(generation)) return;
      setVersionRows(result);
    } catch (error) {
      if (!context.isCurrentGeneration(generation)) return;
      notify.error(skillsPageErrorMessage(error, copy.loadVersionsFailed, t));
    }
  }

  async function showVersionDetail(row: SkillVersionRead) {
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return;
    try {
      const result = await tenantClient.get<SkillVersionRead>(
        `/api/enterprise/skills/${encodeURIComponent(row.skill_id)}/versions/${encodeURIComponent(row.version)}?tenant_id=${tenantId}${agentQuery()}`,
      );
      if (!context.isCurrentGeneration(generation)) return;
      setDetailVersion(result);
    } catch (error) {
      if (!context.isCurrentGeneration(generation)) return;
      notify.error(skillsPageErrorMessage(error, copy.loadVersionDetailFailed, t));
    }
  }

  async function syncFromOverall(row: SkillRead) {
    if (!agentId) return;
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return;
    try {
      await tenantClient.post(
        `/api/enterprise/agents/${agentId}/skills/${encodeURIComponent(row.skill_id)}/sync-from-overall?tenant_id=${tenantId}`,
      );
      if (!context.isCurrentGeneration(generation)) return;
      notify.successText(copy.syncSuccess);
      await load();
    } catch (error) {
      if (!context.isCurrentGeneration(generation)) return;
      notify.error(skillsPageErrorMessage(error, copy.syncFailed, t));
    }
  }

  async function confirmDelete() {
    const row = deleteTarget;
    if (!row) return;
    const branchMode = !isOverallAgent;
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return;
    setConfirmLoading(true);
    try {
      await tenantClient.delete(`/api/enterprise/skills/${row.skill_id}?tenant_id=${tenantId}${agentQuery()}`);
      if (!context.isCurrentGeneration(generation)) return;
      notify.successText(branchMode ? copy.removeSuccess : copy.deleteSuccess);
      setDeleteTarget(null);
      await load();
    } catch (error) {
      if (!context.isCurrentGeneration(generation)) return;
      notify.error(skillsPageErrorMessage(error, branchMode ? copy.removeFailed : copy.deleteFailed, t));
    } finally {
      if (context.isCurrentGeneration(generation)) setConfirmLoading(false);
    }
  }

  async function confirmRollback() {
    const row = rollbackTarget;
    if (!row) return;
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return;
    setConfirmLoading(true);
    try {
      const result = await tenantClient.post<SkillRead>(
        `/api/enterprise/skills/${encodeURIComponent(row.skill_id)}/versions/${encodeURIComponent(row.version)}/rollback?tenant_id=${tenantId}${agentQuery()}`,
      );
      if (!context.isCurrentGeneration(generation)) return;
      notify.successText(copy.rollbackSuccess.replace('{version}', row.version));
      setRollbackTarget(null);
      await load();
      if (!context.isCurrentGeneration(generation)) return;
      await openVersions(result);
    } catch (error) {
      if (!context.isCurrentGeneration(generation)) return;
      notify.error(skillsPageErrorMessage(error, copy.rollbackFailed, t));
    } finally {
      if (context.isCurrentGeneration(generation)) setConfirmLoading(false);
    }
  }

  async function confirmPromote() {
    const row = promoteTarget;
    if (!row || !agentId) return;
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return;
    setConfirmLoading(true);
    try {
      await tenantClient.post(
        `/api/enterprise/agents/${agentId}/skills/${encodeURIComponent(row.skill_id)}/promote-to-overall?tenant_id=${tenantId}`,
      );
      if (!context.isCurrentGeneration(generation)) return;
      notify.successText(copy.promoteSuccess);
      setPromoteTarget(null);
      await load();
    } catch (error) {
      if (!context.isCurrentGeneration(generation)) return;
      notify.error(skillsPageErrorMessage(error, copy.promoteFailed, t));
    } finally {
      if (context.isCurrentGeneration(generation)) setConfirmLoading(false);
    }
  }

  function agentQuery() {
    return agentId ? `&agent_id=${encodeURIComponent(agentId)}` : '';
  }

  const listEmptyText = isOverallAgent
    ? canManageCurrentScope ? copy.emptyOverallManage : copy.emptyOverallReadonly
    : copy.emptyLocal;

  return (
    <div className="min-h-full box-border px-[48px] pt-[32px] pb-[43px] max-[900px]:px-[16px]" aria-busy={loading}>
      <AppHeader onLogout={onLogout} userName={currentUser?.username} title={copy.title} />

      <div className="mt-[20px] mb-[16px] flex items-center justify-end gap-[12px]">
        <UIButton
          variant="outline"
          onClick={() => void load()}
          disabled={loading}
          className="h-[34px] gap-[4px] rounded-[10px] border-[0.5px] border-[#e3e7f1] bg-white px-[20px] text-[12px] font-normal text-[#757f9c] hover:border-[#cbd3e6] hover:bg-white hover:text-[#18181a]"
        >
          <IconRefresh className={cn('size-[14px]', loading && 'animate-spin')} />
          {copy.refresh}
        </UIButton>
        {canManageCurrentScope && (
          <DropdownMenu>
            <DropdownMenuTrigger data-guide-target="sop-create" className="flex h-[34px] items-center gap-[4px] rounded-[10px] bg-[#18181a] px-[20px] text-[12px] font-normal text-white outline-none transition-colors hover:bg-[#303030]">
              <IconAdd className="size-[14px]" />
              {copy.add}
              <IconChevronDown className="size-[12px]" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className={MENU_CONTENT_CLASS}>
              <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => openCreate()}>
                <IconAdd />
                {copy.addBlank}
              </DropdownMenuItem>
              {!isOverallAgent && (
                <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => void openImport('plaza')}>
                  <Copy />
                  {copy.copyFromMarketplace}
                </DropdownMenuItem>
              )}
              {!isOverallAgent && (
                <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => void openImport('employee')}>
                  <Users />
                  {copy.copyFromEmployee}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <div className="flex flex-col gap-[24px] rounded-[20px_20px_0_0] bg-white p-[18px_18px_24px_18px] shadow-[0_-4px_16px_0_rgba(0,0,0,0.05)]">
        <div className="flex flex-col gap-[18px]">
          <div className="flex items-center gap-[6px] px-[12px] text-[#757f9c]">
            <IconClipboard className="size-[14px] shrink-0" />
            <span className="text-[14px] font-normal leading-none">{listLabel}</span>
          </div>

          <div className="flex flex-wrap items-center gap-[16px]">
            <label className="flex h-[34px] w-[260px] items-center gap-[8px] overflow-hidden rounded-[10px] border-[0.5px] border-[#e3e7f1] bg-white px-[12px] transition-colors focus-within:border-[#18181a] max-[900px]:w-full">
              <IconSearch className="size-[14px] shrink-0 text-[#858b9c]" />
              <input
                autoComplete="off"
                data-1p-ignore="true"
                data-lpignore="true"
                data-bwignore="true"
                aria-label={copy.searchLabel}
                value={searchText}
                placeholder={copy.searchPlaceholder}
                onChange={(event) => setSearchText(event.target.value)}
                className="h-full min-w-0 flex-1 bg-transparent text-[12px] text-[#17191f] outline-none placeholder:text-[#c0c6d4]"
              />
              {searchText && (
                <button
                  type="button"
                  aria-label={copy.clearSearch}
                  onClick={() => setSearchText('')}
                  className="grid size-[16px] shrink-0 place-items-center text-[#c0c6d4] hover:text-[#858b9c]"
                >
                  <IconClear className="size-[14px]" />
                </button>
              )}
            </label>
            <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as SkillStatusFilter)}>
              <SelectTrigger className={cn(SELECT_TRIGGER_CLASS, 'w-[130px]')} aria-label={copy.statusFilter}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{copy.statusAll}</SelectItem>
                <SelectItem value="published">{copy.statusEnabled}</SelectItem>
                <SelectItem value="draft">{copy.statusDraft}</SelectItem>
                <SelectItem value="archived">{copy.statusArchived}</SelectItem>
              </SelectContent>
            </Select>
            {!isOverallAgent && (
              <Select value={branchFilter} onValueChange={(value) => setBranchFilter(value as BranchFilter)}>
                <SelectTrigger className={cn(SELECT_TRIGGER_CLASS, 'w-[130px]')} aria-label={copy.branchFilter}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{copy.branchAll}</SelectItem>
                  <SelectItem value="synced">{copy.branchSynced}</SelectItem>
                  <SelectItem value="diverged">{copy.branchDiverged}</SelectItem>
                  <SelectItem value="inactive">{copy.statusArchived}</SelectItem>
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="grid gap-[10px] md:hidden">
            {filteredRows.length ? (
              pagination.pagedItems.map(renderMobileCard)
            ) : (
              <div className="py-[40px] text-center text-[13px] text-[#858b9c]">{listEmptyText}</div>
            )}
          </div>

          <div className="hidden md:block">
            <DataTable
              aria-label={copy.listAria}
              columns={columns}
              data={pagination.pagedItems}
              rowKey={(row) => row.id}
              loading={loading}
              emptyText={listEmptyText}
            />
          </div>

          {filteredRows.length > 0 && (
            <Paginator
              aria-label={copy.paginationAria}
              className="mt-0 mb-[6px]"
              page={pagination.page}
              pageCount={pagination.pageCount}
              onChange={pagination.setPage}
            />
          )}
        </div>

        <div className="grid grid-cols-1 gap-[16px] lg:grid-cols-3">
          <RankingCard
            title={copy.rankingCalls}
            rows={rankingRows.calls.slice(0, 5)}
            value={(row) => callCountText(row.total_call_count, locale, copy)}
            copy={copy}
            onMore={() => setRankingModal({ mode: 'calls', scope: 'total' })}
          />
          <RankingCard
            title={copy.rankingPositive}
            rows={positiveRankingRows.slice(0, 5)}
            value={(row) => percent(positiveScope === 'current' ? row.positive_rate : row.total_positive_rate, locale)}
            version={(row) => rankingVersionText(row, positiveScope, copy)}
            scope={positiveScope}
            onScopeChange={setPositiveScope}
            copy={copy}
            onMore={() => setRankingModal({ mode: 'positive', scope: positiveScope })}
          />
          <RankingCard
            title={copy.rankingNegative}
            rows={negativeRankingRows.slice(0, 5)}
            value={(row) => percent(negativeScope === 'current' ? row.negative_rate : row.total_negative_rate, locale)}
            version={(row) => rankingVersionText(row, negativeScope, copy)}
            scope={negativeScope}
            onScopeChange={setNegativeScope}
            copy={copy}
            onMore={() => setRankingModal({ mode: 'negative', scope: negativeScope })}
          />
        </div>
      </div>

      <ResourceImportDialog
        open={importOpen}
        loading={importLoading}
        icon={<IconSkill className="size-[14px] shrink-0" />}
        title={importMode === 'plaza' ? copy.importMarketplaceTitle : copy.importEmployeeTitle}
        sourcePlaceholder={importMode === 'plaza' ? copy.importMarketplacePlaceholder : copy.importEmployeePlaceholder}
        sources={importMode === 'plaza'
          ? openGalleryImportSourceOptions(agents, copy.importMarketplacePlaceholder)
          : visibleEmployeeAgents(agents, currentUser, { activeOnly: true, excludeAgentId: agentId })
            .map((item) => ({ value: item.id, label: item.name }))}
        sourceId={importSourceAgentId}
        itemsLabel={copy.importItemsLabel}
        items={importSourceSkills.map((item) => ({
          id: item.id,
          label: (
            <>
              <RawContent value={item.name} />
              <span className="text-[#858b9c]"> · {item.skill_id}</span>
            </>
          ),
        }))}
        selectedIds={importSelectedSkillIds}
        emptyText={copy.importEmpty}
        note={
          importMode === 'plaza'
            ? copy.importMarketplaceNote
            : copy.importEmployeeNote
        }
        onSourceChange={(value) => {
          setImportSourceAgentId(value);
          void loadImportSourceSkills(value);
        }}
        onSelectedChange={setImportSelectedSkillIds}
        onClose={() => setImportOpen(false)}
        onSubmit={() => void submitImportSkills()}
      />

      <RankingDialog
        modal={rankingModal}
        rows={rankingPagination.pagedItems}
        page={rankingPagination.page}
        pageCount={rankingPagination.pageCount}
        onPageChange={rankingPagination.setPage}
        total={rankingModalRows.length}
        locale={locale}
        copy={copy}
        onClose={() => setRankingModal(null)}
      />

      <VersionsDialog
        open={versionModalOpen}
        skill={versionSkill}
        rows={versionRows}
        loading={loading}
        locale={locale}
        copy={copy}
        onDetail={(row) => void showVersionDetail(row)}
        onRollback={(row) => setRollbackTarget(row)}
        onClose={() => {
          setVersionModalOpen(false);
          setVersionSkill(null);
        }}
      />

      <VersionDetailDialog detail={detailVersion} locale={locale} copy={copy} onClose={() => setDetailVersion(null)} />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        loading={confirmLoading}
        title={
          deleteTarget
            ? copy.deleteTitle
              .replace('{action}', isOverallAgent ? copy.actionDelete : copy.actionRemove)
              .replace('{name}', deleteTarget.name)
            : ''
        }
        description={
          isOverallAgent
            ? copy.deleteDescriptionOverall
            : copy.deleteDescriptionLocal
        }
        confirmText={isOverallAgent ? copy.actionDelete : copy.actionRemove}
        onConfirm={() => void confirmDelete()}
      />

      <ConfirmDialog
        open={Boolean(rollbackTarget)}
        onOpenChange={(open) => !open && setRollbackTarget(null)}
        loading={confirmLoading}
        destructive={false}
        title={rollbackTarget ? copy.rollbackTitle.replace('{version}', rollbackTarget.version) : ''}
        description={
          rollbackTarget
            ? copy.rollbackDescription
              .replace('{name}', rollbackTarget.name)
              .replace('{version}', rollbackTarget.version)
            : ''
        }
        confirmText={copy.rollbackConfirm}
        onConfirm={() => void confirmRollback()}
      />

      <ConfirmDialog
        open={Boolean(promoteTarget)}
        onOpenChange={(open) => !open && setPromoteTarget(null)}
        loading={confirmLoading}
        destructive={false}
        title={promoteTarget ? copy.promoteTitle.replace('{name}', promoteTarget.name) : ''}
        description={copy.promoteDescription}
        confirmText={copy.promoteConfirm}
        onConfirm={() => void confirmPromote()}
      />
    </div>
  );
}

function createDistillWorkspaceId(): string {
  if (typeof window.crypto?.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** 统一渲染分支状态 badge，未知状态仍保留结构上的安全默认。 */
function renderBranchBadge(
  row: SkillRead,
  isOverallAgent: boolean,
  copy: SkillsPageCopy,
) {
  if (isOverallAgent) return <StatusBadge tone="gray">{copy.listOverall}</StatusBadge>;
  if (row.branch_status === 'inactive') return <StatusBadge tone="gray">{copy.statusArchived}</StatusBadge>;
  const state = row.branch_sync_state || 'synced';
  return state === 'diverged' ? (
    <StatusBadge tone="orange">{copy.branchDiverged}</StatusBadge>
  ) : (
    <StatusBadge tone="green">{copy.branchSynced}</StatusBadge>
  );
}

/** 渲染排行作用域切换，避免 current/total 常量直接暴露到最终 UI。 */
function ScopeToggle({
  value,
  onChange,
  copy,
}: {
  value: RankingScope;
  onChange: (scope: RankingScope) => void;
  copy: SkillsPageCopy;
}) {
  return (
    <div className="inline-flex items-center rounded-[8px] bg-[#f2f3f7] p-[2px]">
      {(['current', 'total'] as RankingScope[]).map((scope) => (
        <button
          key={scope}
          type="button"
          onClick={() => onChange(scope)}
          className={cn(
            'rounded-[6px] px-[10px] py-[3px] text-[11px] leading-none transition-colors',
            value === scope
              ? 'bg-white text-[#18181a] shadow-sm'
              : 'text-[#858b9c] hover:text-[#18181a]',
          )}
        >
          {scope === 'current' ? copy.rankingCurrent : copy.rankingTotal}
        </button>
      ))}
    </div>
  );
}

function RankingCard({
  title,
  rows,
  value,
  version,
  scope,
  onScopeChange,
  onMore,
  copy,
}: {
  title: string;
  rows: RankedSkill[];
  value: (row: RankedSkill) => string;
  version?: (row: RankedSkill) => string;
  scope?: RankingScope;
  onScopeChange?: (scope: RankingScope) => void;
  onMore: () => void;
  copy: SkillsPageCopy;
}) {
  return (
    <section className="flex flex-col rounded-[14px] border border-[#eef0f4] bg-white p-[16px]">
      <header className="mb-[8px] flex items-center justify-between gap-[8px]">
        <span className="text-[13px] font-medium text-[#18181a]">{title}</span>
        <div className="flex items-center gap-[8px]">
          {scope && onScopeChange && <ScopeToggle value={scope} onChange={onScopeChange} copy={copy} />}
          <button
            type="button"
            onClick={onMore}
            className="text-[12px] text-[#1a71ff] transition-colors hover:text-[#4a8dff]"
          >
            {copy.rankingMore}
          </button>
        </div>
      </header>
      {rows.length === 0 ? (
        <div className="py-[28px] text-center text-[12px] text-[#858b9c]">{copy.rankingEmpty}</div>
      ) : (
        <div className="flex flex-col">
          {rows.map((row) => (
            <div
              key={`${title}_${row.skill_id}`}
              className="flex items-center gap-[10px] border-b border-[#f2f3f7] py-[9px] last:border-0"
            >
              <span className="grid size-[20px] shrink-0 place-items-center rounded-[6px] bg-[#f6f6f6] text-[11px] leading-none text-[#464c5e]">
                {row.rank}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] text-[#18181a]" title={row.name}>
                  <RawContent value={row.name} />
                </div>
                {version && <div className="text-[11px] text-[#858b9c]">{version(row)}</div>}
              </div>
              <strong className="shrink-0 text-[12px] font-medium text-[#18181a]">{value(row)}</strong>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function RankingDialog({
  modal,
  rows,
  page,
  pageCount,
  onPageChange,
  total,
  onClose,
  locale,
  copy,
}: {
  modal: RankingModalState | null;
  rows: RankedSkill[];
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
  total: number;
  onClose: () => void;
  locale: 'zh-CN' | 'en-US';
  copy: SkillsPageCopy;
}) {
  const mode = modal?.mode || 'calls';
  const scope = modal?.scope || 'total';
  const columns: DataTableColumn<RankedSkill>[] = [
    { key: 'rank', title: copy.rankingRank, width: 60, render: (row) => row.rank },
    {
      key: 'name',
      title: copy.columnName,
      width: 180,
      className: 'text-[#18181a]',
      render: (row) => (
        <span className="block min-[180px]" title={row.name}>
          <RawContent value={row.name} />
        </span>
      ),
    },
    {
      key: 'skill_id',
      width: 80,
      title: copy.columnId,
      render: (row) => (
        <span className="block truncate" title={row.skill_id}>
          <RawContent value={row.skill_id} />
        </span>
      ),
    },
    { key: 'version', title: scope === 'current' ? copy.columnVersion : copy.rankingVersionRange, width: 110, render: (row) => rankingVersionText(row, scope, copy) },
    {
      key: 'domain',
      title: copy.columnDomain,
      width: 120,
      render: (row) => row.business_domain ? <span className="block truncate"><RawContent value={row.business_domain} /></span> : '-',
    },
    { key: 'metric', title: rankingMetricTitle(mode, scope, copy), width: 120, render: (row) => rankingMetricValue(row, mode, scope, locale, copy) },
    { key: 'calls', title: copy.columnCalls, render: (row) => callCountText(rankingCalls(row, scope), locale, copy) },
    { key: 'pos', title: copy.columnPositiveRate, render: (row) => percent(rankingPositiveRate(row, scope), locale) },
    { key: 'neg', title: copy.columnNegativeRate, render: (row) => percent(rankingNegativeRate(row, scope), locale) },
    { key: 'fb', title: copy.rankingFeedback, render: (row) => rankingFeedbackText(row, scope) },
  ];
  return (
    <Dialog open={Boolean(modal)} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        aria-describedby={undefined}
        className="flex max-h-[calc(100dvh-4rem)] w-[calc(100%-2rem)] flex-col gap-[16px] overflow-hidden rounded-[14px] px-[20px] py-[16px] sm:max-w-[1000px]"
      >
        <div className="flex items-center gap-[6px] px-[12px] text-[#757f9c]">
          <IconSkill className="size-[14px] shrink-0" />
          <DialogTitle className="text-[14px] font-normal leading-none text-[#757f9c]">
            {rankingTitle(mode, scope, copy)}
          </DialogTitle>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-[16px] overflow-y-auto px-[12px]">
          <div className="overflow-x-auto">
            <DataTable
              aria-label={copy.rankingTableAria}
              className="min-w-[900px]"
              columns={columns}
              data={rows}
              rowKey={(row) => row.skill_id}
              emptyText={copy.rankingEmpty}
            />
          </div>
          {total > 0 && (
            <Paginator aria-label={copy.rankingPaginationAria} page={page} pageCount={pageCount} onChange={onPageChange} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function VersionsDialog({
  open,
  skill,
  rows,
  loading,
  locale,
  copy,
  onDetail,
  onRollback,
  onClose,
}: {
  open: boolean;
  skill: SkillRead | null;
  rows: SkillVersionRead[];
  loading: boolean;
  locale: 'zh-CN' | 'en-US';
  copy: SkillsPageCopy;
  onDetail: (row: SkillVersionRead) => void;
  onRollback: (row: SkillVersionRead) => void;
  onClose: () => void;
}) {
  const columns: DataTableColumn<SkillVersionRead>[] = [
    { key: 'version', title: copy.columnVersion, width: 100, className: 'text-[#18181a]', render: (row) => row.version },
    {
      key: 'name',
      title: copy.columnName,
      render: (row) => (
        <span className="block truncate" title={row.name}>
          <RawContent value={row.name} />
        </span>
      ),
    },
    {
      key: 'domain',
      title: copy.columnDomain,
      width: 130,
      render: (row) => row.business_domain ? <span className="block truncate"><RawContent value={row.business_domain} /></span> : '-',
    },
    { key: 'calls', title: copy.columnCalls, width: 100, render: (row) => callCountText(row.call_count, locale, copy) },
    { key: 'pos', title: copy.columnPositiveRate, width: 90, render: (row) => percent(row.positive_rate, locale) },
    { key: 'neg', title: copy.columnNegativeRate, width: 90, render: (row) => percent(row.negative_rate, locale) },
    { key: 'updated', title: copy.detailUpdatedAt, width: 120, render: (row) => row.updated_at.slice(0, 10) },
    {
      key: 'actions',
      title: copy.columnActions,
      width: 70,
      align: 'right',
      render: (row) => {
        const isCurrent = row.version === skill?.version;
        return (
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={copy.versionActionAria}
              className="ml-auto grid size-7 place-items-center rounded-[8px] text-[#1a71ff] transition-colors outline-none hover:bg-black/5 hover:text-[#4a8dff] focus-visible:bg-black/5"
            >
              <IconMore className="size-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className={MENU_CONTENT_CLASS}>
              <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => onDetail(row)}>
                <Eye />
                {copy.versionDetailAction}
              </DropdownMenuItem>
              <DropdownMenuItem
                className={MENU_ITEM_CLASS}
                disabled={isCurrent}
                onSelect={() => onRollback(row)}
              >
                <RotateCcw />
                {isCurrent ? copy.versionCurrentAction : copy.versionRollbackAction}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        );
      },
    },
  ];
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        aria-describedby={undefined}
        className="flex max-h-[calc(100dvh-4rem)] w-[calc(100%-2rem)] flex-col gap-[16px] overflow-hidden rounded-[14px] px-[20px] py-[16px] sm:max-w-[960px]"
      >
        <div className="flex items-center gap-[6px] px-[12px] text-[#757f9c]">
          <IconHistory className="size-[14px] shrink-0" />
          <DialogTitle className="min-w-0 truncate text-[14px] font-normal leading-none text-[#757f9c]">
            {skill ? copy.versionsTitle.replace('{name}', skill.name) : copy.versionsTitleEmpty}
          </DialogTitle>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-[12px]">
          <div className="overflow-x-auto">
            <DataTable
              aria-label={copy.versionsTableAria}
              className="min-w-[820px]"
              columns={columns}
              data={rows}
              rowKey={(row) => row.id}
              loading={loading}
              emptyText={copy.versionsEmpty}
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function VersionDetailDialog({
  detail,
  locale,
  copy,
  onClose,
}: {
  detail: SkillVersionRead | null;
  locale: 'zh-CN' | 'en-US';
  copy: SkillsPageCopy;
  onClose: () => void;
}) {
  return (
    <Dialog open={Boolean(detail)} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        aria-describedby={undefined}
        className="flex max-h-[calc(100dvh-4rem)] w-[calc(100%-2rem)] flex-col gap-[16px] overflow-hidden rounded-[14px] px-[20px] py-[16px] sm:max-w-[900px]"
      >
        <div className="flex items-center gap-[6px] px-[12px] text-[#757f9c]">
          <IconSkill className="size-[14px] shrink-0" />
          <DialogTitle className="min-w-0 truncate text-[14px] font-normal leading-none text-[#757f9c]">
            {detail ? copy.detailTitle.replace('{name}', detail.name).replace('{version}', detail.version) : copy.detailTitleEmpty}
          </DialogTitle>
        </div>

        {detail && (
          <div className="flex min-h-0 flex-1 flex-col gap-[16px] overflow-y-auto px-[12px]">
            <div className="grid grid-cols-2 gap-[10px] max-[520px]:grid-cols-1">
              {/* <DetailField label="SOP ID">{detail.skill_id}</DetailField> */}
              <DetailField label={copy.detailVersion}>{detail.version}</DetailField>
              <DetailField label={copy.columnDomain}>{detail.business_domain || '-'}</DetailField>
              <DetailField label={copy.detailStatus}>{statusText(detail.status, copy)}</DetailField>
              <DetailField label={copy.columnCalls}>{callCountText(detail.call_count, locale, copy)}</DetailField>
              <DetailField label={copy.columnPositiveRate}>{percent(detail.positive_rate, locale)}</DetailField>
              <DetailField label={copy.columnNegativeRate}>{percent(detail.negative_rate, locale)}</DetailField>
              <DetailField label={copy.detailUpdatedAt}>{detail.updated_at.slice(0, 10)}</DetailField>
            </div>
            <pre className="overflow-x-auto rounded-[12px] bg-[#f6f6f6] p-[14px] text-[12px] leading-[1.7] text-[#464c5e] wrap-anywhere whitespace-pre-wrap">
              {skillSourceText(detail, copy)}
            </pre>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function rankByMetric(
  rows: SkillRead[],
  field: NumericSkillMetric,
  tieBreaker?: NumericSkillMetric,
  callTieBreaker: NumericSkillMetric = 'total_call_count',
): RankedSkill[] {
  return [...rows]
    .sort((a, b) => {
      const primary = (b[field] || 0) - (a[field] || 0);
      if (primary !== 0) return primary;
      if (tieBreaker) {
        const secondary = (b[tieBreaker] || 0) - (a[tieBreaker] || 0);
        if (secondary !== 0) return secondary;
      }
      return (b[callTieBreaker] || 0) - (a[callTieBreaker] || 0);
    })
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

/** 将比例格式化为当前 locale 的整数百分比。 */
function percent(value: number | undefined, locale: 'zh-CN' | 'en-US'): string {
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(value || 0);
}

/** 生成排行弹窗标题，避免 mode/scope 常量直接漏到 UI。 */
function rankingTitle(
  mode: RankingMode,
  scope: RankingScope,
  copy: SkillsPageCopy,
): string {
  if (mode === 'calls') return copy.rankingTitleCalls;
  if (mode === 'positive') return scope === 'current' ? copy.rankingTitlePositiveCurrent : copy.rankingTitlePositiveTotal;
  return scope === 'current' ? copy.rankingTitleNegativeCurrent : copy.rankingTitleNegativeTotal;
}

function rankingRowsFor(
  rows: {
    calls: RankedSkill[];
    positiveCurrent: RankedSkill[];
    positiveTotal: RankedSkill[];
    negativeCurrent: RankedSkill[];
    negativeTotal: RankedSkill[];
  },
  mode: RankingMode,
  scope: RankingScope,
): RankedSkill[] {
  if (mode === 'calls') return rows.calls;
  if (mode === 'positive') return scope === 'current' ? rows.positiveCurrent : rows.positiveTotal;
  return scope === 'current' ? rows.negativeCurrent : rows.negativeTotal;
}

/** 根据排行范围返回版本标签。 */
function rankingVersionText(
  row: SkillRead,
  scope: RankingScope,
  copy: SkillsPageCopy,
): string {
  return scope === 'current' ? `v${row.version}` : copy.detailSourceAllVersions;
}

/** 返回排行表格的指标列名。 */
function rankingMetricTitle(
  mode: RankingMode,
  scope: RankingScope,
  copy: SkillsPageCopy,
): string {
  if (mode === 'calls') return copy.rankingMetricCalls;
  if (mode === 'positive') return scope === 'current' ? copy.rankingMetricPositiveCurrent : copy.rankingMetricPositiveTotal;
  return scope === 'current' ? copy.rankingMetricNegativeCurrent : copy.rankingMetricNegativeTotal;
}

/** 返回排行表格的指标值。 */
function rankingMetricValue(
  row: SkillRead,
  mode: RankingMode,
  scope: RankingScope,
  locale: 'zh-CN' | 'en-US',
  copy: SkillsPageCopy,
): string {
  if (mode === 'calls') return callCountText(row.total_call_count, locale, copy);
  if (mode === 'positive') return percent(scope === 'current' ? row.positive_rate : row.total_positive_rate, locale);
  return percent(scope === 'current' ? row.negative_rate : row.total_negative_rate, locale);
}

function rankingCalls(row: SkillRead, scope: RankingScope): number {
  return scope === 'current' ? row.call_count || 0 : row.total_call_count || 0;
}

function rankingPositiveRate(row: SkillRead, scope: RankingScope): number {
  return scope === 'current' ? row.positive_rate || 0 : row.total_positive_rate || 0;
}

function rankingNegativeRate(row: SkillRead, scope: RankingScope): number {
  return scope === 'current' ? row.negative_rate || 0 : row.total_negative_rate || 0;
}

function rankingFeedbackText(row: SkillRead, scope: RankingScope): string {
  if (scope === 'current') {
    return `${row.positive_feedback_count || 0}/${row.negative_feedback_count || 0}`;
  }
  return `${row.total_positive_feedback_count || 0}/${row.total_negative_feedback_count || 0}`;
}

/** 在详情弹窗中重用状态文本映射。 */
function statusText(status: string, copy: SkillsPageCopy): string {
  return statusBadgeText(status as SkillRead['status'], copy);
}

function skillSourceText(row: SkillVersionRead, copy: SkillsPageCopy): string {
  const skill = row.content;
  const nodes = skillGraphSteps(skill, copy);
  return [
    `# ${skill.name}`,
    `- skill_id: ${skill.skill_id}`,
    `- version: ${skill.version}`,
    `- business_domain: ${skill.business_domain || '-'}`,
    `- description: ${skill.description || '-'}`,
    `- trigger_intents: ${formatList(skill.trigger_intents)}`,
    `- user_utterance_examples: ${formatList(skill.user_utterance_examples)}`,
    `- goal: ${formatList(skill.goal)}`,
    `- required_info: ${formatList(skill.required_info)}`,
    `- response_rules: ${formatList(skill.response_rules)}`,
    '',
    copy.detailNodesHeading,
    ...nodes.flatMap((step, index) => [
      '',
      copy.detailNodeTitle
        .replace('{index}', String(index + 1))
        .replace('{name}', String(step.name || step.node_id || '-')),
      `- node_id: ${String(step.node_id || '-')}`,
      `- node_type: ${String(step.type || 'collect_info')}`,
      `- condition: ${String(step.condition || '-')}`,
      `- instruction: ${String(step.instruction || '-')}`,
      `- expected_user_info: ${formatList(step.expected_user_info)}`,
      `- allowed_actions: ${formatList(step.allowed_actions)}`,
    ]),
  ].join('\n');
}

function skillGraphSteps(skill: SkillVersionRead['content'], copy: SkillsPageCopy): Array<Record<string, unknown>> {
  if (Array.isArray(skill.nodes) && skill.nodes.length > 0) {
    return skill.nodes.map((node, index) => ({
      node_id: node.node_id || `node_${index + 1}`,
      type: node.type || 'collect_info',
      condition: node.condition || '',
      name: node.name || node.node_id || copy.detailNodeFallback.replace('{index}', String(index + 1)),
      instruction: node.instruction || '',
      expected_user_info: Array.isArray(node.expected_user_info) ? node.expected_user_info : [],
      allowed_actions: Array.isArray(node.allowed_actions) ? node.allowed_actions : [],
    }));
  }
  return [];
}

function formatList(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return '-';
  return value.map(String).join(', ');
}
