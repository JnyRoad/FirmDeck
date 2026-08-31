import {
  AuditOutlined,
  CheckOutlined,
  CloseOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  FileAddOutlined,
  FileMarkdownOutlined,
  HistoryOutlined,
  InboxOutlined,
  MoreOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  RightOutlined,
  TeamOutlined,
} from '../icons';
import type { HTMLAttributes, ReactNode } from 'react';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError, TENANT_ID } from '../api/client';
import { isEnterpriseAdmin, type EnterpriseAuthUser } from '../auth';
import AppHeader from '@/components/AppHeader';
import CapabilityScopeLoading from '@/components/CapabilityScopeLoading';
import {
  CapabilityScopeBadge,
  CapabilityScopeControl,
  normalizeCapabilityScope,
} from '@/components/CapabilityScopeControl';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { DataTable, type DataTableColumn } from '@/components/DataTable';
import KnowledgeGraphCanvas from '@/components/KnowledgeGraphCanvas';
import { KnowledgeTypeBadge } from '@/components/knowledge/KnowledgeTypeBadge';
import { SharedKnowledgeConversionDialog } from '@/components/knowledge/SharedKnowledgeConversionDialog';
import { SharedKnowledgeVersionsDialog } from '@/components/knowledge/SharedKnowledgeVersionsDialog';
import { ModelConfigDropdown } from '@/components/ModelConfigDropdown';
import { Paginator } from '@/components/Paginator';
import { ResourceImportDialog } from '@/components/ResourceImportDialog';
import { StatCard } from '@/components/StatCard';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Dialog,
  DialogContent,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Progress,
  Select as UISelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@/components/ui';
import { Button as UIButton } from '@/components/ui/button';
import { notify } from '@/components/ui/app-toast';
import { RawContent, RawIdentifier } from '@/i18n/RawContent';
import { createMessageDescriptor } from '@/i18n/descriptors';
import {
  createAppTranslator,
  getStoredLocale,
  useAppIntl,
  type AppTranslator,
  type MessageId,
} from '@/i18n';
import type { AppLocale } from '@/i18n/locales';
import { createUiSinks } from '@/i18n/sinks';
import { apiErrorMessage } from '@/lib/apiErrorMessages';
import { cn } from '@/lib/utils';
import { DIALOG_CANCEL_BUTTON_CLASS, DIALOG_FOOTER_CLASS, DIALOG_PRIMARY_BUTTON_CLASS, MENU_CONTENT_CLASS, MENU_ITEM_CLASS, MENU_ITEM_DANGER_CLASS, MOBILE_CARD_CLASS, OUTLINE_ACTION_BUTTON_CLASS, OUTLINE_ACTION_BUTTON_SM_CLASS, SEARCH_COMBO_BUTTON_CLASS, SEARCH_COMBO_CLASS, SEARCH_COMBO_INPUT_CLASS, SELECT_TRIGGER_CLASS } from '@/lib/enterprise-ui';
import {
  clearSharedAgentScope,
  emitAgentScopeChange,
  isTeamScope,
  persistSharedAgentScope,
  readEmployeeScope,
} from '@/lib/agent-scope-storage';
import IconAdd from '../assets/icons/add.svg?react';
import IconChevronDown from '../assets/icons/chevron-down.svg?react';
import IconClear from '../assets/icons/field-clear.svg?react';
import IconFolder from '../assets/icons/cap-folder.svg?react';
import IconRefresh from '../assets/icons/refresh.svg?react';
import IconSearch from '../assets/icons/search.svg?react';
import {
  canManageEmployeeAgent,
  openGalleryAgentId,
  openGalleryImportSourceOptions,
  resourceCreatorName,
  visibleEmployeeAgents,
} from '../employee';
import { useClientPagination } from '../hooks/useClientPagination';
import { renderMarkdownBlocks } from './chat/chatHelpers';
import type {
  CapabilityScope,
  KnowledgeBaseRead,
  KnowledgeBucketRead,
  KnowledgeChunkRead,
  KnowledgeConceptRead,
  KnowledgeDiscoveryRead,
  KnowledgeDocumentRead,
  KnowledgeErrorDescriptor,
  KnowledgeStageDescriptor,
  KnowledgeIngestJobRead,
  KnowledgeSearchTrace,
  KnowledgeSearchResponse,
  AgentProfileRead,
  ModelConfigRead,
  KnowledgeBaseConversionRead,
  KnowledgeBaseVersionRead,
} from '../types';

const KNOWLEDGE_PAGE_SIZE = 10;
const KNOWLEDGE_SEARCH_MODEL_STORAGE_KEY = 'knowledge-search-model';
const TERMINAL_KNOWLEDGE_JOB_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);
const KnowledgeGraphVisualization = lazy(() => import('@/components/knowledge/KnowledgeGraphVisualization').then(
  (module) => ({ default: module.KnowledgeGraphVisualization }),
));

type IngestStepView = {
  key: string;
  label: string;
  progress: number;
  status: 'pending' | 'running' | 'done';
};

type OkfLintIssue = {
  issue_type?: string;
  title?: string;
  message?: string;
  concept_id?: string;
  concept_type?: string;
  document_id?: string;
};

/** 为知识域的非 Hook 辅助函数提供受控翻译入口；无上下文时回退当前持久化 locale。 */
function currentKnowledgeTranslator() {
  return createAppTranslator(getStoredLocale());
}

type KnowledgeTranslate = AppTranslator['t'];

const KNOWLEDGE_STAGE_MESSAGE_IDS: Record<string, MessageId> = {
  queued: 'knowledgePage.ingest.queued',
  parsing: 'knowledgePage.ingest.parsing',
  normalizing: 'knowledgePage.ingest.normalizing',
  documenting: 'knowledgePage.ingest.documenting',
  bucketing: 'knowledgePage.ingest.bucketing',
  bucket_writing: 'knowledgePage.ingest.bucketWriting',
  chunking: 'knowledgePage.ingest.chunking',
  summarizing: 'knowledgePage.ingest.summarizing',
  discovering: 'knowledgePage.ingest.discovering',
  done: 'knowledgePage.ingest.done',
  cancel_requested: 'knowledgePage.status.cancelRequested',
  cancelled: 'knowledgePage.status.cancelled',
  failed: 'knowledgePage.status.failed',
};

const KNOWLEDGE_ROUTE_MESSAGE_IDS: Record<string, MessageId> = {
  document_route: 'knowledgePage.route.documentRoute',
  document_route_lexical: 'knowledgePage.route.documentRouteLexical',
  document_route_lexical_fallback: 'knowledgePage.route.documentRouteLexical',
  okf_concept_route: 'knowledgePage.route.okfConceptRoute',
  okf_only: 'knowledgePage.route.okfOnly',
  bucket_route: 'knowledgePage.route.bucketRoute',
  bucket_route_lexical: 'knowledgePage.route.bucketRouteLexical',
  bucket_route_lexical_fallback: 'knowledgePage.route.bucketRouteLexical',
  section_expand: 'knowledgePage.route.sectionExpand',
  read_chunks: 'knowledgePage.route.readChunks',
  evidence_pack: 'knowledgePage.route.evidencePack',
  no_documents: 'knowledgePage.route.noDocuments',
  no_buckets: 'knowledgePage.route.noBuckets',
};

const KNOWLEDGE_TRACE_PHASE_ALIASES: Record<string, string> = {
  document_route_failed: 'document_route',
  document_route_invalid: 'document_route',
  document_route_no_match: 'document_route',
  bucket_selection_failed: 'bucket_route',
  bucket_route_invalid: 'bucket_route',
  bucket_route_no_match: 'bucket_route',
};

/** 将稳定入库阶段代码映射为当前 UI 语言的产品标签；未知代码安全回退。 */
export function knowledgeStageLabel(
  stage: string,
  translate: KnowledgeTranslate = currentKnowledgeTranslator().t,
): string {
  const messageId = KNOWLEDGE_STAGE_MESSAGE_IDS[stage];
  return messageId ? translate(messageId) : translate('knowledgePage.add.stageFallback');
}

/** 将稳定阶段详情描述映射为当前 UI 语言；未知详情不把后端原文带入页面。 */
export function knowledgeStageDetailLabel(
  detail: KnowledgeStageDescriptor | undefined,
  translate: KnowledgeTranslate = currentKnowledgeTranslator().t,
): string {
  if (!detail || typeof detail.code !== 'string') return '';
  return knowledgeStageLabel(detail.code, translate);
}

/** 将检索 trace 的稳定阶段或代码映射为当前 UI 语言；不展示后端 message 字段。 */
export function knowledgeRouteLabel(
  trace: KnowledgeSearchTrace,
  translate: KnowledgeTranslate = currentKnowledgeTranslator().t,
): string {
  const phase = KNOWLEDGE_TRACE_PHASE_ALIASES[trace.phase] || trace.phase;
  const codePhase = KNOWLEDGE_TRACE_PHASE_ALIASES[trace.code] || trace.code;
  const messageId = KNOWLEDGE_ROUTE_MESSAGE_IDS[phase] || KNOWLEDGE_ROUTE_MESSAGE_IDS[codePhase];
  return messageId ? translate(messageId) : translate('knowledgePage.route.default');
}

/** 将后端稳定错误描述交给统一 registry 映射，禁止使用持久化 detail 或异常文本。 */
export function knowledgeErrorLabel(
  error: KnowledgeErrorDescriptor | null | undefined,
  translate: KnowledgeTranslate = currentKnowledgeTranslator().t,
): string {
  return apiErrorMessage(error, 'common.error.generic', { t: translate });
}

/** 生成知识入库阶段的稳定本地化定义，避免把阶段名称硬编码到生产组件里。 */
function defaultIngestSteps(
  t: KnowledgeTranslate = currentKnowledgeTranslator().t,
): IngestStepView[] {
  return [
    { key: 'queued', label: t('knowledgePage.ingest.queued'), progress: 0, status: 'pending' },
    { key: 'parsing', label: t('knowledgePage.ingest.parsing'), progress: 0.08, status: 'pending' },
    { key: 'normalizing', label: t('knowledgePage.ingest.normalizing'), progress: 0.16, status: 'pending' },
    { key: 'documenting', label: t('knowledgePage.ingest.documenting'), progress: 0.24, status: 'pending' },
    { key: 'bucketing', label: t('knowledgePage.ingest.bucketing'), progress: 0.36, status: 'pending' },
    { key: 'bucket_writing', label: t('knowledgePage.ingest.bucketWriting'), progress: 0.48, status: 'pending' },
    { key: 'chunking', label: t('knowledgePage.ingest.chunking'), progress: 0.62, status: 'pending' },
    { key: 'summarizing', label: t('knowledgePage.ingest.summarizing'), progress: 0.74, status: 'pending' },
    { key: 'discovering', label: t('knowledgePage.ingest.discovering'), progress: 0.88, status: 'pending' },
    { key: 'done', label: t('knowledgePage.ingest.done'), progress: 1, status: 'pending' },
  ];
}

type KnowledgePageProps = {
  currentUser?: EnterpriseAuthUser;
  onLogout?: () => void;
};

function resolveKnowledgeAgentScope(
  rows: AgentProfileRead[],
  currentUser: EnterpriseAuthUser | undefined,
  currentAgentId: string,
): string {
  const currentAgent = rows.find((item) => item.id === currentAgentId);
  if (currentAgent) {
    if (!currentAgent.is_overall || isEnterpriseAdmin(currentUser)) return currentAgent.id;
  }
  if (isEnterpriseAdmin(currentUser)) return '';
  return visibleEmployeeAgents(rows, currentUser, { activeOnly: true })[0]?.id || '';
}

function effectiveKnowledgeAgentId(rows: AgentProfileRead[], agentId: string): string {
  const agent = rows.find((item) => item.id === agentId);
  return agent && !agent.is_overall ? agent.id : '';
}

export default function KnowledgeManagePage({ currentUser, onLogout }: KnowledgePageProps = {}) {
  const { locale, t } = useAppIntl();
  const uiSinks = useMemo(() => createUiSinks({ t }), [t]);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [documents, setDocuments] = useState<KnowledgeDocumentRead[]>([]);
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBaseRead[]>([]);
  const [selectedDocument, setSelectedDocument] = useState<KnowledgeDocumentRead | null>(null);
  const [buckets, setBuckets] = useState<KnowledgeBucketRead[]>([]);
  const [loading, setLoading] = useState(false);
  const [agentId, setAgentId] = useState(readEmployeeScope);
  const [agentScopeLoaded, setAgentScopeLoaded] = useState(false);
  const [agents, setAgents] = useState<AgentProfileRead[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [importMode, setImportMode] = useState<'plaza' | 'employee'>('plaza');
  const [importSourceAgentId, setImportSourceAgentId] = useState('');
  const [importSourceKnowledgeBases, setImportSourceKnowledgeBases] = useState<KnowledgeBaseRead[]>([]);
  const [importSelectedKnowledgeBaseIds, setImportSelectedKnowledgeBaseIds] = useState<string[]>([]);
  const [importLoading, setImportLoading] = useState(false);
  const [editingKnowledgeBase, setEditingKnowledgeBase] = useState<KnowledgeBaseRead | null>(null);
  const [deleteKbTarget, setDeleteKbTarget] = useState<KnowledgeBaseRead | null>(null);
  const [knowledgeBaseDraft, setKnowledgeBaseDraft] = useState({
    name: '',
    description: '',
    status: 'active',
    capability_scope: 'general' as CapabilityScope,
  });
  const [versionKnowledgeBase, setVersionKnowledgeBase] = useState<KnowledgeBaseRead | null>(null);
  const [knowledgeBaseVersions, setKnowledgeBaseVersions] = useState<KnowledgeBaseVersionRead[]>([]);
  const [versionTeamOptions, setVersionTeamOptions] = useState<Array<{ id: string; name: string }>>([]);
  const [conversionKnowledgeBase, setConversionKnowledgeBase] = useState<KnowledgeBaseRead | null>(null);
  const [editingDocument, setEditingDocument] = useState<KnowledgeDocumentRead | null>(null);
  const [documentDraft, setDocumentDraft] = useState({ title: '', status: 'ready', content_md: '' });
  const [documentEditorMode, setDocumentEditorMode] = useState<'edit' | 'preview'>('edit');
  const [editingBucket, setEditingBucket] = useState<KnowledgeBucketRead | null>(null);
  const [bucketDraft, setBucketDraft] = useState({ title: '', summary: '' });
  const [bucketChunks, setBucketChunks] = useState<KnowledgeChunkRead[]>([]);
  const [chunkDrafts, setChunkDrafts] = useState<Record<string, { content: string; summary: string }>>({});
  const [contentSaving, setContentSaving] = useState(false);
  const [documentSearch, setDocumentSearch] = useState('');
  const [knowledgeBaseFilter, setKnowledgeBaseFilter] = useState('__all__');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchResult, setSearchResult] = useState<KnowledgeSearchResponse | null>(null);
  const [modelConfigs, setModelConfigs] = useState<ModelConfigRead[]>([]);
  const [selectedSearchModelId, setSelectedSearchModelId] = useState(
    () => window.localStorage.getItem(`${KNOWLEDGE_SEARCH_MODEL_STORAGE_KEY}:${TENANT_ID}`) || '',
  );
  const [okfConcepts, setOkfConcepts] = useState<KnowledgeConceptRead[]>([]);
  const [okfLoading, setOkfLoading] = useState(false);
  const [okfImportOpen, setOkfImportOpen] = useState(false);
  const [okfImporting, setOkfImporting] = useState(false);
  const [okfLintIssues, setOkfLintIssues] = useState<OkfLintIssue[]>([]);
  const [okfLintReportOpen, setOkfLintReportOpen] = useState(false);
  const [okfLintKnowledgeBase, setOkfLintKnowledgeBase] = useState<KnowledgeBaseRead | null>(null);
  const [viewingConcept, setViewingConcept] = useState<KnowledgeConceptRead | null>(null);
  const [editingConcept, setEditingConcept] = useState<KnowledgeConceptRead | null>(null);
  const [conceptDraft, setConceptDraft] = useState('');
  const conceptEditorType = editingConcept
    ? okfFrontmatterValue(conceptDraft, 'type', editingConcept.concept_type || 'Topic')
    : 'Topic';
  const conceptEditorTitle = editingConcept
    ? okfFrontmatterValue(conceptDraft, 'title', editingConcept.title || editingConcept.concept_id)
    : '';
  const conceptEditorDescription = editingConcept
    ? okfFrontmatterValue(conceptDraft, 'description', editingConcept.description || '')
    : '';

  const currentAgent = useMemo(() => agents.find((item) => item.id === agentId), [agents, agentId]);
  const isOverallAgent = !currentAgent || currentAgent.is_overall;
  const canManageCurrentScope = currentAgent
    ? canManageEmployeeAgent(currentAgent, currentUser)
    : isEnterpriseAdmin(currentUser);
  const effectiveAgentId = currentAgent && !currentAgent.is_overall ? agentId : '';
  const visibleKnowledgeBases = useMemo(
    () => knowledgeBases.filter((item) => !isEmptyDefaultKnowledgeBase(item)),
    [knowledgeBases],
  );
  const selectedKnowledgeBase = useMemo(() => {
    if (selectedDocument) {
      return visibleKnowledgeBases.find((item) => item.id === selectedDocument.knowledge_base_id) || null;
    }
    if (knowledgeBaseFilter !== '__all__') {
      return visibleKnowledgeBases.find((item) => item.id === knowledgeBaseFilter) || null;
    }
    return visibleKnowledgeBases[0] || null;
  }, [knowledgeBaseFilter, selectedDocument, visibleKnowledgeBases]);
  const filteredKnowledgeBases = useMemo(() => {
    const query = documentSearch.trim().toLowerCase();
    if (!query) return visibleKnowledgeBases;
    return visibleKnowledgeBases.filter((item) => {
      const searchable = [
        item.name,
        item.description,
        item.status,
        item.version,
        resourceCreatorName(item),
        item.branch_sync_state,
        item.document_count,
        item.bucket_count,
        item.chunk_count,
      ]
        .filter((value) => value !== undefined && value !== null)
        .join(' ')
        .toLowerCase();
      return searchable.includes(query);
    });
  }, [documentSearch, visibleKnowledgeBases]);

  const pageTitle = t('knowledgePage.title');
  const pageDescription = isOverallAgent
    ? t('knowledgePage.description.marketplace')
    : t('knowledgePage.description.employee');
  const listLabel = t('knowledgePage.list.label');
  const listEmptyText = t('knowledgePage.empty.employee');
  const knowledgeErrorMessage = (error: unknown, fallbackId: Parameters<typeof t>[0]) => (
    apiErrorMessage(error, fallbackId, { t })
  );

  const stats = useMemo(() => ({
    total: visibleKnowledgeBases.length,
    active: visibleKnowledgeBases.filter((item) => item.status === 'active' || item.status === 'published').length,
    archived: visibleKnowledgeBases.filter((item) => item.status === 'archived').length,
    documents: visibleKnowledgeBases.reduce((sum, item) => sum + (item.document_count || 0), 0),
  }), [visibleKnowledgeBases]);

  const pagination = useClientPagination(filteredKnowledgeBases, KNOWLEDGE_PAGE_SIZE, documentSearch);

  useEffect(() => {
    void loadAgentScope();
  }, [currentUser?.id]);

  useEffect(() => {
    if (!agentScopeLoaded) return;
    const resolvedAgentId = resolveKnowledgeAgentScope(agents, currentUser, agentId);
    if (resolvedAgentId !== agentId) {
      clearKnowledgeViewState();
      applyResolvedAgentScope(resolvedAgentId);
      return;
    }
    if (!isEnterpriseAdmin(currentUser) && !resolvedAgentId) {
      clearKnowledgeViewState();
      return;
    }
    void refresh(effectiveKnowledgeAgentId(agents, resolvedAgentId));
  }, [agentScopeLoaded, agentId, agents, currentUser?.id]);

  useEffect(() => {
    api
      .get<ModelConfigRead[]>(`/api/enterprise/model-configs?tenant_id=${TENANT_ID}`)
      .then((items) => {
        const enabled = items.filter((item) => item.enabled);
        setModelConfigs(enabled);
        setSelectedSearchModelId((current) => {
          if (current && enabled.some((item) => item.id === current)) return current;
          const fallback = enabled.find((item) => item.is_default)?.id || enabled[0]?.id || '';
          if (fallback) {
            window.localStorage.setItem(`${KNOWLEDGE_SEARCH_MODEL_STORAGE_KEY}:${TENANT_ID}`, fallback);
          }
          return fallback;
        });
      })
      .catch(() => setModelConfigs([]));
  }, []);

  useEffect(() => {
    if (searchParams.get('add') !== 'plaza') return;
    if (agents.length === 0) return;
    const resourceId = searchParams.get('resourceId') || undefined;
    if (isOverallAgent) {
      notify.warning(t('knowledgePage.toast.selectEmployeeBeforeMarketplaceCopy'));
    } else {
      void openImportKnowledgeBases('plaza', resourceId);
    }
    const next = new URLSearchParams(searchParams);
    next.delete('add');
    next.delete('resourceId');
    setSearchParams(next, { replace: true });
  }, [agents.length, isOverallAgent, searchParams, setSearchParams]);

  useEffect(() => {
    if (knowledgeBaseFilter !== '__all__' && !visibleKnowledgeBases.some((item) => item.id === knowledgeBaseFilter)) {
      setKnowledgeBaseFilter('__all__');
    }
  }, [visibleKnowledgeBases, knowledgeBaseFilter]);

  useEffect(() => {
    const onScopeChange = (event: Event) => {
      const next = (event as CustomEvent<{ agentId?: string }>).detail?.agentId || '';
      setAgentId(next && !isTeamScope(next) ? next : readEmployeeScope());
    };
    window.addEventListener('ultrarag-enterprise-agent-scope-change', onScopeChange);
    return () => window.removeEventListener('ultrarag-enterprise-agent-scope-change', onScopeChange);
  }, []);

  function applyResolvedAgentScope(nextAgentId: string) {
    if (nextAgentId === agentId) return;
    if (nextAgentId) {
      persistSharedAgentScope(nextAgentId, currentUser?.id);
    } else {
      clearSharedAgentScope(currentUser?.id);
    }
    setAgentId(nextAgentId);
    emitAgentScopeChange(nextAgentId);
  }

  function clearKnowledgeViewState() {
    setDocuments([]);
    setKnowledgeBases([]);
    setSelectedDocument(null);
    setBuckets([]);
    setOkfConcepts([]);
    setOkfLintIssues([]);
    setSearchResult(null);
  }

  async function loadAgentScope() {
    setAgentScopeLoaded(false);
    try {
      const agentRows = await api.get<AgentProfileRead[]>(`/api/enterprise/agents?tenant_id=${TENANT_ID}`);
      setAgents(agentRows);
      const resolvedAgentId = resolveKnowledgeAgentScope(agentRows, currentUser, agentId);
      if (resolvedAgentId !== agentId) {
        clearKnowledgeViewState();
        applyResolvedAgentScope(resolvedAgentId);
      }
      setAgentScopeLoaded(true);
    } catch (error) {
      clearKnowledgeViewState();
      notify.error(knowledgeErrorMessage(error, 'knowledgePage.error.loadAgents'));
      setAgentScopeLoaded(true);
    }
  }

  async function refresh(
    scopedAgentId = effectiveAgentId,
    preferredDocument: KnowledgeDocumentRead | null = selectedDocument,
  ) {
    if (!agentScopeLoaded) return;
    if (!isEnterpriseAdmin(currentUser) && !scopedAgentId) {
      clearKnowledgeViewState();
      return;
    }
    setLoading(true);
    try {
      const suffix = scopedAgentId ? `&agent_id=${encodeURIComponent(scopedAgentId)}` : '';
      const [docRows, kbRows] = await Promise.all([
        api.get<KnowledgeDocumentRead[]>(`/api/enterprise/knowledge/documents?tenant_id=${TENANT_ID}${suffix}`),
        api.get<KnowledgeBaseRead[]>(`/api/enterprise/knowledge-bases?tenant_id=${TENANT_ID}${suffix}`),
      ]);
      setDocuments(docRows);
      setKnowledgeBases(kbRows);
      const scopedDocRows =
        knowledgeBaseFilter === '__all__'
          ? docRows
          : docRows.filter((item) => item.knowledge_base_id === knowledgeBaseFilter);
      const current = preferredDocument
        ? scopedDocRows.find((item) => item.id === preferredDocument.id)
          || scopedDocRows.find((item) => (
            item.knowledge_base_id === preferredDocument.knowledge_base_id
            && item.filename === preferredDocument.filename
          ))
          || scopedDocRows[0]
          || null
        : scopedDocRows[0] || null;
      setSelectedDocument(current);
      if (current) {
        await loadBuckets(current, false);
      } else {
        setBuckets([]);
        const visibleKbRows = kbRows.filter((item) => !isEmptyDefaultKnowledgeBase(item));
        const fallbackKnowledgeBaseId =
          knowledgeBaseFilter !== '__all__' ? knowledgeBaseFilter : visibleKbRows[0]?.id || '';
        await loadOkfConcepts(fallbackKnowledgeBaseId, false);
      }
    } catch (error) {
      notify.error(knowledgeErrorMessage(error, 'knowledgePage.error.refresh'));
    } finally {
      setLoading(false);
    }
  }

  async function loadBuckets(document: KnowledgeDocumentRead, select = true) {
    if (select) setSelectedDocument(document);
    setBuckets([]);
    setSearchResult(null);
    try {
      const [rows] = await Promise.all([
        api.get<KnowledgeBucketRead[]>(
          `/api/enterprise/knowledge/documents/${document.id}/buckets?tenant_id=${TENANT_ID}${effectiveAgentId ? `&agent_id=${encodeURIComponent(effectiveAgentId)}` : ''}`,
        ),
        loadOkfConcepts(document.knowledge_base_id, false),
      ]);
      setBuckets(rows);
    } catch (error) {
      setBuckets([]);
      notify.error(knowledgeErrorMessage(error, 'knowledgePage.error.loadBuckets'));
    }
  }

  async function loadOkfConcepts(knowledgeBaseId?: string, showLoading = true) {
    if (!knowledgeBaseId) {
      setOkfConcepts([]);
      setOkfLintIssues([]);
      return;
    }
    if (showLoading) setOkfLoading(true);
    const suffix = effectiveAgentId ? `&agent_id=${encodeURIComponent(effectiveAgentId)}` : '';
    try {
      const rows = await api.get<KnowledgeConceptRead[]>(
        `/api/enterprise/knowledge-bases/${knowledgeBaseId}/okf/concepts?tenant_id=${TENANT_ID}${suffix}`,
      );
      setOkfConcepts(rows);
      setOkfLintIssues([]);
    } catch (error) {
      setOkfConcepts([]);
      if (error instanceof ApiError && error.status === 404) {
        setOkfLintIssues([]);
        return;
      }
      notify.error(knowledgeErrorMessage(error, 'knowledgePage.error.loadGraph'));
    } finally {
      if (showLoading) setOkfLoading(false);
    }
  }

  function selectKnowledgeBase(knowledgeBaseId: string) {
    setKnowledgeBaseFilter(knowledgeBaseId);
    const nextDocument =
      knowledgeBaseId === '__all__'
        ? documents[0] || null
        : documents.find((item) => item.knowledge_base_id === knowledgeBaseId) || null;
    if (nextDocument) {
      void loadBuckets(nextDocument);
      return;
    }
    setSelectedDocument(null);
    setBuckets([]);
    setSearchResult(null);
    void loadOkfConcepts(knowledgeBaseId === '__all__' ? undefined : knowledgeBaseId);
  }

  async function runKnowledgeSearch() {
    const query = searchQuery.trim();
    if (!query) {
      notify.warning(t('knowledgePage.toast.enterSearchQuery'));
      return;
    }
    setSearchLoading(true);
    try {
      const response = await api.post<KnowledgeSearchResponse>('/api/enterprise/knowledge/search', {
        tenant_id: TENANT_ID,
        agent_id: effectiveAgentId || undefined,
        knowledge_base_ids:
          knowledgeBaseFilter !== '__all__'
            ? [knowledgeBaseFilter]
            : selectedDocument?.knowledge_base_id
              ? [selectedDocument.knowledge_base_id]
              : undefined,
        query,
        model_config_id: selectedSearchModelId || undefined,
        mode: 'debug',
        max_depth: 3,
        need_evidence_pack: true,
      });
      setSearchResult(response);
    } catch (error) {
      notify.error(knowledgeErrorMessage(error, 'knowledgePage.error.search'));
    } finally {
      setSearchLoading(false);
    }
  }

  async function openImportKnowledgeBases(mode: 'plaza' | 'employee' = 'plaza', selectedResourceId?: string) {
    try {
      const agentRows = agents.length ? agents : await api.get<AgentProfileRead[]>(`/api/enterprise/agents?tenant_id=${TENANT_ID}`);
      setAgents(agentRows);
      setImportMode(mode);
      const firstSource = mode === 'plaza'
        ? openGalleryAgentId(agentRows)
        : visibleEmployeeAgents(agentRows, currentUser, { activeOnly: true, excludeAgentId: agentId })[0]?.id || '';
      setImportSourceAgentId(firstSource);
      setImportSelectedKnowledgeBaseIds([]);
      setImportOpen(true);
      if (firstSource) {
        const sourceRows = await loadImportSourceKnowledgeBases(firstSource);
        if (selectedResourceId && sourceRows.some((item) => item.id === selectedResourceId)) {
          setImportSelectedKnowledgeBaseIds([selectedResourceId]);
        }
      } else {
        setImportSourceKnowledgeBases([]);
      }
    } catch (error) {
      notify.error(knowledgeErrorMessage(error, 'knowledgePage.error.loadAgents'));
    }
  }

  async function loadImportSourceKnowledgeBases(sourceAgentId: string): Promise<KnowledgeBaseRead[]> {
    setImportSourceKnowledgeBases([]);
    setImportSelectedKnowledgeBaseIds([]);
    if (!sourceAgentId) return [];
    try {
      const rows = await api.get<KnowledgeBaseRead[]>(
        `/api/enterprise/knowledge-bases?tenant_id=${TENANT_ID}&agent_id=${encodeURIComponent(sourceAgentId)}`,
      );
      const activeRows = rows.filter((item) => item.status === 'active');
      setImportSourceKnowledgeBases(activeRows);
      return activeRows;
    } catch (error) {
      notify.error(knowledgeErrorMessage(error, 'knowledgePage.error.loadSourceKnowledgeBases'));
      return [];
    }
  }

  async function submitImportKnowledgeBases() {
    if (!agentId) {
      notify.warning(t('knowledgePage.toast.selectEmployee'));
      return;
    }
    if (!importSourceAgentId) {
      notify.warning(importMode === 'plaza'
        ? t('knowledgePage.toast.selectMarketplace')
        : t('knowledgePage.toast.selectSourceEmployee'));
      return;
    }
    if (importSelectedKnowledgeBaseIds.length === 0) {
      notify.warning(t('knowledgePage.toast.selectKnowledgeBasesToCopy'));
      return;
    }
    setImportLoading(true);
    try {
      const result = await api.post<{ imported: Array<Record<string, unknown>>; missing: Array<Record<string, unknown>> }>(
        `/api/enterprise/agents/${agentId}/resources/import`,
        {
          tenant_id: TENANT_ID,
          source_agent_id: importSourceAgentId,
          resource_type: 'knowledge_base',
          resource_ids: importSelectedKnowledgeBaseIds,
        },
      );
      const importedCount = result.imported?.length || 0;
      const missingCount = result.missing?.length || 0;
      notify.success(t('knowledgePage.toast.importedKnowledgeBases', { importedCount, missingCount }));
      setImportOpen(false);
      await refresh();
    } catch (error) {
      notify.error(knowledgeErrorMessage(error, 'knowledgePage.error.importKnowledgeBases'));
    } finally {
      setImportLoading(false);
    }
  }

  function handleCreateAction(key: string) {
    if (key === 'blank') {
      navigate('/enterprise/knowledge/new');
      return;
    }
    if (key === 'okf') {
      setOkfImportOpen(true);
      return;
    }
    if (key === 'plaza') {
      void openImportKnowledgeBases('plaza');
      return;
    }
    if (key === 'employee') {
      void openImportKnowledgeBases('employee');
    }
  }

  async function importOkfFile(file: File) {
    setOkfImporting(true);
    try {
      const contentBase64 = await fileToBase64(file);
      await api.post('/api/enterprise/knowledge/okf/import', {
        tenant_id: TENANT_ID,
        agent_id: effectiveAgentId || undefined,
        knowledge_base_id: selectedKnowledgeBase?.id,
        filename: file.name,
        content_base64: contentBase64,
      });
      notify.success(t('knowledgePage.toast.importedBackup'));
      setOkfImportOpen(false);
      await refresh();
    } catch (error) {
      notify.error(knowledgeErrorMessage(error, 'knowledgePage.error.importBackup'));
    } finally {
      setOkfImporting(false);
    }
  }

  async function exportOkfBundle(targetKnowledgeBase = selectedKnowledgeBase) {
    if (!targetKnowledgeBase) {
      notify.warning(t('knowledgePage.toast.selectKnowledgeBase'));
      return;
    }
    const suffix = effectiveAgentId ? `&agent_id=${encodeURIComponent(effectiveAgentId)}` : '';
    try {
      const blob = await api.blob(
        `/api/enterprise/knowledge-bases/${targetKnowledgeBase.id}/okf/export?tenant_id=${TENANT_ID}${suffix}`,
      );
      uiSinks.download(
        blob,
        createMessageDescriptor('knowledgePage.download.backupPrefix'),
        targetKnowledgeBase.name || targetKnowledgeBase.id,
        'okf.zip',
      );
      notify.success(t('knowledgePage.toast.exportedBackup'));
    } catch (error) {
      notify.error(knowledgeErrorMessage(error, 'knowledgePage.error.exportBackup'));
    }
  }

  async function lintOkfBundle(targetKnowledgeBase = selectedKnowledgeBase) {
    if (!targetKnowledgeBase) {
      notify.warning(t('knowledgePage.toast.selectKnowledgeBase'));
      return;
    }
    if (targetKnowledgeBase.id !== selectedKnowledgeBase?.id) {
      selectKnowledgeBase(targetKnowledgeBase.id);
    }
    const suffix = effectiveAgentId ? `&agent_id=${encodeURIComponent(effectiveAgentId)}` : '';
    setOkfLoading(true);
    try {
      const result = await api.post<{ status: string; issue_count: number; issues: OkfLintIssue[] }>(
        `/api/enterprise/knowledge-bases/${targetKnowledgeBase.id}/okf/lint?tenant_id=${TENANT_ID}${suffix}`,
      );
      setOkfLintIssues(result.issues || []);
      setOkfLintKnowledgeBase(targetKnowledgeBase);
      setOkfLintReportOpen(true);
      notify.success(result.issue_count
        ? t('knowledgePage.toast.graphLintIssues', { count: result.issue_count })
        : t('knowledgePage.toast.graphLintPassed'));
    } catch (error) {
      notify.error(knowledgeErrorMessage(error, 'knowledgePage.error.lintGraph'));
    } finally {
      setOkfLoading(false);
    }
  }

  function openConceptEditor(row: KnowledgeConceptRead) {
    setEditingConcept(row);
    setConceptDraft(row.content_md || '');
  }

  function openConceptViewer(row: KnowledgeConceptRead) {
    setViewingConcept(row);
  }

  function editViewingConcept() {
    if (!viewingConcept) return;
    const concept = viewingConcept;
    setViewingConcept(null);
    openConceptEditor(concept);
  }

  async function saveConcept() {
    if (!editingConcept || !selectedKnowledgeBase) return;
    const suffix = effectiveAgentId ? `?agent_id=${encodeURIComponent(effectiveAgentId)}` : '';
    try {
      const next = await api.put<KnowledgeConceptRead>(
        `/api/enterprise/knowledge-bases/${selectedKnowledgeBase.id}/okf/concepts/${conceptPath(editingConcept.concept_id)}${suffix}`,
        {
          tenant_id: TENANT_ID,
          document_id: editingConcept.document_id,
          content_md: conceptDraft,
          status: editingConcept.status,
        },
      );
      setOkfConcepts((current) => current.map((item) => (item.id === next.id ? next : item)));
      setEditingConcept(null);
      notify.success(t('knowledgePage.toast.savedGraph'));
      await loadOkfConcepts(selectedKnowledgeBase.id, false);
    } catch (error) {
      notify.error(knowledgeErrorMessage(error, 'knowledgePage.error.saveGraph'));
    }
  }

  function openEditKnowledgeBase(row: KnowledgeBaseRead) {
    setEditingKnowledgeBase(row);
    setKnowledgeBaseDraft({
      name: row.name,
      description: row.description || '',
      status: row.status === 'archived' ? 'archived' : 'active',
      capability_scope: normalizeCapabilityScope(row.capability_scope),
    });
  }

  async function saveKnowledgeBase() {
    if (!editingKnowledgeBase) return;
    const suffix = effectiveAgentId ? `?agent_id=${encodeURIComponent(effectiveAgentId)}` : '';
    try {
      const next = await api.put<KnowledgeBaseRead>(`/api/enterprise/knowledge-bases/${editingKnowledgeBase.id}${suffix}`, {
        tenant_id: TENANT_ID,
        name: knowledgeBaseDraft.name,
        description: knowledgeBaseDraft.description,
        status: knowledgeBaseDraft.status,
        capability_scope: knowledgeBaseDraft.capability_scope,
      });
      setKnowledgeBases((current) => current.map((item) => (item.id === next.id ? next : item)));
      setEditingKnowledgeBase(null);
      notify.success(t('knowledgePage.toast.savedKnowledgeBase'));
      await refresh();
    } catch (error) {
      notify.error(knowledgeErrorMessage(error, 'knowledgePage.error.saveKnowledgeBase'));
    }
  }

  async function setKnowledgeBaseStatus(row: KnowledgeBaseRead, active: boolean) {
    const suffix = effectiveAgentId ? `?agent_id=${encodeURIComponent(effectiveAgentId)}` : '';
    try {
      const next = await api.put<KnowledgeBaseRead>(`/api/enterprise/knowledge-bases/${row.id}${suffix}`, {
        tenant_id: TENANT_ID,
        status: active ? 'active' : 'archived',
      });
      setKnowledgeBases((current) => current.map((item) => (item.id === next.id ? next : item)));
      notify.success(active ? t('knowledgePage.toast.publishedKnowledgeBase') : t('knowledgePage.toast.archivedKnowledgeBase'));
      await refresh();
    } catch (error) {
      notify.error(knowledgeErrorMessage(error, active ? 'knowledgePage.error.publishKnowledgeBase' : 'knowledgePage.error.archiveKnowledgeBase'));
    }
  }

  function deleteKnowledgeBase(row: KnowledgeBaseRead) {
    setDeleteKbTarget(row);
  }

  async function runDeleteKnowledgeBase() {
    const row = deleteKbTarget;
    if (!row) return;
    const branchMode = !isOverallAgent;
    const suffix = effectiveAgentId ? `&agent_id=${encodeURIComponent(effectiveAgentId)}` : '';
    try {
      await api.delete(`/api/enterprise/knowledge-bases/${row.id}?tenant_id=${TENANT_ID}${suffix}`);
      notify.success(branchMode ? t('knowledgePage.toast.removedKnowledgeBase') : t('knowledgePage.toast.deletedKnowledgeBase'));
      setDeleteKbTarget(null);
      await refresh();
    } catch (error) {
      notify.error(knowledgeErrorMessage(error, 'knowledgePage.error.deleteKnowledgeBase'));
    }
  }

  async function loadSharedVersionTeams(row: KnowledgeBaseRead) {
    /** 找出当前账号可管理且已绑定此共享库的团队，供生命周期动作选择。 */
    return api.get<Array<{ id: string; name: string }>>(
      `/api/enterprise/knowledge-bases/${row.id}/teams?tenant_id=${TENANT_ID}`,
    );
  }

  async function openKnowledgeBaseVersions(row: KnowledgeBaseRead) {
    /** 共享库进入全局生命周期面板，专用库继续使用员工分支版本表。 */
    if (row.mode === 'shared') {
      try {
        const teamOptions = await loadSharedVersionTeams(row);
        setVersionTeamOptions(teamOptions);
        setVersionKnowledgeBase(row);
      } catch (error) {
        notify.error(knowledgeErrorMessage(error, 'knowledgePage.error.loadVersionTeams'));
      }
      return;
    }
    const suffix = effectiveAgentId ? `&agent_id=${encodeURIComponent(effectiveAgentId)}` : '';
    try {
      const versions = await api.get<KnowledgeBaseVersionRead[]>(
        `/api/enterprise/knowledge-bases/${row.id}/versions?tenant_id=${TENANT_ID}${suffix}`,
      );
      setVersionTeamOptions([]);
      setVersionKnowledgeBase(row);
      setKnowledgeBaseVersions(versions);
    } catch (error) {
      notify.error(knowledgeErrorMessage(error, 'knowledgePage.error.loadVersions'));
    }
  }

  async function syncKnowledgeBaseFromOverall(row: KnowledgeBaseRead) {
    if (!agentId) {
      notify.warning(t('knowledgePage.toast.selectEmployeeShort'));
      return;
    }
    try {
      await api.post(`/api/enterprise/knowledge-bases/${row.id}/sync-from-overall?tenant_id=${TENANT_ID}&agent_id=${encodeURIComponent(agentId)}`);
      notify.success(t('knowledgePage.toast.syncedFromMarketplace'));
      await refresh();
    } catch (error) {
      notify.error(knowledgeErrorMessage(error, 'knowledgePage.error.syncFromMarketplace'));
    }
  }

  async function promoteKnowledgeBaseToOverall(row: KnowledgeBaseRead) {
    if (!agentId) {
      notify.warning(t('knowledgePage.toast.selectEmployeeShort'));
      return;
    }
    try {
      await api.post(`/api/enterprise/knowledge-bases/${row.id}/promote-to-overall?tenant_id=${TENANT_ID}&agent_id=${encodeURIComponent(agentId)}`);
      notify.success(t('knowledgePage.toast.publishedToMarketplace'));
      await refresh();
    } catch (error) {
      notify.error(knowledgeErrorMessage(error, 'knowledgePage.error.publishToMarketplace'));
    }
  }

  async function rollbackKnowledgeBaseVersion(version: KnowledgeBaseVersionRead) {
    if (!versionKnowledgeBase || !effectiveAgentId) return;
    try {
      await api.post(`/api/enterprise/knowledge-bases/${versionKnowledgeBase.id}/rollback`, {
        tenant_id: TENANT_ID,
        agent_id: effectiveAgentId,
        version: version.version,
      });
      notify.success(t('knowledgePage.toast.rolledBackVersion', { version: version.version }));
      await openKnowledgeBaseVersions(versionKnowledgeBase);
      await refresh();
    } catch (error) {
      notify.error(knowledgeErrorMessage(error, 'knowledgePage.error.rollbackVersion'));
    }
  }

  function openSharedKnowledgeConversion(row: KnowledgeBaseRead) {
    /** 只为当前可管理员工的活动专用实例打开转换向导。 */
    if (!effectiveAgentId || row.mode === 'shared' || row.status === 'archived') return;
    setConversionKnowledgeBase(row);
  }

  async function handleKnowledgeConversion(result: KnowledgeBaseConversionRead) {
    /** 用转换响应原子替换页面中的来源实例，并把视图定位到新共享库。 */
    // 先更新列表，避免员工私聊作用域的下一次读取把已归档来源继续显示为活动项。
    setKnowledgeBases((current) => [
      result.new_knowledge_base,
      ...current.filter((row) => (
        row.id !== result.source_knowledge_base_id
        && row.id !== result.new_knowledge_base.id
      )),
    ]);
    setDocuments((current) => current.filter(
      (document) => document.knowledge_base_id !== result.source_knowledge_base_id,
    ));

    // 再清理来源内容选中态并定位新共享库，确保成功后不会继续编辑已归档分支。
    setSelectedDocument(null);
    setBuckets([]);
    setSearchResult(null);
    setOkfConcepts([]);
    setKnowledgeBaseFilter(result.new_knowledge_base.id);
    setConversionKnowledgeBase(null);
    await loadOkfConcepts(result.new_knowledge_base.id, false);
  }

  function openEditDocument(row: KnowledgeDocumentRead) {
    const metadata = row.metadata || {};
    const documentCard = isRecord(metadata.document_card) ? metadata.document_card : {};
    const fallback = String(documentCard.summary || row.title || row.filename);
    setEditingDocument(row);
    setDocumentDraft({
      title: row.title || row.filename,
      status: row.status,
      content_md: documentSourceMarkdown(row, fallback),
    });
    setDocumentEditorMode('edit');
  }

  async function saveDocument() {
    if (!editingDocument) return;
    if (!documentDraft.content_md.trim()) {
      notify.warning(t('knowledgePage.toast.documentContentRequired'));
      return;
    }
    setContentSaving(true);
    try {
      const query = effectiveAgentId ? `?agent_id=${encodeURIComponent(effectiveAgentId)}` : '';
      const next = await api.put<KnowledgeDocumentRead>(
        `/api/enterprise/knowledge/documents/${editingDocument.id}${query}`,
        {
          tenant_id: TENANT_ID,
          title: documentDraft.title,
          status: documentDraft.status,
          content_md: documentDraft.content_md,
          expected_updated_at: editingDocument.updated_at,
        },
      );
      setEditingDocument(null);
      await refresh(effectiveAgentId, next);
      notify.success(t('knowledgePage.toast.savedDocument'));
    } catch (error) {
      notify.error(knowledgeErrorMessage(error, 'knowledgePage.error.saveDocument'));
    } finally {
      setContentSaving(false);
    }
  }

  async function openBucketEditor(row: KnowledgeBucketRead) {
    setEditingBucket(row);
    setBucketDraft({ title: row.title, summary: row.summary });
    try {
      const chunks = await api.get<KnowledgeChunkRead[]>(
        `/api/enterprise/knowledge/buckets/${row.id}/chunks?tenant_id=${TENANT_ID}${effectiveAgentId ? `&agent_id=${encodeURIComponent(effectiveAgentId)}` : ''}`,
      );
      setBucketChunks(chunks);
      setChunkDrafts(
        Object.fromEntries(chunks.map((chunk) => [chunk.id, { content: chunk.content, summary: chunk.summary || '' }])),
      );
    } catch (error) {
      notify.error(knowledgeErrorMessage(error, 'knowledgePage.error.loadCitations'));
    }
  }

  async function saveBucketAndChunks() {
    if (!editingBucket) return;
    setContentSaving(true);
    try {
      await api.put<KnowledgeBucketRead>(`/api/enterprise/knowledge/buckets/${editingBucket.id}`, {
        tenant_id: TENANT_ID,
        title: bucketDraft.title,
        summary: bucketDraft.summary,
      });
      for (const chunk of bucketChunks) {
        await api.put<KnowledgeChunkRead>(`/api/enterprise/knowledge/chunks/${chunk.id}`, {
          tenant_id: TENANT_ID,
          content: chunkDrafts[chunk.id]?.content ?? chunk.content,
          summary: chunkDrafts[chunk.id]?.summary ?? chunk.summary,
        });
      }
      notify.success(t('knowledgePage.toast.savedKnowledgeContent'));
      setEditingBucket(null);
      if (selectedDocument) await loadBuckets(selectedDocument, false);
    } catch (error) {
      notify.error(knowledgeErrorMessage(error, 'knowledgePage.error.saveKnowledgeContent'));
    } finally {
      setContentSaving(false);
    }
  }

  function renderKnowledgeBaseActions(item: KnowledgeBaseRead) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={t('knowledgePage.table.actionsMenu')}
          className="grid size-7 place-items-center rounded-[8px] text-[#858b9c] transition-colors outline-none hover:bg-black/5 hover:text-[#18181a]"
          onClick={(event) => event.stopPropagation()}
        >
          <MoreOutlined />
        </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className={MENU_CONTENT_CLASS}>
          {canManageCurrentScope && (
            <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => openEditKnowledgeBase(item)}>
              <EditOutlined />
              {t('knowledgePage.actions.details')}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => void openKnowledgeBaseVersions(item)}>
            <HistoryOutlined />
            {t('knowledgePage.actions.manageVersions')}
          </DropdownMenuItem>
          {canManageCurrentScope
            && Boolean(effectiveAgentId)
            && item.mode !== 'shared'
            && item.status !== 'archived' ? (
              <DropdownMenuItem
                className={MENU_ITEM_CLASS}
                onSelect={() => openSharedKnowledgeConversion(item)}
              >
                <TeamOutlined />
                {t('knowledgePage.actions.convertToShared')}
              </DropdownMenuItem>
            ) : null}
          <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => void exportOkfBundle(item)}>
            <DownloadOutlined />
            {t('knowledgePage.actions.exportBackup')}
          </DropdownMenuItem>
          <DropdownMenuItem className={MENU_ITEM_CLASS} disabled={okfLoading} onSelect={() => void lintOkfBundle(item)}>
            <AuditOutlined />
            {t('knowledgePage.actions.graphLint')}
          </DropdownMenuItem>
          {!isOverallAgent && item.mode !== 'shared' && (
            <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => void syncKnowledgeBaseFromOverall(item)}>
              {t('knowledgePage.actions.syncFromMarketplace')}
            </DropdownMenuItem>
          )}
          {!isOverallAgent && item.mode !== 'shared' && (
            <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => void promoteKnowledgeBaseToOverall(item)}>
              {t('knowledgePage.actions.publishToMarketplace')}
            </DropdownMenuItem>
          )}
          {canManageCurrentScope && (
            <>
              {item.status === 'archived' ? (
                <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => void setKnowledgeBaseStatus(item, true)}>
                  <PlayCircleOutlined />
                  {t('knowledgePage.actions.publish')}
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => void setKnowledgeBaseStatus(item, false)}>
                  <PauseCircleOutlined />
                  {t('knowledgePage.actions.archive')}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator className="my-[2px] bg-[#eef0f4]" />
              <DropdownMenuItem variant="destructive" className={MENU_ITEM_DANGER_CLASS} onSelect={() => deleteKnowledgeBase(item)}>
                <DeleteOutlined />
                {isOverallAgent ? t('knowledgePage.actions.delete') : t('knowledgePage.actions.remove')}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  const knowledgeBaseColumns: DataTableColumn<KnowledgeBaseRead>[] = [
    {
      key: 'name',
      title: t('knowledgePage.table.name'),
      render: (row) => (
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-[6px]">
            <strong className="truncate text-[13px] font-medium text-[#18181a]"><RawContent value={row.name} /></strong>
            <KnowledgeTypeBadge mode={row.mode} />
            {row.mode === 'shared' ? (
              <span className="text-[11px] text-[#858b9c]">{t('knowledgePage.table.boundTeamsCount', { count: row.bound_team_count || 0 })}</span>
            ) : null}
          </div>
          {row.description ? (
            <span className="mt-[2px] block truncate text-[12px] text-[#858b9c]"><RawContent value={row.description} /></span>
          ) : null}
        </div>
      ),
    },
    {
      key: 'status',
      title: t('knowledgePage.table.status'),
      width: 100,
      render: (row) => statusTag(row.status),
    },
    {
      key: 'capability_scope',
      title: t('knowledgePage.table.capabilityScope'),
      width: 105,
      render: (row) => <CapabilityScopeBadge value={row.capability_scope} />,
    },
    {
      key: 'creator',
      title: t('knowledgePage.table.creator'),
      width: 120,
      render: (row) => (
        <span className="block truncate text-[#858b9c]" title={resourceCreatorName(row)}>
          {resourceCreatorName(row) ? <RawContent value={resourceCreatorName(row)} /> : t('knowledgePage.placeholder.none')}
        </span>
      ),
    },
    {
      key: 'content_stats',
      title: t('knowledgePage.table.contentStats'),
      width: 260,
      className: 'whitespace-normal',
      render: (row) => (
        <div className="flex min-w-0 flex-wrap items-center gap-[6px]">
          {row.version ? <KTag><RawIdentifier value={`v${row.version}`} /></KTag> : <KTag>{t('knowledgePage.table.noVersion')}</KTag>}
          <KTag>{t('knowledgePage.table.documents', { count: row.document_count ?? 0 })}</KTag>
          <KTag>{t('knowledgePage.table.buckets', { count: row.bucket_count ?? 0 })}</KTag>
          <KTag>{t('knowledgePage.table.citations', { count: row.chunk_count ?? 0 })}</KTag>
        </div>
      ),
    },
    {
      key: 'actions',
      title: t('knowledgePage.table.actions'),
      width: 70,
      align: 'right',
      render: (row) => renderKnowledgeBaseActions(row),
    },
  ];

  const renderMobileKnowledgeBaseCard = (item: KnowledgeBaseRead) => (
    <article
      className={cn(
        MOBILE_CARD_CLASS,
        'cursor-pointer',
        selectedKnowledgeBase?.id === item.id && 'ring-2 ring-[#18181a]',
      )}
      key={item.id}
      onClick={() => selectKnowledgeBase(item.id)}
    >
      <div className="flex min-w-0 items-start justify-between gap-[10px]">
        <div className="min-w-0">
          <strong className="block truncate text-[14px] font-semibold text-[#18181a]"><RawContent value={item.name} /></strong>
          <div className="mt-[4px] flex flex-wrap items-center gap-[6px]">
            <KnowledgeTypeBadge mode={item.mode} />
            {item.mode === 'shared' ? (
              <span className="text-[11px] text-[#858b9c]">{t('knowledgePage.table.boundTeamsCount', { count: item.bound_team_count || 0 })}</span>
            ) : null}
          </div>
          <span className="mt-[2px] block truncate text-[12px] text-[#858b9c]">
            {item.description ? <RawContent value={item.description} /> : t('knowledgePage.placeholder.noDescription')}
          </span>
          <span className="mt-[2px] block truncate text-[12px] text-[#858b9c]">
            {t('knowledgePage.table.creatorInline')}
            {resourceCreatorName(item) ? <RawContent value={resourceCreatorName(item)} /> : t('knowledgePage.placeholder.none')}
          </span>
        </div>
        <span onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
          {renderKnowledgeBaseActions(item)}
        </span>
      </div>
      <div className="mt-[10px] flex flex-wrap items-center gap-[6px]">
        {statusTag(item.status)}
        <CapabilityScopeBadge value={item.capability_scope} />
        {item.version ? <KTag><RawIdentifier value={`v${item.version}`} /></KTag> : null}
        <KTag>{t('knowledgePage.table.documents', { count: item.document_count })}</KTag>
        <KTag>{t('knowledgePage.table.buckets', { count: item.bucket_count })}</KTag>
        <KTag>{t('knowledgePage.table.citations', { count: item.chunk_count })}</KTag>
      </div>
    </article>
  );

  if (!agentScopeLoaded) return <CapabilityScopeLoading />;

  return (
    <div className="min-h-full box-border px-[48px] pt-[32px] pb-[43px] max-[900px]:px-[16px]" aria-busy={loading}>
      <AppHeader
        onLogout={onLogout}
        userName={currentUser?.username}
        left={(
          <div className="flex min-h-[40px] flex-col justify-center gap-[4px]">
            <h1 className="m-0 text-[16px] font-medium leading-[normal] text-[#464c5e]">{pageTitle}</h1>
            <p className="m-0 text-[14px] leading-[normal] text-[#757f9c]">{pageDescription}</p>
          </div>
        )}
      />

      <div className="mt-[20px] mb-[16px] flex flex-wrap items-center justify-end gap-[12px]">
        <UIButton
          variant="outline"
          onClick={() => void refresh()}
          disabled={loading}
          className={OUTLINE_ACTION_BUTTON_CLASS}
        >
          <IconRefresh className={cn('size-[14px]', loading && 'animate-spin')} />
              {t('knowledgePage.actions.refresh')}
        </UIButton>
        {canManageCurrentScope && (
          <DropdownMenu>
            <DropdownMenuTrigger data-guide-target="knowledge-create" className="flex h-[34px] items-center gap-[4px] rounded-[10px] bg-[#18181a] px-[20px] text-[12px] font-normal text-white outline-none transition-colors hover:bg-[#303030]">
              <IconAdd className="size-[14px]" />
              {t('knowledgePage.actions.createKnowledgeBase')}
              <IconChevronDown className="size-[12px]" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className={MENU_CONTENT_CLASS}>
              <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => handleCreateAction('blank')}>
                <FileAddOutlined />
                {t('knowledgePage.actions.createKnowledgeBase')}
              </DropdownMenuItem>
              <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => handleCreateAction('okf')}>
                <FileMarkdownOutlined />
                {t('knowledgePage.actions.importBackup')}
              </DropdownMenuItem>
              {!isOverallAgent && (
                <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => handleCreateAction('plaza')}>
                  <DownloadOutlined />
                  {t('knowledgePage.actions.copyMarketplace')}
                </DropdownMenuItem>
              )}
              {!isOverallAgent && (
                <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => handleCreateAction('employee')}>
                  <TeamOutlined />
                  {t('knowledgePage.actions.copyEmployee')}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <div className="flex flex-col gap-[24px] rounded-[20px_20px_0_0] bg-white p-[18px_18px_24px_18px] shadow-[0_-4px_16px_0_rgba(0,0,0,0.05)]">
        <div className="flex flex-wrap items-stretch gap-[20px]" aria-label={t('knowledgePage.stats.label')}>
          <StatCard label={t('knowledgePage.stats.total')} value={stats.total} />
          <StatCard label={t('knowledgePage.stats.active')} value={stats.active} tone="green" />
          <StatCard label={t('knowledgePage.stats.archived')} value={stats.archived} />
          <StatCard label={t('knowledgePage.stats.documents')} value={stats.documents} />
        </div>

        <div className="flex flex-col gap-[18px]">
          <div className="flex items-center gap-[6px] px-[12px] text-[#757f9c]">
            <IconFolder className="size-[14px] shrink-0" />
            <span className="text-[14px] font-normal leading-none">{listLabel}</span>
          </div>

          <label className="flex h-[34px] w-[300px] max-w-full items-center gap-[8px] overflow-hidden rounded-[10px] border-[0.5px] border-[#e3e7f1] bg-white px-[12px] transition-colors focus-within:border-[#18181a]">
            <IconSearch className="size-[14px] shrink-0 text-[#858b9c]" />
            <input
              autoComplete="off"
              data-1p-ignore="true"
              data-lpignore="true"
              data-bwignore="true"
              value={documentSearch}
              placeholder={t('knowledgePage.search.placeholder')}
              onChange={(event) => setDocumentSearch(event.target.value)}
              className="h-full min-w-0 flex-1 bg-transparent text-[12px] text-[#17191f] outline-none placeholder:text-[#c0c6d4]"
            />
            {documentSearch && (
              <button
                type="button"
                aria-label={t('knowledgePage.search.clear')}
                onClick={() => setDocumentSearch('')}
                className="grid size-[16px] shrink-0 place-items-center text-[#c0c6d4] hover:text-[#858b9c]"
              >
                <IconClear className="size-[14px]" />
              </button>
            )}
          </label>

          <div className="grid gap-[10px] md:hidden">
            {filteredKnowledgeBases.length ? (
              pagination.pagedItems.map(renderMobileKnowledgeBaseCard)
            ) : (
              <div className="py-[40px] text-center text-[13px] text-[#858b9c]">{listEmptyText}</div>
            )}
          </div>

          <div className="hidden md:block">
            <DataTable
              aria-label={listLabel}
              columns={knowledgeBaseColumns}
              data={pagination.pagedItems}
              rowKey={(row) => row.id}
              loading={loading}
              emptyText={listEmptyText}
              onRowClick={(row) => selectKnowledgeBase(row.id)}
            />
          </div>

          {filteredKnowledgeBases.length > 0 && (
            <Paginator
              page={pagination.page}
              pageCount={pagination.pageCount}
              onChange={pagination.setPage}
            />
          )}
        </div>
      </div>

      <div className="mt-[16px] flex flex-col gap-[16px]">
        <KCard title={t('knowledgePage.cards.overviewTitle')}>
          {!selectedDocument ? (
            <EmptyState description={t('knowledgePage.cards.overviewEmpty')} />
          ) : (
            <KnowledgeOverviewPanel
              document={selectedDocument}
              knowledgeBase={selectedKnowledgeBase}
              buckets={buckets}
              okfConcepts={okfConcepts}
              canEdit={canManageCurrentScope}
              onEditDocument={openEditDocument}
              onEditBucket={openBucketEditor}
              onViewConcept={openConceptViewer}
              onEditConcept={openConceptEditor}
            />
          )}
        </KCard>

        <KCard title={t('knowledgePage.cards.searchDebugTitle')}>
          <div className="flex w-full flex-col gap-[14px]">
            <div className="flex flex-wrap items-center gap-[10px]">
              <label className={cn(SEARCH_COMBO_CLASS, 'min-w-[280px] flex-1 max-w-[560px]')}>
                <input
                  autoComplete="off"
                  data-1p-ignore="true"
                  data-lpignore="true"
                  data-bwignore="true"
                  className={SEARCH_COMBO_INPUT_CLASS}
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void runKnowledgeSearch();
                    }
                  }}
                  placeholder={t('knowledgePage.searchDebug.placeholder')}
                />
                <button
                  type="button"
                  className={SEARCH_COMBO_BUTTON_CLASS}
                  disabled={searchLoading}
                  onClick={() => void runKnowledgeSearch()}
                >
                  {searchLoading ? t('knowledgePage.searchDebug.loading') : t('knowledgePage.searchDebug.submit')}
                </button>
              </label>
              <ModelConfigDropdown
                models={modelConfigs}
                value={selectedSearchModelId}
                onChange={(modelId) => {
                  setSelectedSearchModelId(modelId);
                  window.localStorage.setItem(`${KNOWLEDGE_SEARCH_MODEL_STORAGE_KEY}:${TENANT_ID}`, modelId);
                }}
                buttonClassName="h-[34px]"
              />
            </div>
            <KnowledgeSearchDebug result={searchResult} loading={searchLoading} />
          </div>
        </KCard>
      </div>

      <ResourceImportDialog
        open={importOpen}
        loading={importLoading}
        icon={<DatabaseOutlined />}
        title={importMode === 'plaza' ? t('knowledgePage.import.marketplaceTitle') : t('knowledgePage.import.employeeTitle')}
        sourcePlaceholder={importMode === 'plaza' ? t('knowledgePage.import.marketplacePlaceholder') : t('knowledgePage.import.employeePlaceholder')}
        sources={importMode === 'plaza'
          ? openGalleryImportSourceOptions(agents, t('knowledgePage.import.marketplaceSourceLabel'))
          : visibleEmployeeAgents(agents, currentUser, { activeOnly: true, excludeAgentId: agentId })
            .map((item) => ({ value: item.id, label: item.name }))}
        sourceId={importSourceAgentId}
        itemsLabel={t('knowledgePage.import.itemsLabel')}
        items={importSourceKnowledgeBases.map((item) => ({
          id: item.id,
          label: (
            <>
              <RawContent value={item.name} />
              <span className="text-[#858b9c]"> · <RawIdentifier value={item.version || '1.0.0'} /></span>
            </>
          ),
        }))}
        selectedIds={importSelectedKnowledgeBaseIds}
        emptyText={t('knowledgePage.import.empty')}
        note={importMode === 'plaza'
          ? t('knowledgePage.import.marketplaceNote')
          : t('knowledgePage.import.employeeNote')}
        submitText={t('knowledgePage.import.submit')}
        onSourceChange={(value) => {
          setImportSourceAgentId(value);
          void loadImportSourceKnowledgeBases(value);
        }}
        onSelectedChange={setImportSelectedKnowledgeBaseIds}
        onClose={() => setImportOpen(false)}
        onSubmit={() => void submitImportKnowledgeBases()}
      />
      <KDialog open={okfImportOpen} title={t('knowledgePage.importBackupDialog.title')} onClose={() => setOkfImportOpen(false)}>
        <FileDropzone
          accept=".zip,.md,.markdown"
          disabled={okfImporting}
          onFiles={(files) => files[0] && void importOkfFile(files[0])}
        >
          <FileMarkdownOutlined className="mb-[8px] text-[28px] text-[#1a71ff]" />
          <p className="m-0 text-[14px] font-medium text-foreground">{t('knowledgePage.importBackupDialog.prompt')}</p>
          <p className="mt-[4px] mb-0 text-[12px] text-[#858b9c]">{t('knowledgePage.importBackupDialog.description')}</p>
        </FileDropzone>
      </KDialog>
      <KDialog
        open={okfLintReportOpen}
        title={okfLintKnowledgeBase ? (
          <>
            {t('knowledgePage.graphLintDialog.titleWithName')}
            <RawContent value={okfLintKnowledgeBase.name} />
          </>
        ) : t('knowledgePage.graphLintDialog.title')}
        width={820}
        onClose={() => setOkfLintReportOpen(false)}
        footer={<KDialogCancelButton onClick={() => setOkfLintReportOpen(false)}>{t('common.action.close')}</KDialogCancelButton>}
      >
        <div className="flex flex-col gap-[14px]">
          <p className="text-[13px] leading-[1.6] text-[#858b9c]">
            {t('knowledgePage.graphLintDialog.description')}
          </p>
          {okfLintIssues.length === 0 ? (
            <EmptyState description={t('knowledgePage.graphLintDialog.empty')} />
          ) : (
            <div className="grid gap-[10px] sm:grid-cols-2">
              {okfLintIssues.map((issue, index) => (
                <div
                  className="flex flex-col gap-[6px] rounded-[12px] border border-[#f4d58a] bg-[#fffaf0] p-[12px]"
                  key={`${issue.issue_type || 'issue'}-${issue.concept_id || index}`}
                >
                  <KTag color="gold">
                    {issue.issue_type ? (
                      <RawIdentifier value={issue.issue_type} />
                    ) : t('knowledgePage.graphLintDialog.fallbackType')}
                  </KTag>
                  <strong className="text-[13px] font-semibold wrap-break-word text-[#18181a]">
                    {issue.title ? <RawContent value={issue.title} /> : <RawIdentifier value={issue.concept_id || t('knowledgePage.graphLintDialog.fallbackIssue')} />}
                  </strong>
                  <span className="text-[12px] wrap-break-word text-[#858b9c]">
                    {issue.message ? <RawContent value={issue.message} /> : t('knowledgePage.graphLintDialog.pending')}
                  </span>
                  {issue.concept_id ? (
                    <small className="font-mono text-[12px] wrap-break-word text-[#858b9c]">
                      {issue.concept_id}
                    </small>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>
      </KDialog>
      <KDialog
        open={Boolean(viewingConcept)}
        title={viewingConcept ? <WikiViewerTitle concept={viewingConcept} /> : t('knowledgePage.conceptDialog.viewerTitle')}
        width="min(1040px, calc(100vw - 48px))"
        onClose={() => setViewingConcept(null)}
        footer={(
          <>
            <KDialogCancelButton onClick={() => setViewingConcept(null)}>{t('common.action.close')}</KDialogCancelButton>
            <KDialogPrimaryButton onClick={editViewingConcept}>
              <EditOutlined />
              {t('knowledgePage.conceptDialog.edit')}
            </KDialogPrimaryButton>
          </>
        )}
      >
        {viewingConcept && <WikiConceptViewer concept={viewingConcept} />}
      </KDialog>
      <KDialog
        open={Boolean(editingConcept)}
        title={
          editingConcept ? (
            <div className="flex min-w-0 flex-col gap-[4px]">
              <span className="text-[13px] font-semibold text-[#858b9c]">{t('knowledgePage.conceptEditor.subtitle')}</span>
              <strong className="line-clamp-2 text-[20px] font-semibold leading-[1.35] text-[#18181a]">
                {conceptEditorTitle ? <RawContent value={conceptEditorTitle} /> : <RawIdentifier value={editingConcept.concept_id} />}
              </strong>
            </div>
          ) : (
            t('knowledgePage.conceptEditor.title')
          )
        }
        width="min(1120px, calc(100vw - 48px))"
        onClose={() => setEditingConcept(null)}
        footer={(
          <>
            <KDialogCancelButton onClick={() => setEditingConcept(null)} />
            <KDialogPrimaryButton onClick={() => void saveConcept()}>{t('common.action.save')}</KDialogPrimaryButton>
          </>
        )}
      >
        {editingConcept && (
          <div className="grid min-w-0 grid-cols-1 gap-[16px] lg:grid-cols-[260px_minmax(0,1fr)]">
            <aside className="flex flex-col gap-[16px] rounded-[12px] border border-[#eceef1] bg-[#fafbfc] p-[16px]">
              <div className="inline-flex w-fit items-center gap-[8px] rounded-[10px] border border-[#1a71ff]/25 bg-[#1a71ff]/8 px-[11px] py-[8px] text-[13px] font-medium text-[#1a71ff]">
                <FileMarkdownOutlined />
                <span>{conceptTypeLabel(conceptEditorType)}</span>
              </div>
              <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-[12px] gap-y-[10px]">
                <span className="text-[12px] font-semibold text-[#858b9c]">{t('knowledgePage.conceptEditor.path')}</span>
                <strong className="text-[13px] wrap-break-word text-[#18181a]"><RawIdentifier value={editingConcept.concept_id} /></strong>
                <span className="text-[12px] font-semibold text-[#858b9c]">{t('knowledgePage.conceptEditor.links')}</span>
                <strong className="text-[13px] text-[#18181a]">{t('knowledgePage.conceptEditor.linkCount', { count: editingConcept.links.length })}</strong>
                <span className="text-[12px] font-semibold text-[#858b9c]">{t('knowledgePage.conceptEditor.citations')}</span>
                <strong className="text-[13px] text-[#18181a]">{t('knowledgePage.conceptEditor.citationCount', { count: editingConcept.citations.length })}</strong>
                <span className="text-[12px] font-semibold text-[#858b9c]">{t('knowledgePage.conceptEditor.updatedAt')}</span>
                <strong className="text-[13px] text-[#18181a]">{formatDateTime(editingConcept.updated_at, locale, t)}</strong>
              </div>
              <div className="rounded-[12px] border border-[#eceef1] bg-white p-[12px] text-[13px] leading-[1.65] text-[#858b9c]">
                {t('knowledgePage.conceptEditor.note')}
              </div>
            </aside>
            <section className="flex min-w-0 flex-col gap-[16px]">
              <div className="grid grid-cols-1 gap-[14px] sm:grid-cols-[minmax(0,1.4fr)_minmax(180px,0.6fr)]">
                <label className="flex flex-col gap-[8px]">
                  <span className="text-[13px] font-semibold text-[#464c5e]">{t('knowledgePage.conceptEditor.fieldTitle')}</span>
                  <Input
                    value={conceptEditorTitle}
                    onChange={(event) =>
                      setConceptDraft((prev) => updateOkfFrontmatterValue(prev, 'title', event.target.value))
                    }
                    placeholder={t('knowledgePage.conceptEditor.fieldTitlePlaceholder')}
                  />
                </label>
                <label className="flex flex-col gap-[8px]">
                  <span className="text-[13px] font-semibold text-[#464c5e]">{t('knowledgePage.conceptEditor.fieldType')}</span>
                  <UISelect
                    value={conceptEditorType}
                    onValueChange={(value) => setConceptDraft((prev) => updateOkfFrontmatterValue(prev, 'type', value))}
                  >
                    <SelectTrigger className={cn(SELECT_TRIGGER_CLASS, 'w-full')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {['Source Document', 'Source Section', 'Topic', 'Playbook', 'Business Rule', 'Query Analysis'].map((value) => (
                        <SelectItem key={value} value={value}>{conceptTypeLabel(value)}</SelectItem>
                      ))}
                    </SelectContent>
                  </UISelect>
                </label>
                <label className="flex flex-col gap-[8px] sm:col-span-full">
                  <span className="text-[13px] font-semibold text-[#464c5e]">{t('knowledgePage.conceptEditor.fieldSummary')}</span>
                  <Textarea
                    value={conceptEditorDescription}
                    rows={3}
                    onChange={(event) =>
                      setConceptDraft((prev) => updateOkfFrontmatterValue(prev, 'description', event.target.value))
                    }
                    placeholder={t('knowledgePage.conceptEditor.fieldSummaryPlaceholder')}
                  />
                </label>
              </div>
              <label className="flex flex-col gap-[8px]">
                <span className="text-[13px] font-semibold text-[#464c5e]">{t('knowledgePage.conceptEditor.source')}</span>
                <Textarea
                  className="min-h-[420px] resize-y font-mono text-[13px] leading-[1.55]"
                  value={conceptDraft}
                  rows={18}
                  onChange={(event) => setConceptDraft(event.target.value)}
                  spellCheck={false}
                />
              </label>
            </section>
          </div>
        )}
      </KDialog>
      <KDialog
        open={Boolean(editingKnowledgeBase)}
        title={t('knowledgePage.knowledgeBaseDialog.title')}
        onClose={() => setEditingKnowledgeBase(null)}
        footer={(
          <>
            <KDialogCancelButton onClick={() => setEditingKnowledgeBase(null)} />
            <KDialogPrimaryButton onClick={() => void saveKnowledgeBase()}>{t('common.action.save')}</KDialogPrimaryButton>
          </>
        )}
      >
        <div className="flex w-full flex-col gap-[12px]">
          <Input
            value={knowledgeBaseDraft.name}
            onChange={(event) => setKnowledgeBaseDraft((prev) => ({ ...prev, name: event.target.value }))}
            placeholder={t('knowledgePage.knowledgeBaseDialog.namePlaceholder')}
          />
          <Textarea
            rows={4}
            value={knowledgeBaseDraft.description}
            onChange={(event) => setKnowledgeBaseDraft((prev) => ({ ...prev, description: event.target.value }))}
            placeholder={t('knowledgePage.knowledgeBaseDialog.descriptionPlaceholder')}
          />
          <UISelect
            value={knowledgeBaseDraft.status}
            onValueChange={(value) => setKnowledgeBaseDraft((prev) => ({ ...prev, status: value }))}
          >
            <SelectTrigger className={cn(SELECT_TRIGGER_CLASS, 'w-full')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="active">{t('knowledgePage.actions.publish')}</SelectItem>
              <SelectItem value="archived">{t('knowledgePage.actions.archive')}</SelectItem>
            </SelectContent>
          </UISelect>
          <CapabilityScopeControl
            value={knowledgeBaseDraft.capability_scope}
            onChange={(value) => setKnowledgeBaseDraft((prev) => ({ ...prev, capability_scope: value }))}
            resourceType="knowledge_base"
          />
        </div>
      </KDialog>
      <KDialog
        open={Boolean(versionKnowledgeBase && versionKnowledgeBase.mode !== 'shared')}
        title={versionKnowledgeBase ? (
          <>
            {t('knowledgePage.versionDialog.titleWithName')}
            <RawContent value={versionKnowledgeBase.name} />
          </>
        ) : t('knowledgePage.versionDialog.title')}
        width={840}
        onClose={() => setVersionKnowledgeBase(null)}
        footer={<KDialogCancelButton onClick={() => setVersionKnowledgeBase(null)}>{t('common.action.close')}</KDialogCancelButton>}
      >
        <DataTable
          aria-label={t('knowledgePage.versionDialog.listAria')}
          rowKey={(row) => row.id}
          data={knowledgeBaseVersions}
          emptyText={t('knowledgePage.versionDialog.empty')}
          columns={[
            { key: 'version', title: t('knowledgePage.versionDialog.columnVersion'), render: (row) => <RawIdentifier value={row.version} /> },
            { key: 'name', title: t('knowledgePage.table.name'), render: (row) => <RawContent value={row.name} /> },
            { key: 'status', title: t('knowledgePage.table.status'), render: (row) => statusTag(String(row.status)) },
            { key: 'is_head', title: t('knowledgePage.versionDialog.columnHead'), render: (row) => (row.is_head ? <KTag color="green">{t('knowledgePage.versionDialog.current')}</KTag> : null) },
            { key: 'updated_at', title: t('knowledgePage.versionDialog.columnUpdatedAt'), render: (row) => formatDateTime(String(row.updated_at), locale, t) },
            {
              key: 'actions',
              title: t('knowledgePage.table.actions'),
              width: 96,
              render: (row) =>
                !isOverallAgent && !row.is_head ? (
                  <UIButton variant="outline" size="sm" onClick={() => void rollbackKnowledgeBaseVersion(row)}>
                    {t('knowledgePage.versionDialog.rollback')}
                  </UIButton>
                ) : null,
            },
          ] as DataTableColumn<KnowledgeBaseVersionRead>[]}
        />
      </KDialog>
      <SharedKnowledgeVersionsDialog
        open={Boolean(versionKnowledgeBase?.mode === 'shared')}
        knowledgeBase={versionKnowledgeBase?.mode === 'shared' ? versionKnowledgeBase : null}
        teamOptions={versionTeamOptions}
        onClose={() => {
          setVersionKnowledgeBase(null);
          setVersionTeamOptions([]);
        }}
        onChanged={() => refresh()}
      />
      <SharedKnowledgeConversionDialog
        open={Boolean(conversionKnowledgeBase)}
        knowledgeBase={conversionKnowledgeBase}
        agentId={effectiveAgentId}
        onClose={() => setConversionKnowledgeBase(null)}
        onConverted={handleKnowledgeConversion}
      />
      <KDialog
        open={Boolean(editingDocument)}
        title={t('knowledgePage.documentDialog.title')}
        width="min(1080px, calc(100vw - 48px))"
        onClose={() => setEditingDocument(null)}
        footer={(
          <>
            <KDialogCancelButton disabled={contentSaving} onClick={() => setEditingDocument(null)} />
            <KDialogPrimaryButton disabled={contentSaving} onClick={() => void saveDocument()}>
              {contentSaving ? t('knowledgePage.documentDialog.saving') : t('knowledgePage.documentDialog.save')}
            </KDialogPrimaryButton>
          </>
        )}
      >
        <div className="flex w-full flex-col gap-[14px]">
          <div className="grid gap-[12px] md:grid-cols-[minmax(0,1fr)_220px]">
            <Input
              value={documentDraft.title}
              onChange={(event) => setDocumentDraft((prev) => ({ ...prev, title: event.target.value }))}
              placeholder={t('knowledgePage.documentDialog.titlePlaceholder')}
            />
            <UISelect
              value={documentDraft.status}
              onValueChange={(value) => setDocumentDraft((prev) => ({ ...prev, status: value }))}
            >
              <SelectTrigger className={cn(SELECT_TRIGGER_CLASS, 'w-full')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ready">{t('knowledgePage.documentDialog.status.ready')}</SelectItem>
                <SelectItem value="processing">{t('knowledgePage.documentDialog.status.processing')}</SelectItem>
                <SelectItem value="failed">{t('knowledgePage.documentDialog.status.failed')}</SelectItem>
                <SelectItem value="archived">{t('knowledgePage.documentDialog.status.archived')}</SelectItem>
              </SelectContent>
            </UISelect>
          </div>
          <div className="flex items-center justify-between gap-[12px]">
            <div className="inline-flex rounded-[9px] bg-[#f3f5f8] p-[3px]" aria-label={t('knowledgePage.documentDialog.editorModeAria')}>
              <button
                type="button"
                className={cn('rounded-[7px] px-[14px] py-[6px] text-[12px] text-[#697085]', documentEditorMode === 'edit' && 'bg-white font-medium text-[#17191f] shadow-sm')}
                onClick={() => setDocumentEditorMode('edit')}
              >
                {t('knowledgePage.documentDialog.editMode')}
              </button>
              <button
                type="button"
                className={cn('rounded-[7px] px-[14px] py-[6px] text-[12px] text-[#697085]', documentEditorMode === 'preview' && 'bg-white font-medium text-[#17191f] shadow-sm')}
                onClick={() => setDocumentEditorMode('preview')}
              >
                {t('knowledgePage.documentDialog.previewMode')}
              </button>
            </div>
            <span className="text-[12px] tabular-nums text-[#858b9c]">{t('knowledgePage.documentDialog.charCount', { count: documentDraft.content_md.length })}</span>
          </div>
          {documentEditorMode === 'edit' ? (
            <Textarea
              rows={22}
              value={documentDraft.content_md}
              onChange={(event) => setDocumentDraft((prev) => ({ ...prev, content_md: event.target.value }))}
              placeholder={t('knowledgePage.documentDialog.contentPlaceholder')}
              className="min-h-[460px] resize-y font-mono text-[13px] leading-6"
            />
          ) : (
            <div className="min-h-[460px] max-h-[62vh] overflow-auto rounded-[12px] border border-[#e6e9ef] bg-white p-[18px]">
              <MarkdownPreview markdown={documentDraft.content_md || t('knowledgePage.documentDialog.emptyPreview')} />
            </div>
          )}
          <p className="m-0 text-[12px] leading-5 text-[#858b9c]">
            {t('knowledgePage.documentDialog.note')}
          </p>
        </div>
      </KDialog>
      <KDialog
        open={Boolean(editingBucket)}
        title={t('knowledgePage.bucketDialog.title')}
        width={920}
        onClose={() => setEditingBucket(null)}
        footer={(
          <>
            <KDialogCancelButton disabled={contentSaving} onClick={() => setEditingBucket(null)} />
            <KDialogPrimaryButton disabled={contentSaving} onClick={() => void saveBucketAndChunks()}>{t('common.action.save')}</KDialogPrimaryButton>
          </>
        )}
      >
        <div className="flex w-full flex-col gap-[14px]">
          <Input
            value={bucketDraft.title}
            onChange={(event) => setBucketDraft((prev) => ({ ...prev, title: event.target.value }))}
            placeholder={t('knowledgePage.bucketDialog.titlePlaceholder')}
          />
          <Textarea
            rows={4}
            value={bucketDraft.summary}
            onChange={(event) => setBucketDraft((prev) => ({ ...prev, summary: event.target.value }))}
            placeholder={t('knowledgePage.bucketDialog.summaryPlaceholder')}
          />
          <div className="flex flex-col gap-[12px]">
            {bucketChunks.map((chunk) => (
              <div
                className="flex flex-col gap-[10px] rounded-[12px] border border-[#eceef1] bg-[#fafbfc] p-[12px]"
                key={chunk.id}
              >
                <div className="flex items-center justify-between gap-[10px]">
                  <strong className="text-[13px] font-semibold text-[#18181a]">{t('knowledgePage.bucketDialog.chunkTitle', { index: chunk.chunk_index + 1 })}</strong>
                  <KTag><RawIdentifier value={chunk.source_ref || 'chunk'} /></KTag>
                </div>
                <Textarea
                  rows={2}
                  value={chunkDrafts[chunk.id]?.summary || ''}
                  onChange={(event) =>
                    setChunkDrafts((prev) => ({
                      ...prev,
                      [chunk.id]: { ...(prev[chunk.id] || { content: chunk.content, summary: '' }), summary: event.target.value },
                    }))
                  }
                  placeholder={t('knowledgePage.bucketDialog.chunkSummaryPlaceholder')}
                />
                <Textarea
                  rows={6}
                  value={chunkDrafts[chunk.id]?.content || ''}
                  onChange={(event) =>
                    setChunkDrafts((prev) => ({
                      ...prev,
                      [chunk.id]: { ...(prev[chunk.id] || { content: '', summary: chunk.summary || '' }), content: event.target.value },
                    }))
                  }
                  placeholder={t('knowledgePage.bucketDialog.chunkContentPlaceholder')}
                />
              </div>
            ))}
          </div>
        </div>
      </KDialog>

      <ConfirmDialog
        open={Boolean(deleteKbTarget)}
        onOpenChange={(open) => !open && setDeleteKbTarget(null)}
        title={deleteKbTarget ? (
          <>
            {isOverallAgent ? t('knowledgePage.deleteDialog.titleDelete') : t('knowledgePage.deleteDialog.titleRemove')}
            <RawContent value={deleteKbTarget.name} />
          </>
        ) : ''}
        description={!isOverallAgent
          ? t('knowledgePage.deleteDialog.removeDescription')
          : t('knowledgePage.deleteDialog.deleteDescription')}
        confirmText={isOverallAgent ? t('knowledgePage.actions.delete') : t('knowledgePage.actions.remove')}
        cancelText={t('common.action.cancel')}
        onConfirm={() => void runDeleteKnowledgeBase()}
      />
    </div>
  );
}

export function KnowledgeAddPage({ currentUser }: KnowledgePageProps = {}) {
  const { t } = useAppIntl();
  const navigate = useNavigate();
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBaseRead[]>([]);
  const [capabilityScope, setCapabilityScope] = useState<CapabilityScope>('general');
  const [newBaseMode, setNewBaseMode] = useState<'dedicated' | 'shared'>('dedicated');
  const [newBaseName, setNewBaseName] = useState('');
  const [newBaseDescription, setNewBaseDescription] = useState('');
  const [creatingBase, setCreatingBase] = useState(false);
  const [jobs, setJobs] = useState<Record<string, KnowledgeIngestJobRead>>({});
  const [agentId, setAgentId] = useState(readEmployeeScope);
  const [agentScopeLoaded, setAgentScopeLoaded] = useState(false);
  const [checkedDiscoveryJobIds, setCheckedDiscoveryJobIds] = useState<string[]>([]);
  const [pendingDiscoveries, setPendingDiscoveries] = useState<KnowledgeDiscoveryRead[]>([]);
  const [discoveryModalOpen, setDiscoveryModalOpen] = useState(false);
  const [cancellingJobIds, setCancellingJobIds] = useState<string[]>([]);
  const sortedJobs = useMemo(
    () => Object.values(jobs).sort((left, right) => {
      const diff = knowledgeJobSortTime(right) - knowledgeJobSortTime(left);
      return diff || right.id.localeCompare(left.id);
    }),
    [jobs],
  );
  const activeJobs = useMemo(
    () => sortedJobs.filter((job) => ['queued', 'running', 'cancel_requested'].includes(job.status)),
    [sortedJobs],
  );
  const visibleKnowledgeBases = useMemo(
    () => knowledgeBases.filter((item) => !isEmptyDefaultKnowledgeBase(item)),
    [knowledgeBases],
  );

  useEffect(() => {
    let active = true;
    api
      .get<AgentProfileRead[]>(`/api/enterprise/agents?tenant_id=${TENANT_ID}`)
      .then((agentRows) => {
        if (!active) return;
        const resolvedAgentId = resolveKnowledgeAgentScope(agentRows, currentUser, agentId);
        if (resolvedAgentId !== agentId) {
          if (resolvedAgentId) {
            persistSharedAgentScope(resolvedAgentId, currentUser?.id);
          } else {
            clearSharedAgentScope(currentUser?.id);
          }
          setAgentId(resolvedAgentId);
          emitAgentScopeChange(resolvedAgentId);
        }
        setAgentScopeLoaded(true);
      })
      .catch(() => {
        if (active) setAgentScopeLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [currentUser?.id]);

  useEffect(() => {
    if (!agentScopeLoaded) return;
    void refreshKnowledgeBases();
    void loadRecentJobs();
  }, [agentId, agentScopeLoaded]);

  useEffect(() => {
    const onScopeChange = (event: Event) => {
      const next = (event as CustomEvent<{ agentId?: string }>).detail?.agentId || '';
      setAgentId(next && !isTeamScope(next) ? next : readEmployeeScope());
    };
    window.addEventListener('ultrarag-enterprise-agent-scope-change', onScopeChange);
    return () => window.removeEventListener('ultrarag-enterprise-agent-scope-change', onScopeChange);
  }, []);

  useEffect(() => {
    if (activeJobs.length === 0) return;
    const timer = window.setInterval(() => {
      activeJobs.forEach((job) => {
        void api
          .get<KnowledgeIngestJobRead>(
            `/api/enterprise/knowledge/jobs/${job.id}?tenant_id=${TENANT_ID}${agentId ? `&agent_id=${encodeURIComponent(agentId)}` : ''}`,
          )
          .then((next) => {
            setJobs((prev) => ({ ...prev, [next.id]: next }));
            if (TERMINAL_KNOWLEDGE_JOB_STATUSES.has(next.status)) {
              setCancellingJobIds((current) => current.filter((id) => id !== next.id));
              void refreshKnowledgeBases();
              void loadRecentJobs();
            }
          })
          .catch(() => undefined);
      });
    }, 1400);
    return () => window.clearInterval(timer);
  }, [activeJobs]);

  useEffect(() => {
    sortedJobs
      .filter((job) => job.status === 'succeeded' && !checkedDiscoveryJobIds.includes(job.id))
      .forEach((job) => {
        void loadDiscoveriesForJob(job);
      });
  }, [sortedJobs, checkedDiscoveryJobIds, agentId]);

  async function refreshKnowledgeBases() {
    if (!isEnterpriseAdmin(currentUser) && !agentId) {
      setKnowledgeBases([]);
      return;
    }
    try {
      const suffix = agentId ? `&agent_id=${encodeURIComponent(agentId)}` : '';
      const rows = await api.get<KnowledgeBaseRead[]>(`/api/enterprise/knowledge-bases?tenant_id=${TENANT_ID}${suffix}`);
      setKnowledgeBases(rows);
    } catch (error) {
      notify.error(apiErrorMessage(error, 'knowledgePage.add.error.loadKnowledgeBases', { t }));
    }
  }

  async function loadRecentJobs() {
    if (!isEnterpriseAdmin(currentUser) && !agentId) {
      setJobs({});
      return;
    }
    try {
      const suffix = agentId ? `&agent_id=${encodeURIComponent(agentId)}` : '';
      const rows = await api.get<KnowledgeIngestJobRead[]>(
        `/api/enterprise/knowledge/jobs?tenant_id=${TENANT_ID}${suffix}&limit=8`,
      );
      setJobs(Object.fromEntries(rows.map((job) => [job.id, job])));
    } catch {
      setJobs({});
    }
  }

  async function createEmptyKnowledgeBase() {
    /** 创建显式类型的空知识库；共享库后续由团队详情绑定并配置权限。 */
    const name = newBaseName.trim();
    if (!name) {
      notify.warning(t('knowledgePage.add.toast.enterName'));
      return;
    }
    if (newBaseMode === 'shared' && !isEnterpriseAdmin(currentUser)) {
      notify.error(t('knowledgePage.add.error.adminOnlyShared'));
      return;
    }
    setCreatingBase(true);
    try {
      await api.post<KnowledgeBaseRead>('/api/enterprise/knowledge-bases', {
        tenant_id: TENANT_ID,
        name,
        description: newBaseDescription.trim() || undefined,
        mode: newBaseMode,
        agent_id: newBaseMode === 'dedicated' && agentId ? agentId : undefined,
        capability_scope: capabilityScope,
      });
      notify.success(newBaseMode === 'shared' ? t('knowledgePage.add.toast.createdShared') : t('knowledgePage.add.toast.createdDedicated'));
      navigate('/enterprise/knowledge');
    } catch (error) {
      notify.error(apiErrorMessage(error, 'knowledgePage.add.error.createKnowledgeBase', { t }));
    } finally {
      setCreatingBase(false);
    }
  }

  async function uploadFile(file: File) {
    if (!isEnterpriseAdmin(currentUser) && !agentId) {
      notify.warning(t('knowledgePage.toast.selectEmployee'));
      return;
    }
    try {
      const contentBase64 = await fileToBase64(file);
      const suffix = agentId ? `?agent_id=${encodeURIComponent(agentId)}` : '';
      const job = await api.post<KnowledgeIngestJobRead>(`/api/enterprise/knowledge/documents${suffix}`, {
        tenant_id: TENANT_ID,
        filename: file.name,
        title: file.name.replace(/\.[^.]+$/, ''),
        content_base64: contentBase64,
        capability_scope: capabilityScope,
      });
      setJobs((prev) => ({ ...prev, [job.id]: job }));
      await refreshKnowledgeBases();
      notify.success(t('knowledgePage.add.toast.createdJob'));
    } catch (error) {
      notify.error(apiErrorMessage(error, 'knowledgePage.add.error.upload', { t }));
    }
  }

  async function cancelJob(job: KnowledgeIngestJobRead) {
    if (!['queued', 'running', 'cancel_requested'].includes(job.status)) return;
    setCancellingJobIds((current) => (current.includes(job.id) ? current : [...current, job.id]));
    try {
      const next = await api.post<KnowledgeIngestJobRead>(
        `/api/enterprise/knowledge/jobs/${job.id}/cancel?tenant_id=${TENANT_ID}`,
      );
      setJobs((prev) => ({ ...prev, [next.id]: next }));
      notify.success(next.status === 'cancelled' ? t('knowledgePage.add.toast.cancelledJob') : t('knowledgePage.add.toast.cancelRequested'));
    } catch (error) {
      notify.error(apiErrorMessage(error, 'knowledgePage.add.error.cancelJob', { t }));
    } finally {
      setCancellingJobIds((current) => current.filter((id) => id !== job.id));
    }
  }

  async function loadDiscoveriesForJob(job: KnowledgeIngestJobRead) {
    setCheckedDiscoveryJobIds((prev) => (prev.includes(job.id) ? prev : [...prev, job.id]));
    try {
      const suffix = agentId ? `&agent_id=${encodeURIComponent(agentId)}` : '';
      const rows = await api.get<KnowledgeDiscoveryRead[]>(`/api/enterprise/knowledge/discoveries?tenant_id=${TENANT_ID}${suffix}`);
      const next = rows.filter(
        (item) =>
          item.status === 'pending' &&
          item.suggestion_type !== 'warning' &&
          item.knowledge_base_id === job.knowledge_base_id &&
          (!job.document_id || item.document_id === job.document_id),
      );
      if (next.length === 0) return;
      setPendingDiscoveries((current) => {
        const seen = new Set(current.map((item) => item.id));
        return [...current, ...next.filter((item) => !seen.has(item.id))];
      });
      setDiscoveryModalOpen(true);
    } catch (error) {
      notify.warning(apiErrorMessage(error, 'knowledgePage.add.error.loadDiscoveries', { t }));
    }
  }

  async function confirmDiscovery(item: KnowledgeDiscoveryRead) {
    try {
      await api.post(`/api/enterprise/knowledge/discoveries/${item.id}/confirm?tenant_id=${TENANT_ID}`);
      notify.success(t('knowledgePage.add.toast.confirmedSuggestion'));
      setPendingDiscoveries((current) => current.filter((entry) => entry.id !== item.id));
      await refreshKnowledgeBases();
    } catch (error) {
      notify.error(apiErrorMessage(error, 'knowledgePage.add.error.confirmSuggestion', { t }));
    }
  }

  async function rejectDiscovery(item: KnowledgeDiscoveryRead) {
    try {
      await api.post(`/api/enterprise/knowledge/discoveries/${item.id}/reject?tenant_id=${TENANT_ID}`);
      notify.success(t('knowledgePage.add.toast.rejectedSuggestion'));
      setPendingDiscoveries((current) => current.filter((entry) => entry.id !== item.id));
    } catch (error) {
      notify.error(apiErrorMessage(error, 'knowledgePage.add.error.rejectSuggestion', { t }));
    }
  }

  return (
    <div className="knowledge-page knowledge-add-page knowledge-floating-subpage">
      <div className="knowledge-floating-shell">
        <div className="knowledge-floating-head">
          <div>
            <span className="section-kicker">{t('knowledgePage.add.kicker')}</span>
            <h3 className="my-[4px] text-[20px] font-semibold text-foreground">{t('knowledgePage.add.title')}</h3>
            <span className="text-[13px] text-[#858b9c]">{t('knowledgePage.add.description')}</span>
          </div>
            <UIButton variant="outline" onClick={() => navigate('/enterprise/knowledge')}>
              <RightOutlined />
              {t('common.action.back')}
            </UIButton>
        </div>

        <KCard title={t('knowledgePage.add.createEmptyTitle')}>
          <section aria-label={t('knowledgePage.add.configAria')} className="flex flex-col gap-[16px]">
            <div className="grid gap-[10px] sm:grid-cols-2">
              <label className={cn(
                'flex cursor-pointer items-start gap-[10px] rounded-[12px] border p-[14px]',
                newBaseMode === 'dedicated' && 'border-[#1a71ff] bg-[#1a71ff]/5',
              )}>
                <input
                  type="radio"
                  name="knowledge-base-mode"
                  value="dedicated"
                  checked={newBaseMode === 'dedicated'}
                  onChange={() => setNewBaseMode('dedicated')}
                />
                <span>
                  <strong className="block text-[14px] text-foreground">{t('knowledgePage.add.modeDedicated')}</strong>
                  <small className="mt-[3px] block text-[12px] leading-5 text-[#858b9c]">
                    {t('knowledgePage.add.modeDedicatedDescription')}
                  </small>
                </span>
              </label>
              <label className={cn(
                'flex items-start gap-[10px] rounded-[12px] border p-[14px]',
                isEnterpriseAdmin(currentUser) ? 'cursor-pointer' : 'cursor-not-allowed opacity-60',
                newBaseMode === 'shared' && 'border-[#6d28d9] bg-[#6d28d9]/5',
              )}>
                <input
                  type="radio"
                  name="knowledge-base-mode"
                  value="shared"
                  checked={newBaseMode === 'shared'}
                  disabled={!isEnterpriseAdmin(currentUser)}
                  onChange={() => setNewBaseMode('shared')}
                />
                <span>
                  <strong className="block text-[14px] text-foreground">{t('knowledgePage.add.modeShared')}</strong>
                  <small className="mt-[3px] block text-[12px] leading-5 text-[#858b9c]">
                    {t('knowledgePage.add.modeSharedDescription')}
                  </small>
                </span>
              </label>
            </div>
            <div className="grid gap-[12px] md:grid-cols-2">
              <label className="flex flex-col gap-[7px] text-[13px] font-medium text-[#464c5e]">
                {t('knowledgePage.add.nameLabel')}
                <Input
                  aria-label={t('knowledgePage.add.nameLabel')}
                  value={newBaseName}
                  onChange={(event) => setNewBaseName(event.target.value)}
                  placeholder={t('knowledgePage.add.namePlaceholder')}
                />
              </label>
              <label className="flex flex-col gap-[7px] text-[13px] font-medium text-[#464c5e]">
                {t('knowledgePage.add.descriptionLabel')}
                <Input
                  aria-label={t('knowledgePage.add.descriptionLabel')}
                  value={newBaseDescription}
                  onChange={(event) => setNewBaseDescription(event.target.value)}
                  placeholder={t('knowledgePage.add.descriptionPlaceholder')}
                />
              </label>
            </div>
            <CapabilityScopeControl
              value={capabilityScope}
              onChange={setCapabilityScope}
              resourceType="knowledge_base"
            />
            <div className="flex justify-end">
              <UIButton disabled={creatingBase} onClick={() => void createEmptyKnowledgeBase()}>
                {creatingBase ? t('knowledgePage.add.creating') : t('knowledgePage.add.createSubmit')}
              </UIButton>
            </div>
          </section>
        </KCard>

        <KCard className="knowledge-upload-card" bodyClassName="flex flex-col gap-[16px]">
          <div className="knowledge-upload-controls">
            <div>
              <strong className="block text-[14px] font-semibold text-foreground">{t('knowledgePage.add.uploadTitle')}</strong>
              <span className="text-[13px] text-[#858b9c]">{t('knowledgePage.add.uploadDescription')}</span>
            </div>
            <UIButton variant="outline" onClick={() => navigate('/enterprise/knowledge')}>{t('knowledgePage.add.manageExisting')}</UIButton>
          </div>
        {visibleKnowledgeBases.length > 0 && (
          <div className="knowledge-base-target-strip">
            {visibleKnowledgeBases.map((item) => (
              <div
                key={item.id}
                className="knowledge-base-target"
              >
                <span><RawContent value={item.name} /></span>
                <small>
                  {t('knowledgePage.add.targetSummary', {
                    documentCount: item.document_count,
                    bucketCount: item.bucket_count,
                    chunkCount: item.chunk_count,
                  })}
                </small>
                <CapabilityScopeBadge value={item.capability_scope} />
              </div>
            ))}
          </div>
        )}
        <CapabilityScopeControl
          value={capabilityScope}
          onChange={setCapabilityScope}
          resourceType="knowledge_base"
        />
        <FileDropzone
          multiple
          accept=".doc,.docx,.txt,.md,.markdown,.html,.htm,.pdf"
          onFiles={(files) => files.forEach((file) => void uploadFile(file))}
        >
          <div className="knowledge-upload-inner">
            <InboxOutlined />
            <div>
              <strong>{t('knowledgePage.add.dropzoneTitle')}</strong>
              <span>{t('knowledgePage.add.dropzoneDescription')}</span>
            </div>
          </div>
        </FileDropzone>
        </KCard>

        <KCard title={t('knowledgePage.add.jobsTitle')}>
          {sortedJobs.length === 0 ? (
            <EmptyState description={t('knowledgePage.add.jobsEmpty')} />
          ) : (
            <div className="knowledge-jobs">
              {sortedJobs.map((job) => (
                <KnowledgeJobCard
                  job={job}
                  key={job.id}
                  cancelling={cancellingJobIds.includes(job.id)}
                  onCancel={cancelJob}
                />
              ))}
            </div>
          )}
        </KCard>
      </div>

      <KDialog
        open={discoveryModalOpen && pendingDiscoveries.length > 0}
        title={t('knowledgePage.add.discoveryDialogTitle')}
        width={820}
        className="knowledge-discovery-modal"
        onClose={() => setDiscoveryModalOpen(false)}
      >
        <DiscoveryColumn
          title={t('knowledgePage.add.discoveryColumnTitle')}
          description={t('knowledgePage.add.discoveryColumnDescription')}
          items={pendingDiscoveries}
          onConfirm={confirmDiscovery}
          onReject={rejectDiscovery}
        />
      </KDialog>
    </div>
  );
}

function KnowledgeJobCard({
  job,
  cancelling,
  onCancel,
}: {
  job: KnowledgeIngestJobRead;
  cancelling?: boolean;
  onCancel?: (job: KnowledgeIngestJobRead) => void;
}) {
  const { t } = useAppIntl();
  const steps = ingestSteps(job, t);
  const metadata = job.metadata || {};
  const stageCode = typeof metadata.stage_code === 'string' ? metadata.stage_code : job.stage;
  const stageLabel = knowledgeStageLabel(stageCode, t);
  const stageDetail = knowledgeStageDetailLabel(metadata.stage_detail, t);
  const cancellable = ['queued', 'running'].includes(job.status);
  return (
    <div className="knowledge-job">
      <div className="knowledge-job-head">
        <div>
          <strong className="text-[14px] font-semibold text-foreground"><RawIdentifier value={job.filename} /></strong>
          <span className="text-[13px] text-[#858b9c]"> · {stageLabel}</span>
        </div>
        <div className="flex shrink-0 items-center gap-[8px]">
          {statusTag(job.status)}
          {cancellable && onCancel && (
            <UIButton
              type="button"
              variant="outline"
              size="sm"
              className={OUTLINE_ACTION_BUTTON_SM_CLASS}
              disabled={cancelling}
              onClick={() => onCancel(job)}
            >
              <CloseOutlined />
              {cancelling ? t('knowledgePage.add.jobCancelling') : t('common.action.cancel')}
            </UIButton>
          )}
        </div>
      </div>
      <SmoothProgress job={job} />
      <div className="knowledge-stage-track">
        {steps.map((step) => (
          <div className={`knowledge-stage-step is-${step.status}`} key={step.key}>
            <span />
            <small>{step.label}</small>
          </div>
        ))}
      </div>
      {stageDetail && <span className="knowledge-job-detail text-[13px] text-[#858b9c]">{stageDetail}</span>}
      {job.error && <span className="text-[13px] text-[#d20b0b]">{knowledgeErrorLabel(job.error, t)}</span>}
    </div>
  );
}

function knowledgeJobSortTime(job: KnowledgeIngestJobRead): number {
  const createdAt = Date.parse(job.created_at || '');
  if (Number.isFinite(createdAt)) return createdAt;
  const updatedAt = Date.parse(job.updated_at || '');
  return Number.isFinite(updatedAt) ? updatedAt : 0;
}

function SmoothProgress({ job }: { job: KnowledgeIngestJobRead }) {
  const target = Math.max(0, Math.min(100, Math.round((job.progress || 0) * 100)));
  const [displayProgress, setDisplayProgress] = useState(target);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setDisplayProgress((current) => {
        if (current === target) return current;
        const diff = target - current;
        const step = Math.max(1, Math.ceil(Math.abs(diff) / 14));
        return current + Math.sign(diff) * Math.min(Math.abs(diff), step);
      });
    }, 80);
    return () => window.clearInterval(timer);
  }, [target]);

  const failed = job.status === 'failed';
  const cancelled = job.status === 'cancelled';
  const cancelling = job.status === 'cancel_requested';
  const indicatorClassName = failed
    ? 'bg-[#d20b0b]'
    : cancelled
      ? 'bg-[#9aa3b2]'
      : cancelling
        ? 'bg-[#d29a0b]'
        : 'bg-gradient-to-r from-[#0f7f74] to-[#16a34a]';
  const valueClassName = failed ? 'text-[#d20b0b]' : 'text-[#858b9c]';
  return (
    <div className="flex items-center gap-[10px]">
      <Progress
        value={displayProgress}
        className="h-[8px] flex-1"
        indicatorClassName={indicatorClassName}
      />
      <span className={cn('text-[12px] tabular-nums', valueClassName)}>
        {displayProgress}%
      </span>
    </div>
  );
}

function ingestSteps(
  job: KnowledgeIngestJobRead,
  t: KnowledgeTranslate = currentKnowledgeTranslator().t,
): IngestStepView[] {
  const raw = (job.metadata || {}).ingest_steps;
  if (Array.isArray(raw)) {
    const parsedSteps = raw.flatMap((item) => {
      if (!isRecord(item) || typeof item.key !== 'string' || !item.key) return [];
      const status: IngestStepView['status'] = item.status === 'running' || item.status === 'done'
        ? item.status
        : 'pending';
      const progress = typeof item.progress === 'number' && Number.isFinite(item.progress)
        ? item.progress
        : 0;
      return [{
        key: item.key,
        label: knowledgeStageLabel(item.key, t),
        progress,
        status,
      }];
    });
    if (parsedSteps.length > 0) return parsedSteps;
  }
  const currentProgress = job.progress || 0;
  const defaultSteps = defaultIngestSteps(t);
  if (job.status === 'cancelled' || job.stage === 'cancelled') {
    return defaultSteps.map((step) => ({
      ...step,
      status: step.progress < currentProgress ? 'done' : 'pending',
    }));
  }
  return defaultSteps.map((step) => ({
    ...step,
    status:
      job.stage === step.key
        ? 'running'
        : step.progress < currentProgress || job.stage === 'done'
        ? 'done'
        : 'pending',
  }));
}

function stringFromMetadata(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeMarkdownForDisplay(markdown: string): string {
  return markdown
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+(#{1,6}\s+)/g, '\n\n$1')
    .trim();
}

function documentSourceMarkdown(document: KnowledgeDocumentRead, fallback: string): string {
  const metadata = document.metadata || {};
  const rawText = stringFromMetadata(metadata.raw_text) || stringFromMetadata(metadata.content);
  if (rawText.trim()) return rawText;
  const sectionTree = Array.isArray(metadata.section_tree) ? metadata.section_tree : [];
  const sourceBlocks = sectionTree
    .map((node) => {
      if (!isRecord(node)) return '';
      const content = stringFromMetadata(node.content).trim();
      if (content) return content;
      const title = stringFromMetadata(node.title).trim();
      const summary = stringFromMetadata(node.summary).trim();
      if (title && summary) return `## ${title}\n\n${summary}`;
      return title || summary;
    })
    .filter(Boolean);
  return sourceBlocks.length ? sourceBlocks.join('\n\n') : fallback;
}

type KnowledgeDetailView = 'document' | 'sections' | 'wiki' | 'evidence';
type KnowledgeContentView = 'sections' | 'wiki' | 'evidence';
const STRUCTURE_PREVIEW_LIMIT = 8;
const OKF_PREVIEW_LIMIT = 8;

type WikiIndexGroup = {
  key: string;
  title: string;
  description: string;
  concepts: KnowledgeConceptRead[];
};

type KnowledgeOverviewItem = {
  key: string;
  title: string;
  summary: string;
  concept?: KnowledgeConceptRead;
  indexGroup?: WikiIndexGroup;
  bucket?: KnowledgeBucketRead;
};

function KnowledgeOverviewPanel({
  document,
  knowledgeBase,
  buckets,
  okfConcepts,
  canEdit,
  onEditDocument,
  onEditBucket,
  onViewConcept,
  onEditConcept,
}: {
  document: KnowledgeDocumentRead;
  knowledgeBase: KnowledgeBaseRead | null;
  buckets: KnowledgeBucketRead[];
  okfConcepts: KnowledgeConceptRead[];
  canEdit: boolean;
  onEditDocument: (document: KnowledgeDocumentRead) => void;
  onEditBucket: (bucket: KnowledgeBucketRead) => void;
  onViewConcept: (concept: KnowledgeConceptRead) => void;
  onEditConcept: (concept: KnowledgeConceptRead) => void;
}) {
  const { locale, t } = useAppIntl();
  const [detailView, setDetailView] = useState<KnowledgeDetailView | null>(null);
  const [detailFocusKey, setDetailFocusKey] = useState<string | null>(null);
  const [activeContentView, setActiveContentView] = useState<KnowledgeContentView>('evidence');
  const [wikiPresentation, setWikiPresentation] = useState<'graph' | 'cards'>('graph');
  const [wikiViewMode, setWikiViewMode] = useState<'graph' | 'cards'>('graph');
  const metadata = document.metadata || {};
  const documentCard = isRecord(metadata.document_card) ? metadata.document_card : {};
  const wikiStructureConcepts = useMemo(() => sortWikiConcepts(okfConcepts, locale), [locale, okfConcepts]);
  const wikiIndexGroups = useMemo(
    () => buildWikiIndexGroups(wikiStructureConcepts, locale),
    [locale, wikiStructureConcepts],
  );
  const previewWikiStructure = wikiIndexGroups.slice(0, STRUCTURE_PREVIEW_LIMIT);
  const previewConcepts = okfConcepts.slice(0, OKF_PREVIEW_LIMIT);
  const documentTitle = String(documentCard.title || document.title || knowledgeBase?.name || document.filename);
  const documentSummary = String(documentCard.summary || t('knowledgePage.overview.noDocumentSummary'));
  const sourceMarkdown = useMemo(() => documentSourceMarkdown(document, documentSummary), [document, documentSummary]);
  const totalChunkCount = buckets.reduce((sum, bucket) => sum + (bucket.chunk_count || 0), 0) || document.chunk_count || 0;
  const evidenceBuckets = useMemo(
    () => buckets.filter((bucket) => bucket.chunk_count > 0 || bucketContentMarkdown(bucket).trim()),
    [buckets],
  );
  const previewEvidence = useMemo(
    () => previewEvidenceItems(buckets, totalChunkCount, OKF_PREVIEW_LIMIT),
    [buckets, totalChunkCount],
  );
  const openDetail = (view: KnowledgeDetailView, focusKey?: string) => {
    setDetailFocusKey(focusKey || null);
    setDetailView(view);
  };
  const openContentDetail = (view: KnowledgeContentView, focusKey?: string) => {
    if (view === 'sections') {
      openDetail('sections', focusKey);
      return;
    }
    openDetail(view, focusKey);
  };

  useEffect(() => {
    if (!detailView || !detailFocusKey) return;
    const timer = window.setTimeout(() => {
      const targets = Array.from(window.document.querySelectorAll<HTMLElement>('.knowledge-detail-modal .knowledge-detail-target'));
      const target = targets.find((item) => item.dataset.detailKey === detailFocusKey);
      if (!target) return;
      target.scrollIntoView({ block: 'start', behavior: 'auto' });
      target.classList.add('is-focused');
      window.setTimeout(() => target.classList.remove('is-focused'), 1500);
    }, 120);
    return () => window.clearTimeout(timer);
  }, [detailView, detailFocusKey]);

  const overviewContent: Record<
    KnowledgeContentView,
    {
      title: string;
      description: string;
      count: number;
      emptyText: string;
      items: KnowledgeOverviewItem[];
    }
  > = {
    sections: {
      title: t('knowledgePage.overview.sectionsTitle'),
      description: t('knowledgePage.overview.sectionsDescription'),
      count: wikiIndexGroups.length,
      emptyText: t('knowledgePage.overview.sectionsEmpty'),
      items: previewWikiStructure.map((group) => ({
        key: group.key,
        title: group.title,
        summary: group.description,
        indexGroup: group,
      })),
    },
    wiki: {
      title: t('knowledgePage.overview.wikiTitle'),
      description: t('knowledgePage.overview.wikiDescription'),
      count: okfConcepts.length,
      emptyText: t('knowledgePage.overview.wikiEmpty'),
      items: previewConcepts.map((concept) => ({
        key: concept.id,
        title: concept.title || concept.concept_id,
        summary: `${conceptTypeLabel(concept.concept_type)} · ${concept.description || concept.concept_id}`,
        concept,
      })),
    },
    evidence: {
      title: t('knowledgePage.overview.evidenceTitle'),
      description: t('knowledgePage.overview.evidenceDescription'),
      count: totalChunkCount,
      emptyText: t('knowledgePage.overview.evidenceEmpty'),
      items: previewEvidence,
    },
  };
  const activeContent = overviewContent[activeContentView];

  return (
    <div className="knowledge-pageindex">
      <div className="knowledge-pageindex-card">
        <div className="knowledge-document-card-body">
          <span className="text-[13px] text-[#858b9c]">{t('knowledgePage.overview.documentCard')}</span>
          <h5 className="my-[4px] text-[15px] font-semibold text-foreground"><RawContent value={documentTitle} /></h5>
          <div className="knowledge-document-card-markdown is-preview">
            <MarkdownPreview markdown={documentSummary} />
          </div>
        </div>
        <div className="knowledge-pageindex-actions">
          <UIButton variant="outline" className={OUTLINE_ACTION_BUTTON_SM_CLASS} onClick={() => openDetail('document')}>
            <EditOutlined />
            {t('knowledgePage.actions.details')}
          </UIButton>
        </div>
        <div className="knowledge-document-meta">
          <button type="button" className="knowledge-stat-pill" onClick={() => openDetail('document')}>
            <span>{t('knowledgePage.overview.fileType')}</span>
            <strong><RawIdentifier value={document.file_type || 'unknown'} /></strong>
          </button>
          <button
            type="button"
            className={`knowledge-stat-pill ${activeContentView === 'sections' ? 'is-active' : ''}`}
            aria-pressed={activeContentView === 'sections'}
            onClick={() => setActiveContentView('sections')}
          >
            <span>{t('knowledgePage.overview.sectionsTitle')}</span>
            <strong>{wikiIndexGroups.length}</strong>
          </button>
          <button
            type="button"
            className={`knowledge-stat-pill ${activeContentView === 'wiki' ? 'is-active' : ''}`}
            aria-pressed={activeContentView === 'wiki'}
            onClick={() => setActiveContentView('wiki')}
          >
            <span>{t('knowledgePage.overview.wikiTitle')}</span>
            <strong>{okfConcepts.length}</strong>
          </button>
          <button
            type="button"
            className={`knowledge-stat-pill ${activeContentView === 'evidence' ? 'is-active' : ''}`}
            aria-pressed={activeContentView === 'evidence'}
            onClick={() => setActiveContentView('evidence')}
          >
            <span>{t('knowledgePage.overview.evidenceTitle')}</span>
            <strong>{totalChunkCount}</strong>
          </button>
        </div>
      </div>

      <div className={cn('knowledge-overview-panel', activeContentView === 'wiki' && wikiPresentation === 'graph' && 'is-graph')}>
        <div className="knowledge-overview-panel-head">
          <span>
            <strong>{activeContent.title}</strong>
            <small>{activeContent.description}</small>
          </span>
          <div className="knowledge-overview-panel-actions">
            {activeContentView === 'wiki' && (
              <div className="knowledge-graph-view-switch" aria-label={t('knowledgePage.overview.wikiPresentationAria')}>
                <button
                  type="button"
                  className={wikiPresentation === 'graph' ? 'is-active' : ''}
                  aria-pressed={wikiPresentation === 'graph'}
                  onClick={() => setWikiPresentation('graph')}
                >
                  {t('knowledgePage.overview.graphView')}
                </button>
                <button
                  type="button"
                  className={wikiPresentation === 'cards' ? 'is-active' : ''}
                  aria-pressed={wikiPresentation === 'cards'}
                  onClick={() => setWikiPresentation('cards')}
                >
                  {t('knowledgePage.overview.cardView')}
                </button>
              </div>
            )}
            <KTag>{activeContent.count}</KTag>
            <button
              type="button"
              className="text-[13px] text-[#1a71ff] transition-colors hover:text-[#4a8dff]"
              onClick={() => openContentDetail(activeContentView)}
            >
              {t('knowledgePage.overview.viewAll')}
            </button>
          </div>
        </div>
        {activeContentView === 'wiki' && wikiPresentation === 'graph' ? (
          <Suspense fallback={<div className="kgv-empty">{t('knowledgePage.overview.loading')}</div>}>
            <KnowledgeGraphVisualization
              concepts={okfConcepts}
              knowledgeBaseKey={knowledgeBase?.id || document.knowledge_base_id}
              onViewConcept={onViewConcept}
            />
          </Suspense>
        ) : (
          <>
            {activeContentView === 'sections' && (
              <div className="knowledge-layer-explain" aria-label={t('knowledgePage.overview.layerExplainAria')}>
                <span>
                  <strong>{t('knowledgePage.overview.sectionsTitle')}</strong>
                  <small>{t('knowledgePage.overview.sectionsExplain')}</small>
                </span>
                <span>
                  <strong>{t('knowledgePage.overview.wikiTitle')}</strong>
                  <small>{t('knowledgePage.overview.wikiExplain')}</small>
                </span>
              </div>
            )}
            <div className="knowledge-mini-list">
              {activeContent.items.length === 0 ? (
                <span className="knowledge-empty-note">{activeContent.emptyText}</span>
              ) : (
                activeContent.items.map((entry) => (
                  <button
                    type="button"
                    className="knowledge-mini-item"
                    key={`${activeContentView}-${entry.key}`}
                    onClick={() => {
                      if (activeContentView === 'sections' && entry.indexGroup) {
                        openContentDetail('sections', entry.indexGroup.key);
                        return;
                      }
                      if ((activeContentView === 'sections' || activeContentView === 'wiki') && entry.concept) {
                        onViewConcept(entry.concept);
                        return;
                      }
                      if (activeContentView === 'evidence' && entry.bucket) {
                        openContentDetail('evidence', entry.bucket.id);
                        return;
                      }
                      openContentDetail(activeContentView, entry.key);
                    }}
                    title={
                      activeContentView === 'sections' && entry.indexGroup
                        ? t('knowledgePage.overview.viewSectionGraph')
                        : (activeContentView === 'sections' || activeContentView === 'wiki') && entry.concept
                          ? t('knowledgePage.overview.viewWiki')
                          : activeContentView === 'evidence'
                            ? t('knowledgePage.overview.viewEvidence')
                          : t('knowledgePage.actions.details')
                    }
                  >
                    <strong><RawContent value={entry.title} /></strong>
                    <small><RawContent value={entry.summary} /></small>
                  </button>
                ))
              )}
            </div>
          </>
        )}
      </div>

      <KDialog
        open={Boolean(detailView)}
        title={knowledgeDetailTitle(detailView)}
        width={detailView === 'sections' || detailView === 'wiki' ? 'min(1240px, calc(100vw - 56px))' : 920}
        className={`knowledge-detail-modal${detailView === 'sections' ? ' knowledge-detail-modal-sections' : ''}`}
        onClose={() => setDetailView(null)}
      >
        {detailView === 'document' && (
          <div className="knowledge-detail-stack">
            <div className="knowledge-detail-header">
              <div>
                <span className="text-[13px] text-[#858b9c]">{t('knowledgePage.overview.documentCard')}</span>
                <h4 className="my-[4px] text-[16px] font-semibold text-foreground"><RawContent value={documentTitle} /></h4>
              </div>
              {canEdit && (
                <UIButton variant="outline" className={OUTLINE_ACTION_BUTTON_SM_CLASS} onClick={() => onEditDocument(document)}>
                  <EditOutlined />
                  {t('common.action.edit')}
                </UIButton>
              )}
            </div>
            <section className="knowledge-document-md-panel">
              <div className="knowledge-document-md-panel-head">
                <strong>{t('knowledgePage.overview.documentCard')}</strong>
                <KTag><RawIdentifier value={document.file_type || 'unknown'} /></KTag>
              </div>
              <div className="knowledge-document-md-scroll is-summary">
                <MarkdownPreview markdown={documentSummary} />
              </div>
            </section>
            <section className="knowledge-document-md-panel">
              <div className="knowledge-document-md-panel-head">
                <strong>{t('knowledgePage.overview.sourceMaterial')}</strong>
                <KTag>{t('knowledgePage.overview.sectionCount', { count: Array.isArray(metadata.section_tree) ? metadata.section_tree.length : 0 })}</KTag>
              </div>
              <div className="knowledge-document-md-scroll is-source">
                <MarkdownPreview markdown={sourceMarkdown || t('knowledgePage.overview.noSourceMaterial')} />
              </div>
            </section>
            <div className="knowledge-evidence-stat is-inline">
              <strong><RawIdentifier value={document.file_type || 'unknown'} /></strong>
              <span>{t('knowledgePage.overview.fileType')}</span>
            </div>
            <div className="knowledge-document-meta">
              <button type="button" className="knowledge-stat-pill" onClick={() => openDetail('sections')}>
                <span>{t('knowledgePage.overview.sectionsTitle')}</span>
                <strong>{wikiIndexGroups.length}</strong>
              </button>
              <button type="button" className="knowledge-stat-pill" onClick={() => openDetail('wiki')}>
                <span>{t('knowledgePage.overview.wikiTitle')}</span>
                <strong>{okfConcepts.length}</strong>
              </button>
              <button type="button" className="knowledge-stat-pill" onClick={() => openDetail('evidence')}>
                <span>{t('knowledgePage.overview.evidenceTitle')}</span>
                <strong>{totalChunkCount}</strong>
              </button>
            </div>
          </div>
        )}

        {detailView === 'sections' && (
          <div className="knowledge-wiki-map">
            {wikiIndexGroups.length === 0 ? (
              <EmptyState description={t('knowledgePage.overview.sectionsDetailEmpty')} />
            ) : (
              wikiIndexGroups.map((group) => (
                <section
                  className="knowledge-wiki-map-card knowledge-index-group knowledge-detail-target"
                  key={group.key}
                  data-detail-key={group.key}
                >
                  <div className="knowledge-index-group-head">
                    <div>
                      <KTag color="green">{t('knowledgePage.overview.sectionsTitle')}</KTag>
                      <strong><RawContent value={group.title} /></strong>
                      <small><RawContent value={group.description} /></small>
                    </div>
                    <KTag>{t('knowledgePage.overview.pageCount', { count: group.concepts.length })}</KTag>
                  </div>
                  <div className="knowledge-index-page-list">
                    {group.concepts.slice(0, 8).map((concept) => (
                      <button type="button" key={concept.id} onClick={() => onViewConcept(concept)}>
                        <span>{concept.title ? <RawContent value={concept.title} /> : <RawIdentifier value={concept.concept_id} />}</span>
                        <small>
                          {conceptTypeLabel(concept.concept_type)}
                          {' · '}
                          {concept.description ? <RawContent value={concept.description} /> : <RawIdentifier value={concept.concept_id} />}
                        </small>
                      </button>
                    ))}
                  </div>
                </section>
              ))
            )}
          </div>
        )}

        {detailView === 'evidence' && (
          <div className="knowledge-concept-list">
            {evidenceBuckets.length === 0 ? (
              <EmptyState description={t('knowledgePage.overview.evidenceEmpty')} />
            ) : (
              evidenceBuckets.map((bucket) => {
                const contentMarkdown = bucketContentMarkdown(bucket);
                return (
                  <section
                    className="knowledge-concept-card knowledge-detail-target"
                    key={bucket.id}
                    data-detail-key={bucket.id}
                  >
                    <div className="knowledge-concept-card-head">
                      <div>
                        <div className="flex flex-wrap items-center gap-[8px]">
                          <KTag color="green">{t('knowledgePage.overview.evidenceTitle')}</KTag>
                          {bucketStatusTag(bucket)}
                          <KTag>{t('knowledgePage.overview.chunkCount', { count: bucket.chunk_count })}</KTag>
                        </div>
                        <h5 className="mt-[6px] mb-0 text-[15px] font-semibold text-foreground">
                          {bucket.title
                            ? <RawContent value={bucket.title} />
                            : <RawIdentifier value={bucket.bucket_key || t('knowledgePage.evidence.defaultTitle')} />}
                        </h5>
                      </div>
                      <UIButton
                        variant="outline"
                        size="sm"
                        onClick={() => onEditBucket(bucket)}
                      >
                        <EditOutlined />
                        {t('common.action.edit')}
                      </UIButton>
                    </div>
                    {bucket.summary ? (
                      <p className="my-[6px] text-[13px] leading-[1.65] text-[#858b9c]"><RawContent value={bucket.summary} /></p>
                    ) : null}
                    <KnowledgeBucketLinks bucket={bucket} evidenceOnly />
                    <section className="mt-[12px] rounded-[14px] border border-[#eceef1] bg-white p-[14px]">
                      <MarkdownPreview markdown={contentMarkdown || t('knowledgePage.overview.noEvidenceContent')} />
                    </section>
                  </section>
                );
              })
            )}
          </div>
        )}

        {detailView === 'wiki' && (
          <div className="knowledge-concept-list">
            {okfConcepts.length === 0 ? (
              <EmptyState description={t('knowledgePage.overview.wikiEmpty')} />
            ) : (
              <>
                <div className="knowledge-graph-view-switch">
                  <button
                    type="button"
                    className={`knowledge-graph-view-btn${wikiViewMode === 'graph' ? ' is-active' : ''}`}
                    onClick={() => setWikiViewMode('graph')}
                  >
                    {t('knowledgePage.overview.graphMode')}
                  </button>
                  <button
                    type="button"
                    className={`knowledge-graph-view-btn${wikiViewMode === 'cards' ? ' is-active' : ''}`}
                    onClick={() => setWikiViewMode('cards')}
                  >
                    {t('knowledgePage.overview.cardMode')}
                  </button>
                </div>
                {wikiViewMode === 'graph' ? (
                  <KnowledgeGraphCanvas concepts={okfConcepts} onSelectConcept={onViewConcept} />
                ) : (
                  okfConcepts.map((concept) => (
                    <div
                      className="knowledge-concept-card knowledge-detail-target"
                      key={concept.id}
                      data-detail-key={concept.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => onViewConcept(concept)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          onViewConcept(concept);
                        }
                      }}
                    >
                      <div className="knowledge-concept-card-head">
                        <div>
                          <div className="flex flex-wrap items-center gap-[8px]">
                            <KTag color={conceptTypeColor(concept.concept_type)}>{conceptTypeLabel(concept.concept_type)}</KTag>
                            {statusTag(concept.status)}
                          </div>
                          <h5 className="mt-[6px] mb-0 text-[15px] font-semibold text-foreground">
                            {concept.title ? <RawContent value={concept.title} /> : <RawIdentifier value={concept.concept_id} />}
                          </h5>
                        </div>
                        <UIButton
                          variant="outline"
                          size="sm"
                          onClick={(event) => {
                            event.stopPropagation();
                            onEditConcept(concept);
                          }}
                        >
                          <EditOutlined />
                          {t('common.action.edit')}
                        </UIButton>
                      </div>
                      <p className="my-[6px] text-[13px] text-[#858b9c]">
                        {concept.description ? <RawContent value={concept.description} /> : conceptSummary(concept)}
                      </p>
                      <div className="flex flex-wrap items-center gap-[6px]">
                        <KTag><RawIdentifier value={concept.concept_id} /></KTag>
                        <KTag>{t('knowledgePage.wiki.linkCount', { count: concept.links.length })}</KTag>
                        <KTag>{t('knowledgePage.wiki.citationCount', { count: concept.citations.length })}</KTag>
                        {concept.document_id ? <KTag>{t('knowledgePage.wiki.sourceDocument')} <RawIdentifier value={concept.document_id} /></KTag> : null}
                      </div>
                    </div>
                  ))
                )}
              </>
            )}
          </div>
        )}

      </KDialog>
    </div>
  );
}

function WikiViewerTitle({ concept }: { concept: KnowledgeConceptRead }) {
  const { t } = useAppIntl();
  return (
    <div className="flex min-w-0 flex-col gap-[4px]">
      <span className="text-[13px] font-semibold text-[#1a71ff]">{conceptTypeLabel(concept.concept_type)}</span>
      <strong className="line-clamp-2 text-[20px] font-semibold leading-[1.35] text-[#18181a]">
        {concept.title ? <RawContent value={concept.title} /> : <RawIdentifier value={concept.concept_id} />}
      </strong>
      <small className="font-mono text-[12px] wrap-break-word text-[#858b9c]">
        {t('knowledgePage.wiki.pathLabel')} <RawIdentifier value={concept.concept_id} />
      </small>
    </div>
  );
}

function WikiConceptViewer({ concept }: { concept: KnowledgeConceptRead }) {
  const { locale, t } = useAppIntl();
  const body = stripOkfFrontmatter(concept.content_md || '');
  const tags = Array.isArray(concept.frontmatter?.tags) ? concept.frontmatter.tags : [];
  const citations = Array.isArray(concept.citations) ? concept.citations : [];
  const links = Array.isArray(concept.links) ? concept.links : [];
  const sourceRefs = Array.isArray(concept.source_refs) ? concept.source_refs : [];
  return (
    <div className="flex min-w-0 flex-col gap-[18px]">
      <section className="flex flex-col gap-[10px] rounded-[16px] border border-[#1a71ff]/18 bg-[#f5f8ff] p-[18px]">
        <div className="flex flex-wrap items-center gap-[8px]">
          <KTag color={conceptTypeColor(concept.concept_type)}>{conceptTypeLabel(concept.concept_type)}</KTag>
          {statusTag(concept.status)}
          {tags.slice(0, 5).map((tag) => (
            <KTag key={String(tag)}><RawContent value={String(tag)} /></KTag>
          ))}
        </div>
        <h3 className="text-[20px] font-semibold text-[#18181a]">{concept.title ? <RawContent value={concept.title} /> : <RawIdentifier value={concept.concept_id} />}</h3>
        <p className="text-[14px] leading-[1.65] text-[#18181a]">{concept.description ? <RawContent value={concept.description} /> : conceptSummary(concept)}</p>
      </section>

      <section className="grid min-w-0 gap-[10px] grid-cols-[repeat(auto-fit,minmax(160px,1fr))]" aria-label={t('knowledgePage.wiki.metaAria')}>
        {[
          { key: 'path', label: t('knowledgePage.conceptEditor.path'), value: <RawIdentifier value={concept.concept_id} /> },
          { key: 'links', label: t('knowledgePage.conceptEditor.links'), value: t('knowledgePage.conceptEditor.linkCount', { count: links.length }) },
          { key: 'citations', label: t('knowledgePage.conceptEditor.citations'), value: t('knowledgePage.conceptEditor.citationCount', { count: citations.length }) },
          { key: 'updatedAt', label: t('knowledgePage.conceptEditor.updatedAt'), value: formatDateTime(concept.updated_at, locale, t) },
        ].map((item) => (
          <div
            key={item.key}
            className="flex min-w-0 flex-col gap-[6px] overflow-hidden rounded-[14px] border border-[#eceef1] bg-white px-[14px] py-[13px]"
          >
            <span className="text-[12px] font-semibold text-[#858b9c]">{item.label}</span>
            <strong className="wrap-break-word text-[14px] text-[#18181a]">{item.value}</strong>
          </div>
        ))}
      </section>

      <section className="rounded-[16px] border border-[#eceef1] bg-white p-[18px]">
        <MarkdownPreview markdown={body || t('knowledgePage.wiki.emptyBody')} />
      </section>

      {(links.length > 0 || citations.length > 0 || sourceRefs.length > 0) && (
        <section className="grid min-w-0 grid-cols-1 gap-[10px] xl:grid-cols-3" aria-label={t('knowledgePage.wiki.relationsAria')}>
          {links.length > 0 && (
            <div className="flex min-w-0 flex-col gap-[10px] overflow-hidden rounded-[14px] border border-[#eceef1] bg-white p-[14px]">
              <strong className="text-[13px] font-semibold text-[#18181a]">{t('knowledgePage.wiki.relatedPages')}</strong>
              <div className="flex max-h-[220px] min-w-0 max-w-full flex-wrap gap-[6px] overflow-x-hidden overflow-y-auto pr-[2px]">
                {links.slice(0, 12).map((item, index) => (
                  <KnowledgeRelationChip key={`link-${index}`}><RawIdentifier value={recordLabel(item, ['target', 'concept_id', 'id'])} /></KnowledgeRelationChip>
                ))}
              </div>
            </div>
          )}
          {citations.length > 0 && (
            <div className="flex min-w-0 flex-col gap-[10px] overflow-hidden rounded-[14px] border border-[#eceef1] bg-white p-[14px]">
              <strong className="text-[13px] font-semibold text-[#18181a]">{t('knowledgePage.wiki.citations')}</strong>
              <div className="flex max-h-[220px] min-w-0 max-w-full flex-wrap gap-[6px] overflow-x-hidden overflow-y-auto pr-[2px]">
                {citations.slice(0, 12).map((item, index) => (
                  <KnowledgeRelationChip key={`citation-${index}`}><RawIdentifier value={recordLabel(item, ['label', 'source', 'uri', 'id'])} /></KnowledgeRelationChip>
                ))}
              </div>
            </div>
          )}
          {sourceRefs.length > 0 && (
            <div className="flex min-w-0 flex-col gap-[10px] overflow-hidden rounded-[14px] border border-[#eceef1] bg-white p-[14px]">
              <strong className="text-[13px] font-semibold text-[#18181a]">{t('knowledgePage.wiki.sources')}</strong>
              <div className="flex max-h-[220px] min-w-0 max-w-full flex-wrap gap-[6px] overflow-x-hidden overflow-y-auto pr-[2px]">
                {sourceRefs.slice(0, 12).map((item, index) => (
                  <KnowledgeRelationChip key={`source-${index}`}><RawIdentifier value={recordLabel(item, ['document_id', 'section_id', 'source', 'id'])} /></KnowledgeRelationChip>
                ))}
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function MarkdownPreview({ markdown }: { markdown: string }) {
  const { t } = useAppIntl();
  const normalized = normalizeMarkdownForDisplay(markdown);
  return (
    <div className="knowledge-markdown-preview">
      {renderMarkdownBlocks(normalized || t('knowledgePage.placeholder.noContent'))}
    </div>
  );
}

function stripOkfFrontmatter(markdown: string) {
  return markdown.replace(/^---\s*\n[\s\S]*?\n---\s*/, '').trim();
}

function recordLabel(item: unknown, keys: string[]) {
  if (!isRecord(item)) return String(item || 'unknown');
  for (const key of keys) {
    const value = item[key];
    if (value) return String(value);
  }
  return JSON.stringify(item);
}

function KnowledgeRelationChip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-block min-w-0 max-w-full rounded-[6px] bg-[#f2f3f5] px-[8px] py-px text-[12px] font-medium leading-[18px] whitespace-normal wrap-anywhere text-[#5b6273]">
      {children}
    </span>
  );
}

function KnowledgeBucketLinks({ bucket, evidenceOnly = false }: { bucket: KnowledgeBucketRead; evidenceOnly?: boolean }) {
  const { t } = useAppIntl();
  const sourceSections = bucketSourceSections(bucket);
  const representativeChunks = bucketRepresentativeChunks(bucket);
  return (
    <div className="knowledge-bucket-link-grid">
      {!evidenceOnly && (
        <>
          <span className="text-[13px] text-[#858b9c]">{t('knowledgePage.bucketLinks.coveredSources')}</span>
          <div>
            {sourceSections.length === 0 ? (
              <KTag>{t('knowledgePage.bucketLinks.noSourcePath')}</KTag>
            ) : (
              sourceSections.map((section) => <KTag key={String(section)}><RawIdentifier value={String(section)} /></KTag>)
            )}
          </div>
        </>
      )}
      <span className="text-[13px] text-[#858b9c]">{evidenceOnly ? t('knowledgePage.bucketLinks.evidenceSources') : t('knowledgePage.bucketLinks.representativeSources')}</span>
      <div className="knowledge-evidence-token-list">
        {representativeChunks.length === 0 ? (
          bucket.chunk_count > 0 ? <KTag>{t('knowledgePage.bucketLinks.evidenceCount', { count: bucket.chunk_count })}</KTag> : <KTag>{t('knowledgePage.bucketLinks.noRepresentativeSource')}</KTag>
        ) : (
          representativeChunks.map((chunkId) => <KTag key={String(chunkId)}><RawIdentifier value={String(chunkId)} /></KTag>)
        )}
      </div>
    </div>
  );
}

function knowledgeDetailTitle(view: KnowledgeDetailView | null) {
  const { t } = currentKnowledgeTranslator();
  if (view === 'document') return t('knowledgePage.detail.document');
  if (view === 'sections') return t('knowledgePage.detail.sections');
  if (view === 'wiki') return t('knowledgePage.detail.wiki');
  if (view === 'evidence') return t('knowledgePage.detail.evidence');
  return t('knowledgePage.detail.default');
}

function bucketSourceSections(bucket: KnowledgeBucketRead) {
  const bucketMeta = bucket.metadata || {};
  if (Array.isArray(bucketMeta.section_paths)) return bucketMeta.section_paths;
  if (Array.isArray(bucketMeta.section_ids)) return bucketMeta.section_ids;
  return [];
}

function bucketRepresentativeChunks(bucket: KnowledgeBucketRead) {
  const representativeChunks = Array.isArray(bucket.metadata?.representative_chunk_ids)
    ? bucket.metadata.representative_chunk_ids
    : [];
  return representativeChunks
    .map((chunkId) => String(chunkId || '').trim())
    .filter((chunkId) => chunkId.length > 0 && !/^k?chunk_[a-f0-9]{8,}$/i.test(chunkId))
    .slice(0, 12);
}

function bucketContentMarkdown(bucket: KnowledgeBucketRead): string {
  const metadata = bucket.metadata || {};
  const content = stringFromMetadata(metadata.content).trim();
  if (content) return content;
  const excerpt = stringFromMetadata(metadata.excerpt).trim();
  if (excerpt) return excerpt;
  return bucket.summary || '';
}

function previewRepresentativeChunkIds(buckets: KnowledgeBucketRead[]) {
  const ids: string[] = [];
  buckets.forEach((bucket) => {
    ids.push(...bucketRepresentativeChunks(bucket));
  });
  return Array.from(new Set(ids)).slice(0, 3);
}

function previewEvidenceItems(buckets: KnowledgeBucketRead[], chunkCount: number, limit: number) {
  const { t } = currentKnowledgeTranslator();
  const bucketItems = buckets
    .filter((bucket) => bucket.chunk_count > 0)
    .slice(0, limit)
    .map((bucket) => {
      const sourceSections = bucketSourceSections(bucket)
        .map((section) => String(section))
        .filter(Boolean)
        .slice(0, 2);
      const contentPreview = bucketContentMarkdown(bucket).replace(/\s+/g, ' ').trim().slice(0, 180);
      return {
        key: bucket.id,
        title: bucket.title || bucket.bucket_key || t('knowledgePage.evidence.defaultTitle'),
        summary: contentPreview || (sourceSections.length
          ? t('knowledgePage.evidence.bucketSummaryWithSources', { count: bucket.chunk_count, sources: sourceSections.join(' / ') })
          : t('knowledgePage.evidence.bucketSummary', { count: bucket.chunk_count })),
        bucket,
      };
    });
  if (bucketItems.length > 0) return bucketItems;

  const representativeChunkIds = previewRepresentativeChunkIds(buckets);
  if (representativeChunkIds.length > 0) {
    return representativeChunkIds.map((chunkId) => ({
      key: chunkId,
      title: chunkId,
      summary: t('knowledgePage.evidence.representativeSummary'),
    }));
  }

  if (chunkCount > 0) {
    return [
      {
        key: 'chunk-total',
        title: t('knowledgePage.evidence.ingestedTitle'),
        summary: t('knowledgePage.evidence.ingestedSummary', { count: chunkCount }),
      },
    ];
  }

  return [];
}

function KnowledgeSearchDebug({
  result,
  loading,
  compact = false,
}: {
  result: KnowledgeSearchResponse | null;
  loading: boolean;
  compact?: boolean;
}) {
  const { t } = useAppIntl();
  if (loading) {
    return <span className="text-[13px] text-[#858b9c]">{t('knowledgePage.searchDebug.running')}</span>;
  }
  if (!result) {
    return <EmptyState description={t('knowledgePage.searchDebug.notRun')} />;
  }
  const selectedConcepts = result.selected_concepts || [];
  const okfCitations = result.okf_citations || [];
  return (
    <div className={`knowledge-search-debug${compact ? ' is-compact' : ''}`}>
      <div className="knowledge-route-trace">
        {(result.route_trace || result.trace || []).map((item, index) => (
          <div className="knowledge-route-step" key={`${String(item.phase || 'phase')}-${index}`}>
            <span>{index + 1}</span>
            <div>
              <strong>{knowledgeRouteLabel(item, t)}</strong>
            </div>
          </div>
        ))}
      </div>
      <Accordion type="multiple" className="flex flex-col gap-[6px]">
        <AccordionItem value="concepts">
          <AccordionTrigger>{t('knowledgePage.searchDebug.concepts', { count: selectedConcepts.length })}</AccordionTrigger>
          <AccordionContent>
            <pre className="knowledge-json">{JSON.stringify(selectedConcepts, null, 2)}</pre>
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="okf-citations">
          <AccordionTrigger>{t('knowledgePage.searchDebug.okfCitations', { count: okfCitations.length })}</AccordionTrigger>
          <AccordionContent>
            <pre className="knowledge-json">{JSON.stringify(okfCitations, null, 2)}</pre>
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="documents">
          <AccordionTrigger>{t('knowledgePage.searchDebug.documents', { count: result.selected_documents.length })}</AccordionTrigger>
          <AccordionContent>
            <pre className="knowledge-json">{JSON.stringify(result.selected_documents, null, 2)}</pre>
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="sections">
          <AccordionTrigger>{t('knowledgePage.searchDebug.sections', { count: result.expanded_sections.length })}</AccordionTrigger>
          <AccordionContent>
            <pre className="knowledge-json">{JSON.stringify(result.expanded_sections, null, 2)}</pre>
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="evidence">
          <AccordionTrigger>{t('knowledgePage.searchDebug.evidence', { count: result.evidence_pack.length })}</AccordionTrigger>
          <AccordionContent>
            <div className="knowledge-evidence-list">
              {result.evidence_pack.map((item) => (
                <div className="knowledge-evidence-item" key={item.chunk_id}>
                  <strong className="text-[13px] font-semibold text-foreground"><RawIdentifier value={item.section_path || item.source_path || item.chunk_id} /></strong>
                  <p className="m-0 text-[13px] text-foreground"><RawContent value={item.excerpt} /></p>
                  {item.confidence_reason && (
                    <span className="text-[13px] text-[#858b9c]"><RawContent value={item.confidence_reason} /></span>
                  )}
                </div>
              ))}
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}

function DiscoveryColumn({
  title,
  description,
  items,
  readonly = false,
  onConfirm,
  onReject,
}: {
  title: string;
  description: string;
  items: KnowledgeDiscoveryRead[];
  readonly?: boolean;
  onConfirm: (item: KnowledgeDiscoveryRead) => Promise<void>;
  onReject: (item: KnowledgeDiscoveryRead) => Promise<void>;
}) {
  const { t } = useAppIntl();
  return (
    <div className="knowledge-discovery-column">
      <div className="knowledge-section-heading">
        <div>
          <strong>{title}</strong>
          <span>{description}</span>
        </div>
        <KTag>{items.length}</KTag>
      </div>
      {items.length === 0 ? (
        <EmptyState description={t('knowledgePage.placeholder.noContent')} />
      ) : (
        <div className="knowledge-discovery-list flex flex-col gap-[12px]">
          {items.map((item) => (
            <div className={`knowledge-discovery ${item.suggestion_type}`} key={item.id}>
              <div className="knowledge-discovery-header">
                <div className="flex flex-wrap items-center gap-[8px]">
                  <strong className="text-[14px] font-semibold text-foreground"><RawContent value={item.title} /></strong>
                  <KTag>{typeLabel(item.suggestion_type)}</KTag>
                  {statusTag(item.status)}
                </div>
                {!readonly && item.status === 'pending' && (
                  <div className="flex items-center gap-[8px]">
                    <UIButton variant="outline" size="icon" className="size-8 rounded-full" onClick={() => void onConfirm(item)}>
                      <CheckOutlined />
                    </UIButton>
                    <UIButton variant="outline" size="icon" className="size-8 rounded-full" onClick={() => void onReject(item)}>
                      <CloseOutlined />
                    </UIButton>
                  </div>
                )}
              </div>
              {item.reason && <p className="my-[6px] text-[13px] text-[#858b9c]"><RawContent value={item.reason} /></p>}
              <Accordion type="single" collapsible>
                <AccordionItem value="payload" className="border-b-0">
                  <AccordionTrigger className="py-[6px]">{t('knowledgePage.overview.viewAll')}</AccordionTrigger>
                  <AccordionContent>
                    <pre className="knowledge-json">{JSON.stringify(item.payload, null, 2)}</pre>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function isEmptyDefaultKnowledgeBase(item: KnowledgeBaseRead) {
  const hasRuntimeKnowledge = item.document_count > 0 || item.bucket_count > 0 || item.chunk_count > 0;
  if (!hasRuntimeKnowledge && item.metadata?.created_from_document_upload && !item.metadata?.source_document_id) {
    return true;
  }
  return (
    item.name === '\u9ed8\u8ba4\u77e5\u8bc6\u5e93' &&
    item.document_count === 0 &&
    item.bucket_count === 0 &&
    item.chunk_count === 0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function statusTag(status: string) {
  const { t } = currentKnowledgeTranslator();
  const map: Record<string, { color: string; label: string }> = {
    active: { color: 'green', label: t('knowledgePage.status.active') },
    published: { color: 'green', label: t('knowledgePage.status.published') },
    archived: { color: 'default', label: t('knowledgePage.status.archived') },
    draft: { color: 'default', label: t('knowledgePage.status.draft') },
    succeeded: { color: 'green', label: t('knowledgePage.status.succeeded') },
    ready: { color: 'green', label: t('knowledgePage.status.ready') },
    confirmed: { color: 'green', label: t('knowledgePage.status.confirmed') },
    failed: { color: 'red', label: t('knowledgePage.status.failed') },
    pending: { color: 'gold', label: t('knowledgePage.status.pending') },
    running: { color: 'processing', label: t('knowledgePage.status.running') },
    queued: { color: 'gold', label: t('knowledgePage.status.queued') },
    cancel_requested: { color: 'gold', label: t('knowledgePage.status.cancelRequested') },
    cancelled: { color: 'default', label: t('knowledgePage.status.cancelled') },
  };
  const item = map[status] || { color: 'gold', label: status };
  return <KTag color={item.color}>{item.label}</KTag>;
}

function bucketStatusTag(bucket: KnowledgeBucketRead) {
  const { t } = currentKnowledgeTranslator();
  if (bucket.status === 'ready') return <KTag color="green">{t('knowledgePage.status.ready')}</KTag>;
  return <KTag color="gold">{t('knowledgePage.status.needsSupplement')}</KTag>;
}

const KTAG_TONE_CLASS: Record<string, string> = {
  green: 'bg-[#eafbf0] text-[#018434]',
  red: 'bg-[#fce7e7] text-[#d20b0b]',
  gold: 'bg-[#fff4e0] text-[#c47d09]',
  processing: 'bg-[#e6f0ff] text-[#1a71ff]',
  blue: 'bg-[#e6f0ff] text-[#1a71ff]',
  geekblue: 'bg-[#eceaffe6] text-[#3538cd]',
  cyan: 'bg-[#e0fbff] text-[#0891a5]',
  purple: 'bg-[#f2e9ff] text-[#7a35cd]',
  magenta: 'bg-[#ffe9f4] text-[#c41d7f]',
  default: 'bg-[#f2f3f5] text-[#5b6273]',
};

function KTag({ color = 'default', children }: { color?: string; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-[4px] rounded-[6px] px-[8px] py-px text-[12px] font-medium leading-[18px]',
        KTAG_TONE_CLASS[color] || KTAG_TONE_CLASS.default,
      )}
    >
      {children}
    </span>
  );
}

function KCard({
  className,
  bodyClassName,
  title,
  extra,
  children,
  ...rest
}: {
  className?: string;
  bodyClassName?: string;
  title?: ReactNode;
  extra?: ReactNode;
  children?: ReactNode;
} & Omit<HTMLAttributes<HTMLDivElement>, 'title'>) {
  return (
    <section
      className={cn(
        'overflow-hidden rounded-[14px] border border-[#eceef1] bg-white',
        className,
      )}
      {...rest}
    >
      {(title || extra) && (
        <div className="flex min-h-[54px] items-center justify-between gap-[12px] border-b border-[#eceef1] px-[20px] py-[10px]">
          <div className="min-w-0 text-[14px] font-medium text-[#18181a]">{title}</div>
          {extra ? <div className="shrink-0 text-[#858b9c]">{extra}</div> : null}
        </div>
      )}
      <div className={cn('p-[20px]', bodyClassName)}>{children}</div>
    </section>
  );
}

function KDialogCancelButton({
  children,
  className,
  ...props
}: React.ComponentProps<typeof UIButton>) {
  const { t } = useAppIntl();
  return (
    <UIButton variant="outline" className={cn(DIALOG_CANCEL_BUTTON_CLASS, className)} {...props}>
      {children ?? t('common.action.cancel')}
    </UIButton>
  );
}

function KDialogPrimaryButton({
  children,
  className,
  ...props
}: React.ComponentProps<typeof UIButton>) {
  return (
    <UIButton className={cn(DIALOG_PRIMARY_BUTTON_CLASS, className)} {...props}>
      {children}
    </UIButton>
  );
}

function KDialog({
  open,
  title,
  width,
  className,
  footer,
  onClose,
  children,
}: {
  open: boolean;
  title: ReactNode;
  width?: number | string;
  className?: string;
  footer?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        aria-describedby={undefined}
        style={width ? { maxWidth: typeof width === 'number' ? `${width}px` : width } : undefined}
        className={cn(
          'flex max-h-[calc(100dvh-4rem)] w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden rounded-[16px] p-0 sm:max-w-[560px]',
          className,
        )}
      >
        <DialogTitle className="px-[24px] py-[16px] text-[16px] font-semibold text-foreground" asChild={typeof title !== 'string'}>
          {typeof title === 'string' ? title : <div>{title}</div>}
        </DialogTitle>
        <div className="min-h-0 flex-1 overflow-y-auto px-[24px] pb-[16px]">{children}</div>
        {footer ? <div className={DIALOG_FOOTER_CLASS}>{footer}</div> : null}
      </DialogContent>
    </Dialog>
  );
}

function EmptyState({ description }: { description: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-[6px] py-[36px] text-center text-[13px] text-[#858b9c]">
      {description}
    </div>
  );
}

function FileDropzone({
  accept,
  multiple = false,
  disabled = false,
  onFiles,
  children,
}: {
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
  onFiles: (files: File[]) => void;
  children: ReactNode;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const emit = (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    onFiles(multiple ? files : files.slice(0, 1));
  };
  return (
    <div
      role="button"
      tabIndex={0}
      aria-disabled={disabled}
      className={cn(
        'flex cursor-pointer flex-col items-center justify-center rounded-[12px] border border-dashed border-border bg-(--surface-subtle) px-[16px] py-[28px] text-center transition-colors',
        dragActive && 'border-[#1a71ff] bg-[#1a71ff]/5',
        disabled && 'cursor-not-allowed opacity-60',
      )}
      onClick={() => !disabled && inputRef.current?.click()}
      onKeyDown={(event) => {
        if (disabled) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          inputRef.current?.click();
        }
      }}
      onDragOver={(event) => {
        event.preventDefault();
        if (!disabled) setDragActive(true);
      }}
      onDragLeave={() => setDragActive(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragActive(false);
        if (!disabled) emit(event.dataTransfer.files);
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        className="hidden"
        onChange={(event) => {
          emit(event.target.files);
          event.target.value = '';
        }}
      />
      {children}
    </div>
  );
}

function conceptPath(conceptId: string) {
  return conceptId
    .split('/')
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join('/');
}

function conceptTypeLabel(type: string) {
  const { t } = currentKnowledgeTranslator();
  const map: Record<string, string> = {
    'Source Document': t('knowledgePage.conceptType.sourceDocument'),
    'Source Section': t('knowledgePage.conceptType.sourceSection'),
    Topic: t('knowledgePage.conceptType.topic'),
    Playbook: t('knowledgePage.conceptType.playbook'),
    'Business Rule': t('knowledgePage.conceptType.businessRule'),
    'Query Analysis': t('knowledgePage.conceptType.queryAnalysis'),
  };
  return map[type] || type || t('knowledgePage.conceptType.default');
}

function conceptTypeColor(type: string) {
  const map: Record<string, string> = {
    'Source Document': 'blue',
    'Source Section': 'cyan',
    Topic: 'green',
    Playbook: 'purple',
    'Business Rule': 'gold',
    'Query Analysis': 'magenta',
  };
  return map[type] || 'default';
}

/** Sort knowledge concepts with the active UI locale for stable, user-facing ordering. */
function sortWikiConcepts(concepts: KnowledgeConceptRead[], locale: AppLocale) {
  const rank: Record<string, number> = {
    'Source Document': 0,
    'Source Section': 1,
    Topic: 2,
    Playbook: 3,
    'Business Rule': 4,
    'Query Analysis': 5,
  };
  return [...concepts].sort((left, right) => {
    const leftRank = rank[left.concept_type] ?? 99;
    const rightRank = rank[right.concept_type] ?? 99;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return (left.title || left.concept_id).localeCompare(right.title || right.concept_id, locale);
  });
}

/** Build wiki index groups while preserving the locale used for their concept ordering. */
function buildWikiIndexGroups(concepts: KnowledgeConceptRead[], locale: AppLocale): WikiIndexGroup[] {
  const groupMap = new Map<string, WikiIndexGroup>();
  concepts.forEach((concept) => {
    const key = wikiIndexGroupKey(concept);
    const existing = groupMap.get(key);
    if (existing) {
      existing.concepts.push(concept);
      existing.description = wikiIndexGroupDescription(existing.concepts);
      return;
    }
    groupMap.set(key, {
      key,
      title: wikiIndexGroupTitle(concept),
      description: wikiIndexGroupDescription([concept]),
      concepts: [concept],
    });
  });
  return Array.from(groupMap.values()).map((group) => ({
    ...group,
    concepts: sortWikiConcepts(group.concepts, locale),
  }));
}

function wikiIndexGroupKey(concept: KnowledgeConceptRead) {
  const sourceDocument = stringFromMetadata(concept.frontmatter?.source_document);
  if (sourceDocument) return `source:${sourceDocument}`;
  const firstSource = concept.source_refs.find((item) => isRecord(item) && (item.source_document || item.document_id));
  if (isRecord(firstSource)) {
    const label = String(firstSource.source_document || firstSource.document_id || '').trim();
    if (label) return `source:${label}`;
  }
  return `type:${concept.concept_type || 'knowledge-graph'}`;
}

function wikiIndexGroupTitle(concept: KnowledgeConceptRead) {
  const sourceDocument = stringFromMetadata(concept.frontmatter?.source_document);
  if (sourceDocument) return sourceDocument.replace(/^sources\//, '');
  const firstSource = concept.source_refs.find((item) => isRecord(item) && (item.source_document || item.document_id));
  if (isRecord(firstSource)) {
    const label = String(firstSource.source_document || firstSource.document_id || '').trim();
    if (label) return label.replace(/^sources\//, '');
  }
  return conceptTypeLabel(concept.concept_type);
}

function wikiIndexGroupDescription(concepts: KnowledgeConceptRead[]) {
  const { t } = currentKnowledgeTranslator();
  const types = Array.from(new Set(concepts.map((concept) => conceptTypeLabel(concept.concept_type)).filter(Boolean))).slice(0, 4);
  const samples = concepts
    .map((concept) => concept.title || concept.concept_id)
    .filter(Boolean)
    .slice(0, 3);
  const typeText = types.length ? types.join('、') : t('knowledgePage.detail.wiki');
  const sampleText = samples.length ? t('knowledgePage.wikiGroup.samples', { samples: samples.join(' / ') }) : '';
  return t('knowledgePage.wikiGroup.description', { count: concepts.length, types: typeText, samples: sampleText });
}

function conceptSummary(concept: KnowledgeConceptRead) {
  const { t } = currentKnowledgeTranslator();
  const body = concept.content_md.replace(/^---[\s\S]*?---\s*/m, '').replace(/[#>*_\-[\]()`]/g, ' ').trim();
  return body.length > 160 ? `${body.slice(0, 160)}...` : body || t('knowledgeGraph.summary.empty');
}

function okfFrontmatterValue(markdown: string, key: string, fallback = '') {
  const frontmatter = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatter) return fallback;
  const line = frontmatter[1].split('\n').find((item) => item.trim().startsWith(`${key}:`));
  if (!line) return fallback;
  const raw = line.slice(line.indexOf(':') + 1).trim();
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'string' ? parsed : String(parsed);
  } catch {
    return raw.replace(/^['"]|['"]$/g, '');
  }
}

function updateOkfFrontmatterValue(markdown: string, key: string, value: string) {
  const normalizedValue = JSON.stringify(value);
  const frontmatter = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatter) {
    return `---\n${key}: ${normalizedValue}\n---\n\n${markdown}`;
  }
  const lines = frontmatter[1].split('\n');
  const index = lines.findIndex((line) => line.trim().startsWith(`${key}:`));
  if (index >= 0) {
    lines[index] = `${key}: ${normalizedValue}`;
  } else {
    lines.push(`${key}: ${normalizedValue}`);
  }
  return markdown.replace(/^---\n[\s\S]*?\n---/, `---\n${lines.join('\n')}\n---`);
}

/** Format a knowledge timestamp using the caller's active locale without consulting global state. */
function formatDateTime(value: string, locale: AppLocale, t: KnowledgeTranslate) {
  if (!value) return t('knowledgePage.time.unknown');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(locale, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function typeLabel(type: string) {
  const { t } = currentKnowledgeTranslator();
  if (type === 'skill') return t('knowledgePage.discoveryType.skill');
  if (type === 'tool') return t('knowledgePage.discoveryType.tool');
  return t('knowledgePage.discoveryType.default');
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const { t } = currentKnowledgeTranslator();
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(t('knowledgePage.add.error.readFile')));
    reader.onload = () => {
      const result = String(reader.result || '');
      resolve(result.includes(',') ? result.split(',').pop() || '' : result);
    };
    reader.readAsDataURL(file);
  });
}
