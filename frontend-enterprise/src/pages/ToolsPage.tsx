import { ApiOutlined, CheckOutlined, ExperimentOutlined, ToolOutlined } from '../icons';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Activity, Copy, FlaskConical, RotateCcw, TerminalSquare, Users, XCircle } from 'lucide-react';
import { pinyin } from 'pinyin-pro';

import { createTenantClient, type TenantClient } from '../api/tenant-client';
import { isEnterpriseAdmin, type EnterpriseAuthUser } from '../auth';
import { useTenantSession, type TenantSessionContextValue } from '../contexts/TenantSessionContext';
import AppHeader from '@/components/AppHeader';
import CapabilityScopeLoading from '@/components/CapabilityScopeLoading';
import {
  CapabilityScopeBadge,
  CapabilityScopeControl,
  normalizeCapabilityScope,
} from '@/components/CapabilityScopeControl';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { DataTable, type DataTableColumn } from '@/components/DataTable';
import { Paginator } from '@/components/Paginator';
import { ResourceImportDialog } from '@/components/ResourceImportDialog';
import { StatCard } from '@/components/StatCard';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Checkbox,
  Input,
  Select as UISelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
} from '@/components/ui';
import { Button as UIButton } from '@/components/ui/button';
import { createToastNotifier } from '@/components/ui/app-toast';
import { createMessageDescriptor, type MessageDescriptor } from '@/i18n/descriptors';
import { RawContent, RawIdentifier } from '@/i18n/RawContent';
import type { MessageId, MessageValues } from '@/i18n';
import { useAppIntl } from '@/i18n/useAppIntl';
import { backendErrorMessageDescriptor } from '@/lib/apiErrorMessages';
import { cn } from '@/lib/utils';
import { announceEnterpriseCapabilityCatalogChange } from '@/lib/capability-catalog-events';
import {
  MENU_CONTENT_CLASS,
  MENU_ITEM_CLASS,
  MENU_ITEM_DANGER_CLASS,
  MOBILE_CARD_CLASS,
  SELECT_TRIGGER_CLASS,
} from '@/lib/enterprise-ui';
import { getClientTimeZone, parseBackendDateTime } from '@/lib/timezone';
import CodeBlock from '../components/CodeBlock';
import IconAdd from '../assets/icons/add.svg?react';
import IconArrowRight from '../assets/icons/arrow-right.svg?react';
import IconBriefcase from '../assets/icons/cap-briefcase.svg?react';
import IconChevronDown from '../assets/icons/chevron-down.svg?react';
import IconClear from '../assets/icons/field-clear.svg?react';
import IconEdit from '../assets/icons/edit.svg?react';
import IconMore from '../assets/icons/more.svg?react';
import IconRefresh from '../assets/icons/refresh.svg?react';
import IconSearch from '../assets/icons/search.svg?react';
import IconTool from '../assets/icons/plaza-tool.svg?react';
import IconTrash from '../assets/icons/trash.svg?react';
import {
  canManageEmployeeAgent,
  openGalleryAgentId,
  openGalleryImportSourceOptions,
  resourceCreatorName,
  visibleEmployeeAgents,
} from '../employee';
import { useClientPagination } from '../hooks/useClientPagination';
import {
  emitAgentScopeChange,
  isTeamScope,
  readEmployeeScope,
} from '../lib/agent-scope-storage';
import { StatusBadge } from './scheduled-tasks/StatusBadge';
import type {
  AgentProfileRead,
  A2ATaskRunRead,
  CapabilityScope,
  CodexA2AAdapterRead,
  ToolRead,
  MCPServerRead,
  MCPServerConnection,
  MCPDiscoverResponse,
  MCPSyncResponse,
  MCPAuthMode,
  MCPAppsMode,
  MCPOAuthStartResult,
  MCPOAuthStatusRead,
  MCPTransport,
  MCPDiscoveredTool,
} from '../types';

type ToolPageProps = {
  currentUser?: EnterpriseAuthUser;
  onLogout?: () => void;
};

const TOOLS_MESSAGE_IDS = {
  titleMarketplace: 'toolsPage.title.marketplace',
  titleScoped: 'toolsPage.title.scoped',
  listTools: 'toolsPage.list.tools',
  listEmployeeTools: 'toolsPage.list.employeeTools',
  actionRefresh: 'toolsPage.action.refresh',
  actionCreate: 'toolsPage.action.create',
  actionMenu: 'toolsPage.action.menu',
  actionEdit: 'toolsPage.action.edit',
  actionTest: 'toolsPage.action.test',
  actionDelete: 'toolsPage.action.delete',
  actionRemove: 'toolsPage.action.remove',
  actionBack: 'toolsPage.action.back',
  actionOpenTest: 'toolsPage.action.openTest',
  actionSave: 'toolsPage.action.save',
  actionDiscover: 'toolsPage.action.discover',
  actionSync: 'toolsPage.action.sync',
  actionOAuthConnect: 'toolsPage.action.oauthConnect',
  actionOAuthReconnect: 'toolsPage.action.oauthReconnect',
  actionOAuthDisconnect: 'toolsPage.action.oauthDisconnect',
  actionCancel: 'toolsPage.action.cancel',
  actionProbe: 'toolsPage.action.probe',
  statsTotal: 'toolsPage.stats.total',
  statsEnabled: 'toolsPage.stats.enabled',
  statsBuckets: 'toolsPage.stats.buckets',
  statsAria: 'toolsPage.stats.aria',
  listAria: 'toolsPage.list.aria',
  pagination: 'toolsPage.list.pagination',
  searchLabel: 'toolsPage.search.label',
  searchPlaceholder: 'toolsPage.search.placeholder',
  searchClear: 'toolsPage.search.clear',
  bucketFilter: 'toolsPage.search.bucketFilter',
  bucketFilterAll: 'toolsPage.search.bucketFilterAll',
  selectTool: 'toolsPage.accessibility.selectTool',
  statusUnbucketed: 'toolsPage.status.unbucketed',
  statusToolGroup: 'toolsPage.status.toolGroup',
  statusEnabled: 'toolsPage.status.enabled',
  statusDisabled: 'toolsPage.status.disabled',
  statusMcpNegotiated: 'toolsPage.status.mcpNegotiated',
  statusMcpPending: 'toolsPage.status.mcpPending',
  statusMcpDisabled: 'toolsPage.status.mcpDisabled',
  statusConnected: 'toolsPage.status.connected',
  statusNotEnabled: 'toolsPage.status.notEnabled',
  statusCredentialConfigured: 'toolsPage.status.credentialConfigured',
  statusCredentialMissing: 'toolsPage.status.credentialMissing',
  statusImported: 'toolsPage.status.imported',
  statusNotImported: 'toolsPage.status.notImported',
  statusOAuthDisconnected: 'toolsPage.oauth.status.disconnected',
  statusOAuthAuthorizing: 'toolsPage.oauth.status.authorizing',
  statusOAuthConnected: 'toolsPage.oauth.status.connected',
  statusOAuthReconnectRequired: 'toolsPage.oauth.status.reconnectRequired',
  serverHeading: 'toolsPage.server.heading',
  serverList: 'toolsPage.server.list',
  serverName: 'toolsPage.server.name',
  serverTransport: 'toolsPage.server.transport',
  serverAppsMode: 'toolsPage.server.appsMode',
  serverEndpoint: 'toolsPage.server.endpoint',
  serverToolCount: 'toolsPage.server.toolCount',
  serverEmpty: 'toolsPage.server.empty',
  serverDeleteTitle: 'toolsPage.confirm.deleteServerTitle',
  serverDeleteDescription: 'toolsPage.confirm.deleteServerDescription',
  serverRemoveDescription: 'toolsPage.confirm.removeServerDescription',
  toolName: 'toolsPage.table.toolName',
  bucket: 'toolsPage.table.bucket',
  type: 'toolsPage.table.type',
  capabilityScope: 'toolsPage.table.capabilityScope',
  creator: 'toolsPage.table.creator',
  method: 'toolsPage.table.method',
  url: 'toolsPage.table.url',
  enabled: 'toolsPage.table.enabled',
  actions: 'toolsPage.table.actions',
  importTitlePlaza: 'toolsPage.import.title.plaza',
  importTitleEmployee: 'toolsPage.import.title.employee',
  importTargetLabel: 'toolsPage.import.targetLabel',
  importTargetPlaceholder: 'toolsPage.import.targetPlaceholder',
  importSourcePlazaPlaceholder: 'toolsPage.import.sourcePlazaPlaceholder',
  importSourceEmployeePlaceholder: 'toolsPage.import.sourceEmployeePlaceholder',
  importItemsLabel: 'toolsPage.import.itemsLabel',
  importEmpty: 'toolsPage.import.empty',
  importNotePlaza: 'toolsPage.import.note.plaza',
  importNoteEmployee: 'toolsPage.import.note.employee',
  importSourceGallery: 'toolsPage.import.sourceGallery',
  importNewBlank: 'toolsPage.import.newBlank',
  importFromPlaza: 'toolsPage.import.fromPlaza',
  importFromEmployee: 'toolsPage.import.fromEmployee',
  confirmDeleteToolTitle: 'toolsPage.confirm.deleteToolTitle',
  confirmRemoveToolTitle: 'toolsPage.confirm.removeToolTitle',
  confirmDeleteToolDescription: 'toolsPage.confirm.deleteToolDescription',
  confirmRemoveToolDescription: 'toolsPage.confirm.removeToolDescription',
  emptyToolsAdmin: 'toolsPage.empty.toolsAdmin',
  emptyTools: 'toolsPage.empty.tools',
  emptyEmployeeTools: 'toolsPage.empty.employeeTools',
  editorNewTitle: 'toolsPage.editor.newTitle',
  editorEditTitle: 'toolsPage.editor.editTitle',
  editorNewMcpTitle: 'toolsPage.editor.newMcpTitle',
  editorEditMcpTitle: 'toolsPage.editor.editMcpTitle',
  editorDescriptionNew: 'toolsPage.editor.description.new',
  editorDescriptionEdit: 'toolsPage.editor.description.edit',
  editorDescriptionTest: 'toolsPage.editor.description.test',
  editorDescriptionMcp: 'toolsPage.editor.description.mcp',
  sectionDefinition: 'toolsPage.section.definition',
  sectionInfo: 'toolsPage.section.info',
  sectionConnection: 'toolsPage.section.connection',
  sectionDiscovery: 'toolsPage.section.discovery',
  sectionOAuth: 'toolsPage.section.oauth',
  sectionProbe: 'toolsPage.section.probe',
  sectionCallTest: 'toolsPage.section.callTest',
  sectionLoading: 'toolsPage.status.loading',
  fieldToolType: 'toolsPage.field.toolType',
  fieldName: 'toolsPage.field.name',
  fieldDisplayName: 'toolsPage.field.displayName',
  fieldDescription: 'toolsPage.field.description',
  fieldBucket: 'toolsPage.field.bucket',
  fieldHttpMethod: 'toolsPage.field.httpMethod',
  fieldUrl: 'toolsPage.field.url',
  fieldA2AEndpoint: 'toolsPage.field.a2aEndpoint',
  fieldTimeout: 'toolsPage.field.timeout',
  fieldHeaders: 'toolsPage.field.headers',
  fieldAuth: 'toolsPage.field.auth',
  fieldInputSchema: 'toolsPage.field.inputSchema',
  fieldOutputSchema: 'toolsPage.field.outputSchema',
  fieldAllowedSkills: 'toolsPage.field.allowedSkills',
  fieldToolId: 'toolsPage.field.toolId',
  fieldInputCount: 'toolsPage.field.inputCount',
  fieldOutputCount: 'toolsPage.field.outputCount',
  fieldLastUpdated: 'toolsPage.field.lastUpdated',
  fieldMcpName: 'toolsPage.field.mcpName',
  fieldMcpDisplayName: 'toolsPage.field.mcpDisplayName',
  fieldMcpDescription: 'toolsPage.field.mcpDescription',
  fieldMcpBucket: 'toolsPage.field.mcpBucket',
  fieldMcpUrl: 'toolsPage.field.mcpUrl',
  fieldMcpHeaders: 'toolsPage.field.mcpHeaders',
  fieldMcpAuthMode: 'toolsPage.field.mcpAuthMode',
  fieldMcpOAuthClientId: 'toolsPage.field.mcpOAuthClientId',
  fieldMcpOAuthClientMetadataUrl: 'toolsPage.field.mcpOAuthClientMetadataUrl',
  fieldMcpOAuthRedirectUri: 'toolsPage.field.mcpOAuthRedirectUri',
  fieldCommand: 'toolsPage.field.command',
  fieldArgs: 'toolsPage.field.args',
  fieldEnv: 'toolsPage.field.env',
  fieldCwd: 'toolsPage.field.cwd',
  fieldTransport: 'toolsPage.field.transport',
  fieldEnabledTool: 'toolsPage.field.enabledTool',
  fieldEnabledToolGroup: 'toolsPage.field.enabledToolGroup',
  fieldInvocationAddress: 'toolsPage.field.invocationAddress',
  fieldInputSchemaPanel: 'toolsPage.field.inputSchemaPanel',
  fieldOutputSchemaPanel: 'toolsPage.field.outputSchemaPanel',
  hintMcpNameLocked: 'toolsPage.hint.mcpNameLocked',
  hintMcpNameRules: 'toolsPage.hint.mcpNameRules',
  hintMcpArgs: 'toolsPage.hint.mcpArgs',
  hintMcpCwd: 'toolsPage.hint.mcpCwd',
  hintMcpAuthMode: 'toolsPage.hint.mcpAuthMode',
  hintMcpOAuthPublicOnly: 'toolsPage.hint.mcpOAuthPublicOnly',
  hintMcpOAuthStatus: 'toolsPage.hint.mcpOAuthStatus',
  hintEnabledToolGroup: 'toolsPage.hint.enabledToolGroup',
  hintEnabledTool: 'toolsPage.hint.enabledTool',
  hintA2AAgentCard: 'toolsPage.hint.a2aAgentCard',
  hintA2AForceAgentCard: 'toolsPage.hint.a2aForceAgentCard',
  hintA2AStreaming: 'toolsPage.hint.a2aStreaming',
  hintA2ASubscribe: 'toolsPage.hint.a2aSubscribe',
  hintAdvancedConfig: 'toolsPage.hint.advancedConfig',
  typeHttp: 'toolsPage.type.http',
  typeA2A: 'toolsPage.type.a2a',
  typeMcp: 'toolsPage.type.mcp',
  typeHttpDescription: 'toolsPage.typeDescription.http',
  typeA2ADescription: 'toolsPage.typeDescription.a2a',
  typeMcpDescription: 'toolsPage.typeDescription.mcp',
  transportStreamableHttp: 'toolsPage.transport.streamableHttp',
  transportSse: 'toolsPage.transport.sse',
  transportStdio: 'toolsPage.transport.stdio',
  transportBuiltin: 'toolsPage.transport.builtin',
  transportStreamableHttpHint: 'toolsPage.transportHint.streamableHttp',
  transportSseHint: 'toolsPage.transportHint.sse',
  transportStdioHint: 'toolsPage.transportHint.stdio',
  transportBuiltinHint: 'toolsPage.transportHint.builtin',
  appsEnabled: 'toolsPage.apps.enabled',
  appsDisabled: 'toolsPage.apps.disabled',
  appsToggleAria: 'toolsPage.apps.toggleAria',
  appsProtocol: 'toolsPage.apps.protocol',
  appsProtocolHint: 'toolsPage.apps.protocolHint',
  appsValueOn: 'toolsPage.apps.valueOn',
  appsValueOff: 'toolsPage.apps.valueOff',
  appsOnly: 'toolsPage.apps.only',
  appsModelAndApp: 'toolsPage.apps.modelAndApp',
  oauthModeNone: 'toolsPage.oauth.mode.none',
  oauthModePersonal: 'toolsPage.oauth.mode.personal',
  a2aHeading: 'toolsPage.a2a.heading',
  a2aCodexAdapter: 'toolsPage.a2a.codexAdapter',
  a2aStandardAgent: 'toolsPage.a2a.standardAgent',
  a2aAdapterSummary: 'toolsPage.a2a.adapterSummary',
  a2aPersistenceHint: 'toolsPage.a2a.persistenceHint',
  a2aEmpty: 'toolsPage.a2a.empty',
  a2aRunSummary: 'toolsPage.a2a.runSummary',
  a2aRecoveryCount: 'toolsPage.a2a.recoveryCount',
  a2aTimeline: 'toolsPage.a2a.timeline',
  a2aPersistedState: 'toolsPage.a2a.persistedState',
  a2aStatusSubmitted: 'toolsPage.a2a.status.submitted',
  a2aStatusWorking: 'toolsPage.a2a.status.working',
  a2aStatusCompleted: 'toolsPage.a2a.status.completed',
  a2aStatusFailed: 'toolsPage.a2a.status.failed',
  a2aStatusCanceled: 'toolsPage.a2a.status.canceled',
  a2aStatusRejected: 'toolsPage.a2a.status.rejected',
  a2aStatusInputRequired: 'toolsPage.a2a.status.inputRequired',
  a2aDiscoverAgentCard: 'toolsPage.a2a.discoverAgentCard',
  a2aRequireAgentCard: 'toolsPage.a2a.requireAgentCard',
  a2aStreaming: 'toolsPage.a2a.streaming',
  a2aSubscribe: 'toolsPage.a2a.subscribe',
  a2aAgentCardOptional: 'toolsPage.a2a.agentCardOptional',
  a2aPollInterval: 'toolsPage.a2a.pollInterval',
  a2aAdvancedConfig: 'toolsPage.a2a.advancedConfig',
  discoveryDescription: 'toolsPage.discovery.description',
  discoveryDescriptionSaved: 'toolsPage.discovery.descriptionSaved',
  discoveryEmpty: 'toolsPage.discovery.empty',
  discoveryListAria: 'toolsPage.discovery.listAria',
  discoveryTool: 'toolsPage.discovery.tool',
  discoveryDescriptionColumn: 'toolsPage.discovery.descriptionColumn',
  discoveryApp: 'toolsPage.discovery.app',
  discoveryStatus: 'toolsPage.discovery.status',
  toastLoadToolsFailed: 'toolsPage.toast.loadToolsFailed',
  toastDeleteTool: 'toolsPage.toast.deleteTool',
  toastRemoveTool: 'toolsPage.toast.removeTool',
  toastDeleteFailed: 'toolsPage.toast.deleteFailed',
  toastRemoveFailed: 'toolsPage.toast.removeFailed',
  toastNoTargetAgent: 'toolsPage.toast.noTargetAgent',
  toastLoadAgentsFailed: 'toolsPage.toast.loadAgentsFailed',
  toastLoadSourceToolsFailed: 'toolsPage.toast.loadSourceToolsFailed',
  toastTargetRequired: 'toolsPage.toast.targetRequired',
  toastSourcePlazaRequired: 'toolsPage.toast.sourcePlazaRequired',
  toastSourceEmployeeRequired: 'toolsPage.toast.sourceEmployeeRequired',
  toastItemsRequired: 'toolsPage.toast.itemsRequired',
  toastImportComplete: 'toolsPage.toast.importComplete',
  toastImportFailed: 'toolsPage.toast.importFailed',
  toastToolNameRequired: 'toolsPage.toast.toolNameRequired',
  toastUrlRequired: 'toolsPage.toast.urlRequired',
  toastSaved: 'toolsPage.toast.saved',
  toastSaveFailed: 'toolsPage.toast.saveFailed',
  toastLoadA2ARunsFailed: 'toolsPage.toast.loadA2ARunsFailed',
  toastCancelSubmitted: 'toolsPage.toast.cancelSubmitted',
  toastCancelFailed: 'toolsPage.toast.cancelFailed',
  toastLoadServerFailed: 'toolsPage.toast.loadServerFailed',
  toastMcpNameRequired: 'toolsPage.toast.mcpNameRequired',
  toastDiscoverFailed: 'toolsPage.toast.discoverFailed',
  toastDiscovered: 'toolsPage.toast.discovered',
  toastSaveBeforeSync: 'toolsPage.toast.saveBeforeSync',
  toastSelectToolToSync: 'toolsPage.toast.selectToolToSync',
  toastSyncFailed: 'toolsPage.toast.syncFailed',
  toastSynced: 'toolsPage.toast.synced',
  toastOAuthStatusFailed: 'toolsPage.toast.oauthStatusFailed',
  toastOAuthStartFailed: 'toolsPage.toast.oauthStartFailed',
  toastOAuthDisconnectFailed: 'toolsPage.toast.oauthDisconnectFailed',
  toastOAuthDisconnected: 'toolsPage.toast.oauthDisconnected',
  toastOAuthCompleted: 'toolsPage.toast.oauthCompleted',
  toastOAuthDenied: 'toolsPage.toast.oauthDenied',
  toastOAuthExpired: 'toolsPage.toast.oauthExpired',
  toastOAuthCallbackFailed: 'toolsPage.toast.oauthCallbackFailed',
  toastProbeFailed: 'toolsPage.toast.probeFailed',
  toastInvalidProbeArguments: 'toolsPage.toast.invalidProbeArguments',
  toastQueryArgumentRule: 'toolsPage.toast.queryArgumentRule',
  toastCallFailed: 'toolsPage.toast.callFailed',
  toastJsonConfigInvalid: 'toolsPage.toast.jsonConfigInvalid',
  toastHeadersEnvInvalid: 'toolsPage.toast.headersEnvInvalid',
  placeholderMcpDisplayName: 'toolsPage.placeholder.mcpDisplayName',
  placeholderMcpName: 'toolsPage.placeholder.mcpName',
  placeholderMcpUrl: 'toolsPage.placeholder.mcpUrl',
  placeholderMcpOAuthClientId: 'toolsPage.placeholder.mcpOAuthClientId',
  placeholderMcpOAuthClientMetadataUrl: 'toolsPage.placeholder.mcpOAuthClientMetadataUrl',
  placeholderMcpOAuthRedirectUri: 'toolsPage.placeholder.mcpOAuthRedirectUri',
  placeholderMcpCommand: 'toolsPage.placeholder.mcpCommand',
  placeholderMcpArgs: 'toolsPage.placeholder.mcpArgs',
  placeholderMcpCwd: 'toolsPage.placeholder.mcpCwd',
  placeholderA2ACardUrl: 'toolsPage.placeholder.a2aCardUrl',
  placeholderA2AConfig: 'toolsPage.placeholder.a2aConfig',
  placeholderMcpDescription: 'toolsPage.placeholder.mcpDescription',
  placeholderMcpBucket: 'toolsPage.placeholder.mcpBucket',
  placeholderToolName: 'toolsPage.placeholder.toolName',
  placeholderToolUrl: 'toolsPage.placeholder.toolUrl',
  placeholderToolA2AUrl: 'toolsPage.placeholder.toolA2AUrl',
  placeholderAllowedSkills: 'toolsPage.placeholder.allowedSkills',
  placeholderToolDisplayName: 'toolsPage.placeholder.toolDisplayName',
  placeholderToolBucket: 'toolsPage.placeholder.toolBucket',
  placeholderToolDescription: 'toolsPage.placeholder.toolDescription',
  hintTimeout: 'toolsPage.hint.timeout',
  hintAllowedSkills: 'toolsPage.hint.allowedSkills',
  mcpNoDescription: 'toolsPage.mcp.noDescription',
  a2aConnectionTitle: 'toolsPage.a2a.connectionTitle',
  a2aConnectionDescription: 'toolsPage.a2a.connectionDescription',
  a2aCodexConnect: 'toolsPage.a2a.codexConnect',
  a2aCodexDisabled: 'toolsPage.a2a.codexDisabled',
  probeDescription: 'toolsPage.probe.description',
  probeArgumentsGet: 'toolsPage.probe.argumentsGet',
  probeArgumentsBody: 'toolsPage.probe.argumentsBody',
  probeGetHint: 'toolsPage.probe.getHint',
  probeBodyHint: 'toolsPage.probe.bodyHint',
  probeResult: 'toolsPage.probe.result',
  savedTestTitle: 'toolsPage.savedTest.title',
  savedTestDescription: 'toolsPage.savedTest.description',
  savedTestArguments: 'toolsPage.savedTest.arguments',
  savedTestResult: 'toolsPage.savedTest.result',
  savedTestReturned: 'toolsPage.savedTest.returned',
  savedTestWaiting: 'toolsPage.savedTest.waiting',
  savedTestEmpty: 'toolsPage.savedTest.empty',
  savedTestInvoke: 'toolsPage.savedTest.invoke',
  protocolHttp: 'toolsPage.protocol.http',
  protocolA2A: 'toolsPage.protocol.a2a',
  protocolMcp: 'toolsPage.protocol.mcp',
  rawDescription: 'toolsPage.raw.description',
} as const satisfies Record<string, MessageId>;

/** 精确识别旧版本写入数据库的界面文案哨兵；所有其他分桶名称均作为业务原文保留。 */
const LEGACY_UNBUCKETED_BUCKET_MARKER = '未分桶';

type ToolsTranslate = (id: MessageId, values?: MessageValues) => string;

/** 只允许请求所属租户代次仍有效时的回调更新页面或发出提示。 */
function isCurrentTenantRequest(
  context: TenantSessionContextValue | null,
  generation: number,
  controller: AbortController,
): boolean {
  return Boolean(
    context
    && !controller.signal.aborted
    && !context.signal.aborted
    && context.isCurrentGeneration(generation),
  );
}

/** 将稳定后端错误投影为工具页 descriptor；未知异常只展示本地化 fallback，不透传 raw message。 */
function toolErrorDescriptor(error: unknown, fallbackId: MessageId): MessageDescriptor {
  const descriptor = backendErrorMessageDescriptor(error);
  return descriptor
    ? { id: descriptor.messageId, values: descriptor.values }
    : createMessageDescriptor(fallbackId);
}

/** 按当前 UI locale 与客户端时区格式化后端时间戳；无效值使用无语言依赖的短横线。 */
function formatToolsDateTime(value: string | undefined, locale: string): string {
  if (!value) return '—';
  const date = parseBackendDateTime(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : new Intl.DateTimeFormat(locale, {
      dateStyle: 'short',
      timeStyle: 'short',
      timeZone: getClientTimeZone(),
    }).format(date);
}

/** 按当前 UI locale 格式化纯数字字段，避免在业务组件中散落地区参数。 */
function formatToolsNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(value);
}

const TOOL_PAGE_SIZE = 10;
const TOOL_FORM_INITIAL_VALUES = {
  tool_type: 'http' as 'http' | 'a2a' | 'mcp',
  method: 'POST',
  enabled: true,
  bucket: '',
  headers: '{}',
  auth: '{}',
  mcp_config: '{}',
  input_schema: '{}',
  output_schema: '{}',
  timeout_seconds: 8,
  capability_scope: 'general' as CapabilityScope,
};

type ToolFormValues = typeof TOOL_FORM_INITIAL_VALUES & {
  name?: string;
  display_name?: string;
  description?: string;
  allowed_skills?: string;
  url?: string;
};

const TRANSPORT_OPTIONS: { value: MCPTransport; labelId: MessageId; hintId: MessageId }[] = [
  {
    value: 'streamable_http',
    labelId: TOOLS_MESSAGE_IDS.transportStreamableHttp,
    hintId: TOOLS_MESSAGE_IDS.transportStreamableHttpHint,
  },
  {
    value: 'sse',
    labelId: TOOLS_MESSAGE_IDS.transportSse,
    hintId: TOOLS_MESSAGE_IDS.transportSseHint,
  },
  {
    value: 'stdio',
    labelId: TOOLS_MESSAGE_IDS.transportStdio,
    hintId: TOOLS_MESSAGE_IDS.transportStdioHint,
  },
  {
    value: 'builtin',
    labelId: TOOLS_MESSAGE_IDS.transportBuiltin,
    hintId: TOOLS_MESSAGE_IDS.transportBuiltinHint,
  },
];

export default function ToolsPage({ currentUser, onLogout }: ToolPageProps = {}) {
  const { locale, t } = useAppIntl();
  const toast = createToastNotifier({ t });
  const tenantContext = useTenantSession();
  const tenantClient = useMemo(() => createTenantClient(tenantContext), [tenantContext]);
  const tenantId = tenantContext?.tenantId || '';
  const userId = tenantContext?.userId || '';
  const [rows, setRows] = useState<ToolRead[]>([]);
  const [agentId, setAgentId] = useState(
    () => tenantId && userId ? readEmployeeScope(tenantId, userId) : '',
  );
  const [isOverallAgent, setIsOverallAgent] = useState(true);
  const [agentScopeLoaded, setAgentScopeLoaded] = useState(false);
  const [bucketFilter, setBucketFilter] = useState('__all__');
  const [searchText, setSearchText] = useState('');
  const [loading, setLoading] = useState(false);
  const [agents, setAgents] = useState<AgentProfileRead[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [importMode, setImportMode] = useState<'plaza' | 'employee'>('plaza');
  const [importTargetAgentId, setImportTargetAgentId] = useState('');
  const [importSourceAgentId, setImportSourceAgentId] = useState('');
  const [importSourceTools, setImportSourceTools] = useState<ToolRead[]>([]);
  const [importSelectedToolIds, setImportSelectedToolIds] = useState<string[]>([]);
  const [importLoading, setImportLoading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ToolRead | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [servers, setServers] = useState<MCPServerRead[]>([]);
  const [serverDeleteTarget, setServerDeleteTarget] = useState<MCPServerRead | null>(null);
  const [deletingServer, setDeletingServer] = useState(false);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const loadControllerRef = useRef<AbortController | null>(null);
  const agentScopeControllerRef = useRef<AbortController | null>(null);
  const deleteControllerRef = useRef<AbortController | null>(null);
  const serverDeleteControllerRef = useRef<AbortController | null>(null);
  const importAgentsControllerRef = useRef<AbortController | null>(null);
  const importSourceControllerRef = useRef<AbortController | null>(null);
  const importSubmitControllerRef = useRef<AbortController | null>(null);

  useEffect(() => () => {
    [
      loadControllerRef,
      agentScopeControllerRef,
      deleteControllerRef,
      serverDeleteControllerRef,
      importAgentsControllerRef,
      importSourceControllerRef,
      importSubmitControllerRef,
    ].forEach((ref) => ref.current?.abort());
  }, [tenantContext?.tenantId, tenantContext?.generation]);

  useEffect(() => {
    setAgentId(tenantId && userId ? readEmployeeScope(tenantId, userId) : '');
    setRows([]);
    setAgents([]);
    setServers([]);
    setAgentScopeLoaded(false);
  }, [tenantId, userId]);

  const pageTitle = t(isOverallAgent ? TOOLS_MESSAGE_IDS.titleMarketplace : TOOLS_MESSAGE_IDS.titleScoped);
  const listLabel = t(isOverallAgent ? TOOLS_MESSAGE_IDS.listTools : TOOLS_MESSAGE_IDS.listEmployeeTools);
  const currentAgent = useMemo(() => agents.find((item) => item.id === agentId), [agents, agentId]);
  const canManageCurrentScope = currentAgent
    ? canManageEmployeeAgent(currentAgent, currentUser)
    : isEnterpriseAdmin(currentUser) && isOverallAgent;
  const canOpenCreateMenu = canManageCurrentScope;

  const agentQuery = agentId ? `&agent_id=${encodeURIComponent(agentId)}` : '';
  const load = () => {
    if (!tenantContext) return Promise.resolve();
    if (!agentScopeLoaded) {
      setRows([]);
      return Promise.resolve();
    }
    const context = tenantContext;
    const generation = context.generation;
    loadControllerRef.current?.abort();
    const controller = new AbortController();
    loadControllerRef.current = controller;
    setLoading(true);
    return Promise.all([
      tenantClient.get<ToolRead[]>(`/api/enterprise/tools?tenant_id=${tenantId}${agentQuery}`, {
        signal: controller.signal,
      }),
      tenantClient
        .get<MCPServerRead[]>(`/api/enterprise/mcp-servers?tenant_id=${tenantId}`, { signal: controller.signal })
        .catch((error) => {
          if (!isCurrentTenantRequest(context, generation, controller)) throw error;
          return [] as MCPServerRead[];
        }),
    ])
      .then(([toolRows, serverRows]) => {
        if (!isCurrentTenantRequest(context, generation, controller)) return;
        setRows(toolRows);
        setServers(serverRows);
      })
      .catch((error) => {
        if (!isCurrentTenantRequest(context, generation, controller)) return;
        console.error('[tools-page] load tools failed', error);
        toast.error(toolErrorDescriptor(error, TOOLS_MESSAGE_IDS.toastLoadToolsFailed));
      })
      .finally(() => {
        if (loadControllerRef.current === controller) loadControllerRef.current = null;
        if (isCurrentTenantRequest(context, generation, controller)) setLoading(false);
      });
  };

  useEffect(() => {
    if (!tenantContext || !agentScopeLoaded) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentQuery, agentScopeLoaded, tenantContext, tenantClient, tenantId]);

  useEffect(() => {
    if (!tenantContext) return;
    const context = tenantContext;
    const generation = context.generation;
    agentScopeControllerRef.current?.abort();
    const controller = new AbortController();
    agentScopeControllerRef.current = controller;
    const loadAgentScope = async () => {
      try {
        const agents = await tenantClient.get<AgentProfileRead[]>(`/api/enterprise/agents?tenant_id=${tenantId}`, {
          signal: controller.signal,
        });
        if (!isCurrentTenantRequest(context, generation, controller)) return;
        setAgents(agents);
        const exactSelectedAgent = agents.find((agent) => agent.id === agentId) || null;
        const selectedAgent = exactSelectedAgent || agents.find((agent) => agent.is_overall) || null;
        if (agentId && !exactSelectedAgent) {
          setAgentId(selectedAgent?.id || '');
        }
        setIsOverallAgent(Boolean(selectedAgent?.is_overall));
        setAgentScopeLoaded(true);
      } catch {
        if (!isCurrentTenantRequest(context, generation, controller)) return;
        setIsOverallAgent(true);
        setAgentScopeLoaded(true);
      } finally {
        if (agentScopeControllerRef.current === controller) agentScopeControllerRef.current = null;
      }
    };
    void loadAgentScope();
    return () => controller.abort();
  }, [agentId, tenantContext, tenantClient, tenantId]);

  useEffect(() => {
    const onScopeChange = (event: Event) => {
      const next = (event as CustomEvent<{ agentId?: string }>).detail?.agentId || '';
      setAgentId(next && !isTeamScope(next) ? next : readEmployeeScope(tenantId, userId));
    };
    window.addEventListener('ultrarag-enterprise-agent-scope-change', onScopeChange);
    return () => window.removeEventListener('ultrarag-enterprise-agent-scope-change', onScopeChange);
  }, [tenantId, userId]);

  useEffect(() => {
    if (searchParams.get('add') !== 'plaza') return;
    if (!agentScopeLoaded) return;
    const resourceId = searchParams.get('resourceId') || undefined;
    void openImportTools('plaza', resourceId);
    const next = new URLSearchParams(searchParams);
    next.delete('add');
    next.delete('resourceId');
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentScopeLoaded, isOverallAgent, searchParams, setSearchParams]);

  useEffect(() => {
    const outcome = searchParams.get('mcp_oauth');
    if (!outcome) return;
    if (outcome === 'completed') {
      toast.success(createMessageDescriptor(TOOLS_MESSAGE_IDS.toastOAuthCompleted));
    } else if (outcome === 'denied') {
      toast.error(createMessageDescriptor(TOOLS_MESSAGE_IDS.toastOAuthDenied));
    } else if (outcome === 'expired') {
      toast.error(createMessageDescriptor(TOOLS_MESSAGE_IDS.toastOAuthExpired));
    } else if (outcome === 'failed') {
      toast.error(createMessageDescriptor(TOOLS_MESSAGE_IDS.toastOAuthCallbackFailed));
    }
    const next = new URLSearchParams(searchParams);
    next.delete('mcp_oauth');
    setSearchParams(next, { replace: true });
    // The callback result is one-time UI state and is removed immediately after projection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, setSearchParams]);

  const visibleRows = useMemo(() => (isOverallAgent ? rows : rows.filter((row) => row.enabled)), [isOverallAgent, rows]);
  const bucketStats = useMemo(() => buildBucketStats(visibleRows), [visibleRows]);
  const bucketSelectOptions = useMemo(
    () => [
      { value: '__all__', bucket: '', total: 0 },
      ...bucketStats.map((item) => ({ value: item.bucket, bucket: item.bucket, total: item.total })),
    ],
    [bucketStats],
  );
  const filteredRows = useMemo(() => {
    const text = searchText.trim().toLowerCase();
    return visibleRows.filter((row) => {
      const bucketMatch = bucketFilter === '__all__' || (row.bucket || '') === bucketFilter;
      if (!bucketMatch) return false;
      if (!text) return true;
      return [
        row.name,
        row.display_name || '',
        row.description || '',
        row.bucket || '',
        row.url,
        resourceCreatorName(row),
      ].some((value) => value.toLowerCase().includes(text));
    });
  }, [bucketFilter, searchText, visibleRows]);

  const pagination = useClientPagination(filteredRows, TOOL_PAGE_SIZE, `${searchText}|${bucketFilter}|${isOverallAgent}`);

  const stats = useMemo(
    () => ({
      total: visibleRows.length,
      enabled: visibleRows.filter((row) => row.enabled).length,
      buckets: bucketStats.length,
    }),
    [visibleRows, bucketStats],
  );

  // 工具集是租户级的,员工范围内只展示该员工已导入其工具的服务器,数量也按员工可见口径算
  const agentServerToolCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of rows) {
      if (!row.mcp_server_id) continue;
      counts.set(row.mcp_server_id, (counts.get(row.mcp_server_id) || 0) + 1);
    }
    return counts;
  }, [rows]);
  const visibleServers = useMemo(
    () => (isOverallAgent ? servers : servers.filter((row) => agentServerToolCounts.has(row.id))),
    [agentServerToolCounts, isOverallAgent, servers],
  );
  const serverToolCount = (row: MCPServerRead) =>
    isOverallAgent ? row.tool_count : agentServerToolCounts.get(row.id) || 0;

  async function confirmDelete() {
    const row = deleteTarget;
    if (!row) return;
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return;
    deleteControllerRef.current?.abort();
    const controller = new AbortController();
    deleteControllerRef.current = controller;
    setDeleting(true);
    try {
      const agentSuffix = agentId ? `&agent_id=${encodeURIComponent(agentId)}` : '';
      await tenantClient.delete(
        `/api/enterprise/tools/${row.id}?tenant_id=${tenantId}${agentSuffix}`,
        undefined,
        { signal: controller.signal },
      );
      if (!isCurrentTenantRequest(context, generation, controller)) return;
      toast.success(createMessageDescriptor(
        isOverallAgent ? TOOLS_MESSAGE_IDS.toastDeleteTool : TOOLS_MESSAGE_IDS.toastRemoveTool,
      ));
      announceEnterpriseCapabilityCatalogChange({
        resourceType: 'tool',
        agentId: agentId || undefined,
      });
      setDeleteTarget(null);
      await load();
    } catch (error) {
      if (!isCurrentTenantRequest(context, generation, controller)) return;
      console.error('[tools-page] delete tool failed', error);
      toast.error(toolErrorDescriptor(
        error,
        isOverallAgent ? TOOLS_MESSAGE_IDS.toastDeleteFailed : TOOLS_MESSAGE_IDS.toastRemoveFailed,
      ));
    } finally {
      if (deleteControllerRef.current === controller) deleteControllerRef.current = null;
      if (isCurrentTenantRequest(context, generation, controller)) setDeleting(false);
    }
  }

  function handleCreateAction(key: string) {
    if (key === 'blank') {
      navigate('/enterprise/tools/new');
      return;
    }
    if (key === 'mcp') {
      navigate('/enterprise/tools/mcp/new');
      return;
    }
    if (key === 'plaza') {
      void openImportTools('plaza');
      return;
    }
    if (key === 'employee') {
      void openImportTools('employee');
    }
  }

  async function confirmDeleteServer() {
    const row = serverDeleteTarget;
    if (!row || deletingServer) return;
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return;
    serverDeleteControllerRef.current?.abort();
    const controller = new AbortController();
    serverDeleteControllerRef.current = controller;
    setDeletingServer(true);
    try {
      await tenantClient.delete(
        `/api/enterprise/mcp-servers/${row.id}?tenant_id=${tenantId}${agentQuery}&remove_tools=true`,
        undefined,
        { signal: controller.signal },
      );
      if (!isCurrentTenantRequest(context, generation, controller)) return;
      toast.success(createMessageDescriptor(
        isOverallAgent ? TOOLS_MESSAGE_IDS.toastDeleteTool : TOOLS_MESSAGE_IDS.toastRemoveTool,
      ));
      announceEnterpriseCapabilityCatalogChange({
        resourceType: 'tool',
        agentId: agentId || undefined,
      });
      setServerDeleteTarget(null);
      void load();
    } catch (error) {
      if (!isCurrentTenantRequest(context, generation, controller)) return;
      console.error('[tools-page] delete MCP server failed', error);
      toast.error(toolErrorDescriptor(
        error,
        isOverallAgent ? TOOLS_MESSAGE_IDS.toastDeleteFailed : TOOLS_MESSAGE_IDS.toastRemoveFailed,
      ));
    } finally {
      if (serverDeleteControllerRef.current === controller) serverDeleteControllerRef.current = null;
      if (isCurrentTenantRequest(context, generation, controller)) setDeletingServer(false);
    }
  }

  async function openImportTools(mode: 'plaza' | 'employee' = 'plaza', selectedResourceId?: string) {
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return;
    importAgentsControllerRef.current?.abort();
    const controller = new AbortController();
    importAgentsControllerRef.current = controller;
    try {
      const agentRows = agents.length
        ? agents
        : await tenantClient.get<AgentProfileRead[]>(`/api/enterprise/agents?tenant_id=${tenantId}`, {
          signal: controller.signal,
        });
      if (!isCurrentTenantRequest(context, generation, controller)) return;
      setAgents(agentRows);
      setImportMode(mode);
      const targetCandidates = importTargetCandidates(agentRows);
      const nextTargetAgentId =
        targetCandidates.find((item) => item.id === agentId)?.id
        || targetCandidates[0]?.id
        || '';
      if (!nextTargetAgentId) {
        if (!isCurrentTenantRequest(context, generation, controller)) return;
        toast.warning(createMessageDescriptor(TOOLS_MESSAGE_IDS.toastNoTargetAgent));
        return;
      }
      setImportTargetAgentId(nextTargetAgentId);
      const firstSource = mode === 'plaza'
        ? openGalleryAgentId(agentRows)
        : visibleEmployeeAgents(agentRows, currentUser, { activeOnly: true, excludeAgentId: nextTargetAgentId })[0]?.id || '';
      setImportSourceAgentId(firstSource);
      setImportSelectedToolIds([]);
      setImportOpen(true);
      if (firstSource) {
        const sourceRows = await loadImportSourceTools(firstSource);
        if (!isCurrentTenantRequest(context, generation, controller)) return;
        if (selectedResourceId && sourceRows.some((item) => item.id === selectedResourceId)) {
          setImportSelectedToolIds([selectedResourceId]);
        }
      } else {
        setImportSourceTools([]);
      }
    } catch (error) {
      if (!isCurrentTenantRequest(context, generation, controller)) return;
      console.error('[tools-page] load agents failed', error);
      toast.error(toolErrorDescriptor(error, TOOLS_MESSAGE_IDS.toastLoadAgentsFailed));
    } finally {
      if (importAgentsControllerRef.current === controller) importAgentsControllerRef.current = null;
    }
  }

  async function loadImportSourceTools(sourceAgentId: string): Promise<ToolRead[]> {
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return [];
    importSourceControllerRef.current?.abort();
    const controller = new AbortController();
    importSourceControllerRef.current = controller;
    setImportSourceTools([]);
    setImportSelectedToolIds([]);
    if (!sourceAgentId) {
      importSourceControllerRef.current = null;
      return [];
    }
    try {
      const sourceRows = await tenantClient.get<ToolRead[]>(
        `/api/enterprise/tools?tenant_id=${tenantId}&agent_id=${encodeURIComponent(sourceAgentId)}`,
        { signal: controller.signal },
      );
      if (!isCurrentTenantRequest(context, generation, controller)) return [];
      const enabledRows = sourceRows.filter((item) => item.enabled);
      setImportSourceTools(enabledRows);
      return enabledRows;
    } catch (error) {
      if (!isCurrentTenantRequest(context, generation, controller)) return [];
      console.error('[tools-page] load source tools failed', error);
      toast.error(toolErrorDescriptor(error, TOOLS_MESSAGE_IDS.toastLoadSourceToolsFailed));
      return [];
    } finally {
      if (importSourceControllerRef.current === controller) importSourceControllerRef.current = null;
    }
  }

  async function submitImportTools() {
    const targetAgentId = importTargetAgentId || (!isOverallAgent ? agentId : '');
    if (!targetAgentId) {
      toast.warning(createMessageDescriptor(TOOLS_MESSAGE_IDS.toastTargetRequired));
      return;
    }
    if (!importSourceAgentId) {
      toast.warning(createMessageDescriptor(
        importMode === 'plaza'
          ? TOOLS_MESSAGE_IDS.toastSourcePlazaRequired
          : TOOLS_MESSAGE_IDS.toastSourceEmployeeRequired,
      ));
      return;
    }
    if (importSelectedToolIds.length === 0) {
      toast.warning(createMessageDescriptor(TOOLS_MESSAGE_IDS.toastItemsRequired));
      return;
    }
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return;
    importSubmitControllerRef.current?.abort();
    const controller = new AbortController();
    importSubmitControllerRef.current = controller;
    setImportLoading(true);
    try {
      const result = await tenantClient.post<{ imported: Array<Record<string, unknown>>; missing: Array<Record<string, unknown>> }>(
        `/api/enterprise/agents/${targetAgentId}/resources/import`,
        {
          tenant_id: tenantId,
          source_agent_id: importSourceAgentId,
          resource_type: 'tool',
          resource_ids: importSelectedToolIds,
        },
        { signal: controller.signal },
      );
      if (!isCurrentTenantRequest(context, generation, controller)) return;
      const importedCount = result.imported?.length || 0;
      const missingCount = result.missing?.length || 0;
      toast.success(createMessageDescriptor(TOOLS_MESSAGE_IDS.toastImportComplete, {
        importedCount,
        missingCount,
      }));
      announceEnterpriseCapabilityCatalogChange({
        resourceType: 'tool',
        agentId: agentId || undefined,
      });
      setImportOpen(false);
      if (targetAgentId !== agentId) {
        emitAgentScopeChange(targetAgentId);
        setAgentId(targetAgentId);
      } else {
        await load();
      }
    } catch (error) {
      if (!isCurrentTenantRequest(context, generation, controller)) return;
      console.error('[tools-page] import tools failed', error);
      toast.error(toolErrorDescriptor(error, TOOLS_MESSAGE_IDS.toastImportFailed));
    } finally {
      if (importSubmitControllerRef.current === controller) importSubmitControllerRef.current = null;
      if (isCurrentTenantRequest(context, generation, controller)) setImportLoading(false);
    }
  }

  function importTargetCandidates(agentRows: AgentProfileRead[] = agents): AgentProfileRead[] {
    return agentRows.filter((item) => (
      !item.is_overall
      && item.status === 'active'
      && canManageEmployeeAgent(item, currentUser)
    ));
  }

  function handleImportTargetChange(nextTargetAgentId: string) {
    setImportTargetAgentId(nextTargetAgentId);
    if (importMode !== 'employee' || importSourceAgentId !== nextTargetAgentId) return;
    const nextSource = visibleEmployeeAgents(agents, currentUser, {
      activeOnly: true,
      excludeAgentId: nextTargetAgentId,
    })[0]?.id || '';
    setImportSourceAgentId(nextSource);
    void loadImportSourceTools(nextSource);
  }

  function renderActions(row: ToolRead) {
    const isMcpChild = row.tool_type === 'mcp' && Boolean(row.mcp_server_id);
    return (
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={t(TOOLS_MESSAGE_IDS.actionMenu)}
          className="ml-auto grid size-7 place-items-center rounded-[8px] text-[#1a71ff] transition-colors outline-none hover:bg-black/5 hover:text-[#4a8dff] focus-visible:bg-black/5"
        >
          <IconMore className="size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className={MENU_CONTENT_CLASS}>
          {canManageCurrentScope && !isMcpChild && (
            <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => navigate(`/enterprise/tools/${row.id}/edit`)}>
              <IconEdit />
              {t(TOOLS_MESSAGE_IDS.actionEdit)}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => navigate(`/enterprise/tools/${row.id}/test`)}>
            <FlaskConical />
            {t(TOOLS_MESSAGE_IDS.actionTest)}
          </DropdownMenuItem>
          {canManageCurrentScope && !isMcpChild && (
            <>
              <DropdownMenuSeparator className="my-[2px] bg-[#eef0f4]" />
              <DropdownMenuItem
                variant="destructive"
                className={MENU_ITEM_DANGER_CLASS}
                onSelect={() => setDeleteTarget(row)}
              >
                <IconTrash />
                {t(isOverallAgent ? TOOLS_MESSAGE_IDS.actionDelete : TOOLS_MESSAGE_IDS.actionRemove)}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  const columns: DataTableColumn<ToolRead>[] = [
    {
      key: 'name',
      title: t(TOOLS_MESSAGE_IDS.toolName),
      width: 200,
      className: 'text-[#18181a]',
      render: (row) => (
        <div className="flex min-w-0 flex-col gap-[2px]">
          <span className="truncate font-medium leading-[18px] text-[#18181a]" title={row.display_name || row.name}>
            <RawIdentifier value={row.display_name || row.name} />
          </span>
          <span className="truncate text-[#858b9c]" title={row.name}>
            <RawIdentifier value={row.name} />
          </span>
        </div>
      ),
    },
    {
      key: 'bucket',
      title: t(TOOLS_MESSAGE_IDS.bucket),
      width: 130,
      render: (row) => <StatusBadge tone="gray">{bucketLabel(row.bucket, t)}</StatusBadge>,
    },
    {
      key: 'type',
      title: t(TOOLS_MESSAGE_IDS.type),
      width: 90,
      render: (row) => (
        <StatusBadge tone={row.tool_type === 'mcp' || row.tool_type === 'a2a' ? 'blue' : 'gray'}>
          {toolProtocolLabel(row.tool_type, t)}
        </StatusBadge>
      ),
    },
    {
      key: 'capability_scope',
      title: t(TOOLS_MESSAGE_IDS.capabilityScope),
      width: 105,
      render: (row) => <CapabilityScopeBadge value={row.capability_scope} />,
    },
    {
      key: 'creator',
      title: t(TOOLS_MESSAGE_IDS.creator),
      width: 120,
      render: (row) => (
        <span className="block truncate text-[#858b9c]" title={resourceCreatorName(row)}>
          {resourceCreatorName(row) ? <RawIdentifier value={resourceCreatorName(row)} /> : '—'}
        </span>
      ),
    },
    {
      key: 'method',
      title: t(TOOLS_MESSAGE_IDS.method),
      width: 96,
      render: (row) => <RawIdentifier value={row.method} />,
    },
    {
      key: 'url',
      title: t(TOOLS_MESSAGE_IDS.url),
      className: 'whitespace-normal',
      render: (row) => (
        <span className="line-clamp-1 wrap-break-word text-[#858b9c]"><RawIdentifier value={row.url} /></span>
      ),
    },
    {
      key: 'enabled',
      title: t(TOOLS_MESSAGE_IDS.enabled),
      width: 90,
      render: (row) => (
        <StatusBadge tone={row.enabled ? 'green' : 'gray'}>
          {t(row.enabled ? TOOLS_MESSAGE_IDS.statusEnabled : TOOLS_MESSAGE_IDS.statusDisabled)}
        </StatusBadge>
      ),
    },
    {
      key: 'actions',
      title: t(TOOLS_MESSAGE_IDS.actions),
      width: 70,
      align: 'right',
      render: (row) => renderActions(row),
    },
  ];

  const serverColumns: DataTableColumn<MCPServerRead>[] = [
    {
      key: 'name',
      title: t(TOOLS_MESSAGE_IDS.serverName),
      width: 240,
      render: (row) => (
        <div className="flex min-w-0 flex-col gap-[4px]">
          <span className="flex w-full min-w-0 items-center gap-[6px]">
            <span className="min-w-0 flex-1 truncate font-medium leading-[18px] text-[#18181a]" title={row.display_name || row.name}>
              <RawIdentifier value={row.display_name || row.name} />
            </span>
            <span className="shrink-0">
              <StatusBadge tone="blue">{t(TOOLS_MESSAGE_IDS.statusToolGroup)}</StatusBadge>
            </span>
          </span>
          <span className="truncate text-[#858b9c]" title={row.name}>
            <RawIdentifier value={row.name} />
          </span>
        </div>
      ),
    },
    {
      key: 'transport',
      title: t(TOOLS_MESSAGE_IDS.serverTransport),
      width: 140,
      render: (row) => <StatusBadge tone="gray">{transportLabel(row.connection.transport, t)}</StatusBadge>,
    },
    {
      key: 'apps_mode',
      title: t(TOOLS_MESSAGE_IDS.serverAppsMode),
      width: 112,
      render: (row) => (
        <StatusBadge tone={row.apps_mode === 'auto' ? 'blue' : 'gray'}>
          {row.apps_mode === 'auto'
            ? row.apps_negotiated
              ? t(TOOLS_MESSAGE_IDS.statusMcpNegotiated)
              : t(TOOLS_MESSAGE_IDS.statusMcpPending)
            : t(TOOLS_MESSAGE_IDS.statusMcpDisabled)}
        </StatusBadge>
      ),
    },
    {
      key: 'capability_scope',
      title: t(TOOLS_MESSAGE_IDS.capabilityScope),
      width: 105,
      render: (row) => <CapabilityScopeBadge value={row.capability_scope} />,
    },
    {
      key: 'endpoint',
      title: t(TOOLS_MESSAGE_IDS.serverEndpoint),
      className: 'whitespace-normal',
      render: (row) => (
        <span className="line-clamp-1 wrap-break-word text-[#858b9c]"><RawIdentifier value={serverEndpoint(row.connection)} /></span>
      ),
    },
    {
      key: 'tool_count',
      title: t(TOOLS_MESSAGE_IDS.statsTotal),
      width: 110,
      render: (row) => (
        <span className="text-[#858b9c]">
          {t(TOOLS_MESSAGE_IDS.serverToolCount, { count: serverToolCount(row) })}
        </span>
      ),
    },
    {
      key: 'enabled',
      title: t(TOOLS_MESSAGE_IDS.enabled),
      width: 90,
      render: (row) => (
        <StatusBadge tone={row.enabled ? 'green' : 'gray'}>
          {t(row.enabled ? TOOLS_MESSAGE_IDS.statusEnabled : TOOLS_MESSAGE_IDS.statusDisabled)}
        </StatusBadge>
      ),
    },
    {
      key: 'actions',
      title: t(TOOLS_MESSAGE_IDS.actions),
      width: 160,
      align: 'right',
      render: (row) => (
        <div className="flex items-center justify-end gap-[8px]">
          <UIButton
            variant="outline"
            size="sm"
            onClick={() => navigate(`/enterprise/tools/mcp/${row.id}/edit`)}
            disabled={!canManageCurrentScope}
            className={RETURN_BUTTON_CLASS}
          >
            <IconRefresh className="size-[14px] shrink-0" />
            {t(TOOLS_MESSAGE_IDS.actionDiscover)}
          </UIButton>
          {canManageCurrentScope && (
            <UIButton
              variant="outline"
              size="sm"
              onClick={() => setServerDeleteTarget(row)}
              className={cn(RETURN_BUTTON_CLASS, 'text-[#e5484d] hover:text-[#e5484d]')}
            >
              {t(isOverallAgent ? TOOLS_MESSAGE_IDS.actionDelete : TOOLS_MESSAGE_IDS.actionRemove)}
            </UIButton>
          )}
        </div>
      ),
    },
  ];

  const renderMobileCard = (row: ToolRead) => (
    <article className={MOBILE_CARD_CLASS} key={row.id}>
      <div className="flex min-w-0 items-start justify-between gap-[10px]">
        <div className="min-w-0">
          <strong className="block truncate text-[14px] font-semibold text-[#18181a]">
            <RawIdentifier value={row.display_name || row.name} />
          </strong>
          <span className="mt-[2px] block truncate text-[12px] text-[#858b9c]"><RawIdentifier value={row.name} /></span>
          <span className="mt-[2px] block truncate text-[12px] text-[#858b9c]">
            {t(TOOLS_MESSAGE_IDS.creator)}{resourceCreatorName(row) ? <RawIdentifier value={resourceCreatorName(row)} /> : '—'}
          </span>
        </div>
        {renderActions(row)}
      </div>
      <div className="mt-[8px] flex flex-wrap items-center gap-[6px]">
        <StatusBadge tone="gray">{bucketLabel(row.bucket, t)}</StatusBadge>
        <StatusBadge tone={row.tool_type === 'mcp' || row.tool_type === 'a2a' ? 'blue' : 'gray'}>
          {toolProtocolLabel(row.tool_type, t)}
        </StatusBadge>
        <CapabilityScopeBadge value={row.capability_scope} />
        <StatusBadge tone={row.enabled ? 'green' : 'gray'}>
          {t(row.enabled ? TOOLS_MESSAGE_IDS.statusEnabled : TOOLS_MESSAGE_IDS.statusDisabled)}
        </StatusBadge>
      </div>
      <p className="mt-[8px] line-clamp-1 wrap-break-word text-[12px] text-[#858b9c]">
        <RawIdentifier value={`${row.method} · ${row.url}`} />
      </p>
    </article>
  );

  const listEmptyText = isOverallAgent
    ? canManageCurrentScope
      ? t(TOOLS_MESSAGE_IDS.emptyToolsAdmin)
      : t(TOOLS_MESSAGE_IDS.emptyTools)
    : t(TOOLS_MESSAGE_IDS.emptyEmployeeTools);

  if (!agentScopeLoaded) return <CapabilityScopeLoading />;

  return (
    <div className="min-h-full box-border px-[48px] pt-[32px] pb-[43px] max-[900px]:px-[16px]">
      <AppHeader onLogout={onLogout} userName={currentUser?.username} title={pageTitle} />

      <div className="mt-[20px] mb-[16px] flex items-center justify-end gap-[12px]">
        <UIButton
          variant="outline"
          onClick={() => void load()}
          disabled={loading}
          className="h-[34px] gap-[4px] rounded-[10px] border-[0.5px] border-[#e3e7f1] bg-white px-[20px] text-[12px] font-normal text-[#757f9c] hover:border-[#cbd3e6] hover:bg-white hover:text-[#18181a]"
        >
          <IconRefresh className={cn('size-[14px]', loading && 'animate-spin')} />
          {t(TOOLS_MESSAGE_IDS.actionRefresh)}
        </UIButton>
        {canOpenCreateMenu && (
          <DropdownMenu>
            <DropdownMenuTrigger data-guide-target="tools-create" className="flex h-[34px] items-center gap-[4px] rounded-[10px] bg-[#18181a] px-[20px] text-[12px] font-normal text-white outline-none transition-colors hover:bg-[#303030]">
              <IconAdd className="size-[14px]" />
              {t(TOOLS_MESSAGE_IDS.actionCreate)}
              <IconChevronDown className="size-[12px]" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className={MENU_CONTENT_CLASS}>
              {canManageCurrentScope && (
                <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => handleCreateAction('blank')}>
                  <IconAdd />
                  {t(TOOLS_MESSAGE_IDS.importNewBlank)}
                </DropdownMenuItem>
              )}
              {!isOverallAgent && (
                <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => handleCreateAction('plaza')}>
                  <IconTool className="size-[14px]" />
                  {t(TOOLS_MESSAGE_IDS.importFromPlaza)}
                </DropdownMenuItem>
              )}
              {!isOverallAgent && (
                <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => handleCreateAction('employee')}>
                  <FlaskConical />
                  {t(TOOLS_MESSAGE_IDS.importFromEmployee)}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <div className="flex flex-col gap-[24px] rounded-[20px_20px_0_0] bg-white p-[18px_18px_24px_18px] shadow-[0_-4px_16px_0_rgba(0,0,0,0.05)]">
        <div className="flex flex-wrap items-stretch gap-[20px]" aria-label={t(TOOLS_MESSAGE_IDS.statsAria)}>
          <StatCard label={t(TOOLS_MESSAGE_IDS.statsTotal)} value={stats.total} className="basis-[220px]" />
          <StatCard label={t(TOOLS_MESSAGE_IDS.statsEnabled)} value={stats.enabled} tone="green" className="basis-[220px]" />
          <StatCard label={t(TOOLS_MESSAGE_IDS.statsBuckets)} value={stats.buckets} className="basis-[220px]" />
        </div>

        {visibleServers.length > 0 && (
          <div className="flex flex-col gap-[18px]">
            <div className="flex items-center gap-[6px] px-[12px] text-[#757f9c]">
              <ApiOutlined className="size-[14px] shrink-0" />
              <span className="text-[14px] font-normal leading-none">{t(TOOLS_MESSAGE_IDS.serverHeading)}</span>
            </div>
            <div className="hidden md:block">
              <DataTable
                aria-label={t(TOOLS_MESSAGE_IDS.serverList)}
                columns={serverColumns}
                data={visibleServers}
                rowKey={(row) => row.id}
                loading={loading}
                emptyText={t(TOOLS_MESSAGE_IDS.serverEmpty)}
              />
            </div>
            <div className="grid gap-[10px] md:hidden">
              {visibleServers.map((row) => (
                <article className={MOBILE_CARD_CLASS} key={row.id}>
                  <div className="flex min-w-0 items-start justify-between gap-[10px]">
                    <div className="min-w-0">
                      <strong className="block truncate text-[14px] font-semibold text-[#18181a]">
                        <RawIdentifier value={row.display_name || row.name} />
                      </strong>
                      <span className="mt-[2px] block truncate text-[12px] text-[#858b9c]"><RawIdentifier value={row.name} /></span>
                    </div>
                    <span className="shrink-0">
                      <StatusBadge tone="blue">{t(TOOLS_MESSAGE_IDS.statusToolGroup)}</StatusBadge>
                    </span>
                  </div>
                  <div className="mt-[8px] flex flex-wrap items-center gap-[6px]">
                    <StatusBadge tone="gray">{transportLabel(row.connection.transport, t)}</StatusBadge>
                    <CapabilityScopeBadge value={row.capability_scope} />
                    <StatusBadge tone={row.enabled ? 'green' : 'gray'}>
                      {t(row.enabled ? TOOLS_MESSAGE_IDS.statusEnabled : TOOLS_MESSAGE_IDS.statusDisabled)}
                    </StatusBadge>
                    <StatusBadge tone="gray">
                      {t(TOOLS_MESSAGE_IDS.serverToolCount, { count: serverToolCount(row) })}
                    </StatusBadge>
                  </div>
                  <p className="mt-[8px] line-clamp-1 wrap-break-word text-[12px] text-[#858b9c]">
                    <RawIdentifier value={serverEndpoint(row.connection)} />
                  </p>
                  <div className="mt-[10px] flex items-center gap-[8px]">
                    <UIButton
                      variant="outline"
                      size="sm"
                      onClick={() => navigate(`/enterprise/tools/mcp/${row.id}/edit`)}
                      className={RETURN_BUTTON_CLASS}
                    >
                      <IconRefresh className="size-[14px] shrink-0" />
                      {t(TOOLS_MESSAGE_IDS.actionDiscover)}
                    </UIButton>
                    {canManageCurrentScope && (
                      <UIButton
                        variant="outline"
                        size="sm"
                        onClick={() => setServerDeleteTarget(row)}
                        className={cn(RETURN_BUTTON_CLASS, 'text-[#e5484d] hover:text-[#e5484d]')}
                      >
                        {t(isOverallAgent ? TOOLS_MESSAGE_IDS.actionDelete : TOOLS_MESSAGE_IDS.actionRemove)}
                      </UIButton>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </div>
        )}

        <div className="flex flex-col gap-[18px]">
          <div className="flex items-center gap-[6px] px-[12px] text-[#757f9c]">
            <IconBriefcase className="size-[14px] shrink-0" />
            <span className="text-[14px] font-normal leading-none">{listLabel}</span>
          </div>

          <div className="flex flex-wrap items-center gap-[16px]">
            <label className="flex h-[34px] w-[300px] items-center gap-[8px] overflow-hidden rounded-[10px] border-[0.5px] border-[#e3e7f1] bg-white px-[12px] transition-colors focus-within:border-[#18181a] max-[900px]:w-full">
              <IconSearch className="size-[14px] shrink-0 text-[#858b9c]" />
              <input
                autoComplete="off"
                data-1p-ignore="true"
                data-lpignore="true"
                data-bwignore="true"
                value={searchText}
                aria-label={t(TOOLS_MESSAGE_IDS.searchLabel)}
                placeholder={t(TOOLS_MESSAGE_IDS.searchPlaceholder)}
                onChange={(event) => setSearchText(event.target.value)}
                className="h-full min-w-0 flex-1 bg-transparent text-[12px] text-[#17191f] outline-none placeholder:text-[#c0c6d4]"
              />
              {searchText && (
                <button
                  type="button"
                  aria-label={t(TOOLS_MESSAGE_IDS.searchClear)}
                  onClick={() => setSearchText('')}
                  className="grid size-[16px] shrink-0 place-items-center text-[#c0c6d4] hover:text-[#858b9c]"
                >
                  <IconClear className="size-[14px]" />
                </button>
              )}
            </label>
            <UISelect value={bucketFilter} onValueChange={setBucketFilter}>
              <SelectTrigger className={cn(SELECT_TRIGGER_CLASS, 'w-[180px]')} aria-label={t(TOOLS_MESSAGE_IDS.bucketFilter)}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {bucketSelectOptions.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.value === '__all__'
                      ? t(TOOLS_MESSAGE_IDS.bucketFilterAll)
                      : (
                        <>
                          {bucketLabel(item.bucket, t)} ({formatToolsNumber(item.total, locale)})
                        </>
                      )}
                  </SelectItem>
                ))}
              </SelectContent>
            </UISelect>
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
              aria-label={t(TOOLS_MESSAGE_IDS.listAria)}
              columns={columns}
              data={pagination.pagedItems}
              rowKey={(row) => row.id}
              loading={loading}
              emptyText={listEmptyText}
            />
          </div>

          {filteredRows.length > 0 && (
            <Paginator
              aria-label={t(TOOLS_MESSAGE_IDS.pagination)}
              className="mt-0 mb-[6px]"
              page={pagination.page}
              pageCount={pagination.pageCount}
              onChange={pagination.setPage}
            />
          )}
        </div>
      </div>

      <ResourceImportDialog
        open={importOpen}
        loading={importLoading}
        icon={<IconTool className="size-[14px] shrink-0" />}
        title={t(importMode === 'plaza' ? TOOLS_MESSAGE_IDS.importTitlePlaza : TOOLS_MESSAGE_IDS.importTitleEmployee)}
        targetLabel={t(TOOLS_MESSAGE_IDS.importTargetLabel)}
        targetPlaceholder={t(TOOLS_MESSAGE_IDS.importTargetPlaceholder)}
        targets={importTargetCandidates().map((item) => ({ value: item.id, label: item.name }))}
        targetId={importTargetAgentId}
        sourcePlaceholder={t(importMode === 'plaza'
          ? TOOLS_MESSAGE_IDS.importSourcePlazaPlaceholder
          : TOOLS_MESSAGE_IDS.importSourceEmployeePlaceholder)}
        sources={importMode === 'plaza'
          ? openGalleryImportSourceOptions(agents, t(TOOLS_MESSAGE_IDS.importSourceGallery))
          : visibleEmployeeAgents(agents, currentUser, { activeOnly: true, excludeAgentId: importTargetAgentId })
            .map((item) => ({ value: item.id, label: item.name }))}
        sourceId={importSourceAgentId}
        itemsLabel={t(TOOLS_MESSAGE_IDS.importItemsLabel)}
        items={importSourceTools.map((item) => ({
          id: item.id,
          label: (
            <>
              {item.display_name || item.name}
              <span className="text-[#858b9c]"> · {item.name}</span>
            </>
          ),
        }))}
        selectedIds={importSelectedToolIds}
        emptyText={t(TOOLS_MESSAGE_IDS.importEmpty)}
        note={
          importMode === 'plaza'
            ? t(TOOLS_MESSAGE_IDS.importNotePlaza)
            : t(TOOLS_MESSAGE_IDS.importNoteEmployee)
        }
        onTargetChange={handleImportTargetChange}
        onSourceChange={(value) => {
          setImportSourceAgentId(value);
          void loadImportSourceTools(value);
        }}
        onSelectedChange={setImportSelectedToolIds}
        onClose={() => setImportOpen(false)}
        onSubmit={() => void submitImportTools()}
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        loading={deleting}
        title={deleteTarget
          ? t(isOverallAgent ? TOOLS_MESSAGE_IDS.confirmDeleteToolTitle : TOOLS_MESSAGE_IDS.confirmRemoveToolTitle, {
            name: deleteTarget.display_name || deleteTarget.name,
          })
          : ''}
        description={
          isOverallAgent
            ? t(TOOLS_MESSAGE_IDS.confirmDeleteToolDescription)
            : t(TOOLS_MESSAGE_IDS.confirmRemoveToolDescription)
        }
        confirmText={t(isOverallAgent ? TOOLS_MESSAGE_IDS.actionDelete : TOOLS_MESSAGE_IDS.actionRemove)}
        onConfirm={() => void confirmDelete()}
      />

      <ConfirmDialog
        open={Boolean(serverDeleteTarget)}
        onOpenChange={(open) => {
          if (!open) setServerDeleteTarget(null);
        }}
        loading={deletingServer}
        title={
          serverDeleteTarget
            ? t(TOOLS_MESSAGE_IDS.serverDeleteTitle, {
              action: t(isOverallAgent ? TOOLS_MESSAGE_IDS.actionDelete : TOOLS_MESSAGE_IDS.actionRemove),
              name: serverDeleteTarget.display_name || serverDeleteTarget.name,
            })
            : ''
        }
        description={
          isOverallAgent
            ? t(TOOLS_MESSAGE_IDS.serverDeleteDescription, {
              count: serverDeleteTarget ? serverToolCount(serverDeleteTarget) : 0,
            })
            : t(TOOLS_MESSAGE_IDS.serverRemoveDescription, {
              count: serverDeleteTarget ? serverToolCount(serverDeleteTarget) : 0,
            })
        }
        confirmText={t(isOverallAgent ? TOOLS_MESSAGE_IDS.actionDelete : TOOLS_MESSAGE_IDS.actionRemove)}
        onConfirm={() => void confirmDeleteServer()}
      />
    </div>
  );
}

export function ToolNewPage(props: ToolPageProps = {}) {
  return <ToolEditorPage mode="new" {...props} />;
}

export function ToolEditPage(props: ToolPageProps = {}) {
  return <ToolEditorPage mode="edit" {...props} />;
}

export function McpServerNewPage(props: ToolPageProps = {}) {
  return <McpServerEditorPage mode="new" {...props} />;
}

export function McpServerEditPage(props: ToolPageProps = {}) {
  return <McpServerEditorPage mode="edit" {...props} />;
}

/**
 * 新建工具时顶部的类型切换条：HTTP 工具 / MCP 服务器。
 * 点击即跳转到对应的新建页，体验上像同一个「新建工具」流程里的分支。
 */
function ToolTypeSwitcher({ active, onProtocolChange }: { active: 'http' | 'a2a' | 'mcp'; onProtocolChange?: (protocol: 'http' | 'a2a') => void }) {
  const navigate = useNavigate();
  const { t } = useAppIntl();
  const options: { value: 'http' | 'a2a' | 'mcp'; labelId: MessageId; hintId: MessageId; to: string }[] = [
    {
      value: 'http',
      labelId: TOOLS_MESSAGE_IDS.typeHttp,
      hintId: TOOLS_MESSAGE_IDS.typeHttpDescription,
      to: '/enterprise/tools/new',
    },
    {
      value: 'a2a',
      labelId: TOOLS_MESSAGE_IDS.typeA2A,
      hintId: TOOLS_MESSAGE_IDS.typeA2ADescription,
      to: '/enterprise/tools/new',
    },
    {
      value: 'mcp',
      labelId: TOOLS_MESSAGE_IDS.typeMcp,
      hintId: TOOLS_MESSAGE_IDS.typeMcpDescription,
      to: '/enterprise/tools/mcp/new',
    },
  ];
  return (
    <div className="mb-[16px] flex flex-col gap-[8px]">
      <span className={FIELD_LABEL_CLASS}>{t(TOOLS_MESSAGE_IDS.fieldToolType)}</span>
      <div className="flex flex-wrap gap-[10px]">
        {options.map((option) => {
          const isActive = option.value === active;
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => {
                if (option.value === 'mcp') navigate(option.to);
                else if (onProtocolChange) onProtocolChange(option.value);
                else navigate(`${option.to}?type=${option.value}`);
              }}
              className={cn(
                'relative flex min-w-[200px] flex-1 items-start gap-[10px] rounded-[12px] border px-[16px] py-[12px] text-left transition-all',
                isActive
                  ? 'border-[#18181a] bg-[#18181a] shadow-[0_4px_12px_0_rgba(24,24,26,0.18)]'
                  : 'border-[#e3e7f1] bg-white hover:border-[#cbd3e6] hover:bg-[#fafbfc]',
              )}
              aria-pressed={isActive}
            >
              <span
                className={cn(
                  'flex size-[28px] shrink-0 items-center justify-center rounded-[8px]',
                  isActive ? 'bg-white/15 text-white' : 'bg-[#f2f3f7] text-[#757f9c]',
                )}
              >
                {option.value === 'mcp' ? <ApiOutlined className="size-[15px] shrink-0" /> : <IconTool className="size-[15px] shrink-0" />}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
                <span className={cn('text-[13px] font-semibold', isActive ? 'text-white' : 'text-[#18181a]')}>
                  {t(option.labelId)}
                </span>
                <span className={cn('text-[12px] leading-[1.5]', isActive ? 'text-white/70' : 'text-[#858b9c]')}>
                  {t(option.hintId)}
                </span>
              </span>
              {isActive && (
                <span className="absolute top-[10px] right-[10px] flex size-[16px] shrink-0 items-center justify-center rounded-full bg-white text-[#18181a]">
                  <CheckOutlined className="size-[10px] shrink-0" />
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ToolEditorPage({ mode, currentUser, onLogout }: { mode: 'new' | 'edit' } & ToolPageProps) {
  const { t } = useAppIntl();
  const toast = createToastNotifier({ t });
  const tenantContext = useTenantSession();
  const tenantClient = useMemo(() => createTenantClient(tenantContext), [tenantContext]);
  const tenantId = tenantContext?.tenantId || '';
  const userId = tenantContext?.userId || '';
  const [values, setValues] = useState<ToolFormValues>({ ...TOOL_FORM_INITIAL_VALUES });
  const [tool, setTool] = useState<ToolRead | null>(null);
  const [loading, setLoading] = useState(false);
  const [bucketValues, setBucketValues] = useState<string[]>([]);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { toolId } = useParams();
  const isEdit = mode === 'edit';
  const requestedToolType = searchParams.get('type') === 'a2a' ? 'a2a' : 'http';
  const bucketControllerRef = useRef<AbortController | null>(null);
  const loadControllerRef = useRef<AbortController | null>(null);
  const saveControllerRef = useRef<AbortController | null>(null);

  useEffect(() => () => {
    [bucketControllerRef, loadControllerRef, saveControllerRef].forEach((ref) => ref.current?.abort());
  }, [tenantContext?.tenantId, tenantContext?.generation]);

  const setField = <K extends keyof ToolFormValues>(name: K, value: ToolFormValues[K]) =>
    setValues((prev) => ({ ...prev, [name]: value }));

  useEffect(() => {
    if (!tenantContext) return;
    const context = tenantContext;
    const generation = context.generation;
    bucketControllerRef.current?.abort();
    const controller = new AbortController();
    bucketControllerRef.current = controller;
    void loadBucketValues(tenantClient, tenantId, userId, { signal: controller.signal })
      .then((values) => {
        if (isCurrentTenantRequest(context, generation, controller)) setBucketValues(values);
      })
      .catch(() => undefined)
      .finally(() => {
        if (bucketControllerRef.current === controller) bucketControllerRef.current = null;
      });
  }, [tenantClient, tenantContext, tenantId, userId]);

  useEffect(() => {
    if (!isEdit) {
      setValues({ ...TOOL_FORM_INITIAL_VALUES, tool_type: requestedToolType });
      setTool(null);
      return;
    }
    if (!tenantContext || !toolId) return;
    const context = tenantContext;
    const generation = context.generation;
    loadControllerRef.current?.abort();
    const controller = new AbortController();
    loadControllerRef.current = controller;
    setLoading(true);
    const agentQuery = currentAgentQuery(tenantId, userId);
    tenantClient
      .get<ToolRead>(`/api/enterprise/tools/${toolId}?tenant_id=${tenantId}${agentQuery}`, {
        signal: controller.signal,
      })
      .then((row) => {
        if (!isCurrentTenantRequest(context, generation, controller)) return;
        setTool(row);
        setValues(toolToFormValues(row));
      })
      .catch((error) => {
        if (!isCurrentTenantRequest(context, generation, controller)) return;
        console.error('[tools-page] load tool failed', error);
        toast.error(toolErrorDescriptor(error, TOOLS_MESSAGE_IDS.toastLoadToolsFailed));
      })
      .finally(() => {
        if (loadControllerRef.current === controller) loadControllerRef.current = null;
        if (isCurrentTenantRequest(context, generation, controller)) setLoading(false);
      });
  }, [isEdit, requestedToolType, tenantClient, tenantContext, tenantId, toolId, userId]);

  async function save() {
    if (!String(values.name || '').trim()) {
      toast.error(createMessageDescriptor(TOOLS_MESSAGE_IDS.toastToolNameRequired));
      return;
    }
    if (!String(values.url || '').trim()) {
      toast.error(createMessageDescriptor(TOOLS_MESSAGE_IDS.toastUrlRequired));
      return;
    }
    const payload = buildToolPayload(values);
    if (!payload) {
      toast.error(createMessageDescriptor(TOOLS_MESSAGE_IDS.toastJsonConfigInvalid));
      return;
    }
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return;
    saveControllerRef.current?.abort();
    const controller = new AbortController();
    saveControllerRef.current = controller;
    setLoading(true);
    try {
      const agentQuery = currentAgentQuery(tenantId, userId);
      const saved = isEdit && toolId
        ? await tenantClient.put<ToolRead>(`/api/enterprise/tools/${toolId}${agentQuery ? `?${agentQuery.slice(1)}` : ''}`, payload, { signal: controller.signal })
        : await tenantClient.post<ToolRead>(`/api/enterprise/tools${agentQuery ? `?${agentQuery.slice(1)}` : ''}`, payload, { signal: controller.signal });
      if (!isCurrentTenantRequest(context, generation, controller)) return;
      toast.success(createMessageDescriptor(TOOLS_MESSAGE_IDS.toastSaved));
      announceEnterpriseCapabilityCatalogChange({
        resourceType: 'tool',
        agentId: readEmployeeScope(tenantId, userId) || undefined,
      });
      setTool(saved);
      setValues(toolToFormValues(saved));
      if (!isEdit) {
        navigate(`/enterprise/tools/${saved.id}/edit`, { replace: true });
      }
    } catch (error) {
      if (!isCurrentTenantRequest(context, generation, controller)) return;
      console.error('[tools-page] save tool failed', error);
      toast.error(toolErrorDescriptor(error, TOOLS_MESSAGE_IDS.toastSaveFailed));
    } finally {
      if (saveControllerRef.current === controller) saveControllerRef.current = null;
      if (isCurrentTenantRequest(context, generation, controller)) setLoading(false);
    }
  }

  return (
    <div className="min-h-full box-border px-[48px] pt-[32px] pb-[43px] max-[900px]:px-[16px]" aria-busy={loading}>
      <AppHeader
        onLogout={onLogout}
        userName={currentUser?.username}
        title={t(isEdit ? TOOLS_MESSAGE_IDS.editorEditTitle : TOOLS_MESSAGE_IDS.editorNewTitle)}
        description={
          isEdit
            ? t(TOOLS_MESSAGE_IDS.editorDescriptionEdit)
            : t(TOOLS_MESSAGE_IDS.editorDescriptionNew)
        }
      />
      <div className="mt-[20px] mb-[16px] flex flex-wrap justify-end gap-[16px]">
        <UIButton variant="outline" onClick={() => navigate('/enterprise/tools')} className={RETURN_BUTTON_CLASS}>
          <IconArrowRight className="size-3.5 rotate-180" />
          {t(TOOLS_MESSAGE_IDS.actionBack)}
        </UIButton>
        {isEdit && tool && (
          <UIButton
            variant="outline"
            onClick={() => navigate(`/enterprise/tools/${tool.id}/test`)}
            className={RETURN_BUTTON_CLASS}
          >
            <ExperimentOutlined />
            {t(TOOLS_MESSAGE_IDS.actionOpenTest)}
          </UIButton>
        )}
        <UIButton disabled={loading} onClick={() => void save()} className={PRIMARY_BUTTON_CLASS}>
          {t(TOOLS_MESSAGE_IDS.actionSave)}
        </UIButton>
      </div>
      {!isEdit && <ToolTypeSwitcher active={values.tool_type} onProtocolChange={(protocol) => setValues((previous) => ({ ...previous, tool_type: protocol, method: 'POST' }))} />}
      <div className="grid grid-cols-1 items-start gap-[20px] xl:grid-cols-2">
        <SectionCard title={t(TOOLS_MESSAGE_IDS.sectionDefinition)} loading={loading && isEdit && !tool}>
          <ToolFormFields values={values} setField={setField} bucketValues={bucketValues} lockName={isEdit} />
        </SectionCard>
        <div className="flex w-full flex-col gap-[20px]">
          <ToolProbeCard values={values} />
          {isEdit && tool && <SavedToolTestCard tool={tool} />}
        </div>
      </div>
    </div>
  );
}

const CARD_CLASS =
  'rounded-[14px] border border-[#eceef1] bg-white';
const CARD_TITLE_CLASS = 'text-[14px] font-medium text-[#18181a]';
const FIELD_LABEL_CLASS = 'text-[13px] font-medium text-[#18181a]';
const SUBSECTION_TITLE_CLASS = 'text-[13px] font-medium text-[#18181a]';
const HINT_CLASS = 'text-[12px] leading-[1.55] text-[#858b9c]';
const MONO_INPUT_CLASS = 'font-mono text-[12px] leading-[1.65]';
const RETURN_BUTTON_CLASS =
  'h-8 gap-1 rounded-[10px] border-[0.5px] border-[#e3e7f1] bg-white px-5 text-[12px] font-normal text-[#757f9c] hover:border-[#cbd3e6] hover:bg-white hover:text-[#18181a]';
const PRIMARY_BUTTON_CLASS =
  'h-8 gap-1 rounded-[10px] bg-[#18181a] px-5 text-[12px] font-normal text-white hover:bg-[#303030]';

/** 统一工具页卡片容器；加载状态由当前界面 locale 渲染，children 不改写原始业务数据。 */
function SectionCard({
  title,
  extra,
  loading,
  children,
  className,
  bodyClassName,
}: {
  title?: ReactNode;
  extra?: ReactNode;
  loading?: boolean;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  const { t } = useAppIntl();
  return (
    <section className={cn(CARD_CLASS, 'overflow-hidden', className)}>
      {(title || extra) && (
        <div className="flex min-h-[54px] items-center justify-between gap-[12px] border-b border-[#eceef1] px-[20px] py-[10px]">
          <div className={cn('min-w-0', CARD_TITLE_CLASS)}>{title}</div>
          {extra ? <div className="shrink-0">{extra}</div> : null}
        </div>
      )}
      <div className={cn('p-[20px]', bodyClassName)}>
        {loading ? (
          <div className="py-[24px] text-center text-[13px] text-[#858b9c]">{t(TOOLS_MESSAGE_IDS.sectionLoading)}</div>
        ) : (
          children
        )}
      </div>
    </section>
  );
}

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-[6px]">
      <label htmlFor={htmlFor} className={FIELD_LABEL_CLASS}>
        {label}
      </label>
      {children}
      {hint ? <span className={HINT_CLASS}>{hint}</span> : null}
    </div>
  );
}

export function ToolTestPage({ currentUser, onLogout }: ToolPageProps = {}) {
  const { locale, t } = useAppIntl();
  const toast = createToastNotifier({ t });
  const tenantContext = useTenantSession();
  const tenantClient = useMemo(() => createTenantClient(tenantContext), [tenantContext]);
  const tenantId = tenantContext?.tenantId || '';
  const userId = tenantContext?.userId || '';
  const [tool, setTool] = useState<ToolRead | null>(null);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const { toolId } = useParams();
  const loadControllerRef = useRef<AbortController | null>(null);

  useEffect(() => () => loadControllerRef.current?.abort(), [tenantContext?.tenantId, tenantContext?.generation]);

  useEffect(() => {
    if (!tenantContext || !toolId) return;
    const context = tenantContext;
    const generation = context.generation;
    loadControllerRef.current?.abort();
    const controller = new AbortController();
    loadControllerRef.current = controller;
    setLoading(true);
    const agentQuery = currentAgentQuery(tenantId, userId);
    tenantClient
      .get<ToolRead>(`/api/enterprise/tools/${toolId}?tenant_id=${tenantId}${agentQuery}`, {
        signal: controller.signal,
      })
      .then((row) => {
        if (isCurrentTenantRequest(context, generation, controller)) setTool(row);
      })
      .catch((error) => {
        if (!isCurrentTenantRequest(context, generation, controller)) return;
        console.error('[tools-page] load tool test target failed', error);
        toast.error(toolErrorDescriptor(error, TOOLS_MESSAGE_IDS.toastLoadToolsFailed));
      })
      .finally(() => {
        if (loadControllerRef.current === controller) loadControllerRef.current = null;
        if (isCurrentTenantRequest(context, generation, controller)) setLoading(false);
      });
    return () => controller.abort();
  }, [tenantClient, tenantContext, tenantId, toolId, userId]);

  return (
    <div className="min-h-full box-border px-[48px] pt-[32px] pb-[43px] max-[900px]:px-[16px]" aria-busy={loading}>
      <AppHeader
        onLogout={onLogout}
        userName={currentUser?.username}
        title={t(TOOLS_MESSAGE_IDS.sectionCallTest)}
        description={t(TOOLS_MESSAGE_IDS.editorDescriptionTest)}
      />
      <div className="mt-[20px] mb-[16px] flex flex-wrap justify-end gap-[16px]">
        <UIButton variant="outline" onClick={() => navigate('/enterprise/tools')} className={RETURN_BUTTON_CLASS}>
          <IconArrowRight className="size-3.5 rotate-180" />
          {t(TOOLS_MESSAGE_IDS.actionBack)}
        </UIButton>
        {tool && (
          <UIButton
            variant="outline"
            onClick={() => navigate(`/enterprise/tools/${tool.id}/edit`)}
            className={RETURN_BUTTON_CLASS}
          >
            <IconEdit className="size-3.5" />
            {t(TOOLS_MESSAGE_IDS.actionEdit)}
          </UIButton>
        )}
      </div>
      <div className="grid grid-cols-1 items-start gap-[20px] xl:grid-cols-[minmax(0,1fr)_minmax(360px,440px)]">
        <SectionCard title={t(TOOLS_MESSAGE_IDS.sectionInfo)} loading={loading && !tool} bodyClassName="flex flex-col gap-[16px]">
          {tool && (
            <>
              <div className="grid grid-cols-[58px_minmax(0,1fr)] items-start gap-[16px] rounded-[14px] border border-[#eceef1] bg-[#fafbfc] p-[16px]">
                <div className="grid size-[58px] place-items-center rounded-[16px] border border-[#eceef1] bg-white text-[24px] text-[#18181a]">
                  <ToolOutlined />
                </div>
                <div className="min-w-0">
                  <span className="text-[12px] font-semibold text-[#1a71ff]">{bucketLabel(tool.bucket, t)}</span>
                  <h4 className="my-[4px] text-[18px] font-semibold wrap-break-word text-[#18181a]">
                    <RawIdentifier value={tool.display_name || tool.name} />
                  </h4>
                  <p className="mb-[10px] text-[13px] leading-[1.65] wrap-break-word text-[#858b9c]">
                    {tool.description ? <RawContent value={tool.description} /> : t(TOOLS_MESSAGE_IDS.rawDescription)}
                  </p>
                  <div className="flex flex-wrap items-center gap-[6px]">
                    <StatusBadge tone={tool.tool_type === 'mcp' || tool.tool_type === 'a2a' ? 'blue' : 'gray'}>{toolTypeLabel(tool, t)}</StatusBadge>
                    <CapabilityScopeBadge value={tool.capability_scope} />
                    <StatusBadge tone={tool.enabled ? 'green' : 'gray'}>
                      {t(tool.enabled ? TOOLS_MESSAGE_IDS.statusEnabled : TOOLS_MESSAGE_IDS.statusDisabled)}
                    </StatusBadge>
                    <StatusBadge tone="gray"><RawIdentifier value={tool.method} /></StatusBadge>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-[10px] md:grid-cols-4">
                {[
                  { label: t(TOOLS_MESSAGE_IDS.fieldToolId), value: tool.name },
                  { label: t(TOOLS_MESSAGE_IDS.fieldInputCount), value: formatToolsNumber(schemaPropertyCount(tool.input_schema), locale) },
                  { label: t(TOOLS_MESSAGE_IDS.fieldOutputCount), value: formatToolsNumber(schemaPropertyCount(tool.output_schema), locale) },
                  { label: t(TOOLS_MESSAGE_IDS.fieldLastUpdated), value: formatToolsDateTime(tool.updated_at, locale) },
                ].map((item) => (
                  <div
                    key={item.label}
                    className="flex min-h-[78px] flex-col gap-[8px] rounded-[12px] border border-[#eceef1] bg-white px-[14px] py-[13px]"
                  >
                    <span className="text-[12px] font-semibold text-[#858b9c]">{item.label}</span>
                    <strong
                      className="min-w-0 truncate text-[14px] leading-[1.35] text-[#18181a]"
                      title={String(item.value)}
                    >
                      {item.label === t(TOOLS_MESSAGE_IDS.fieldToolId)
                        ? <RawIdentifier value={String(item.value)} />
                        : item.value}
                    </strong>
                  </div>
                ))}
              </div>

              <div className="flex flex-col gap-[8px] rounded-[12px] border border-[#eceef1] bg-[#fafbfc] px-[16px] py-[14px]">
                <span className="text-[12px] font-semibold text-[#858b9c]">{t(TOOLS_MESSAGE_IDS.fieldInvocationAddress)}</span>
                <code className="block font-mono text-[13px] leading-[1.6] wrap-break-word text-[#18181a]">
                  <RawIdentifier value={`${tool.method} ${tool.url}`} />
                </code>
              </div>

              <div className="grid grid-cols-1 gap-[12px] md:grid-cols-2">
                <div className="flex flex-col gap-[10px]">
                  <span className={SUBSECTION_TITLE_CLASS}>{t(TOOLS_MESSAGE_IDS.fieldInputSchemaPanel)}</span>
                  <CodeBlock className="max-h-[340px] whitespace-pre-wrap wrap-break-word" code={formatJson(tool.input_schema)} language="json" />
                </div>
                <div className="flex flex-col gap-[10px]">
                  <span className={SUBSECTION_TITLE_CLASS}>{t(TOOLS_MESSAGE_IDS.fieldOutputSchemaPanel)}</span>
                  <CodeBlock className="max-h-[340px] whitespace-pre-wrap wrap-break-word" code={formatJson(tool.output_schema)} language="json" />
                </div>
              </div>
            </>
          )}
        </SectionCard>
        {tool && <SavedToolTestCard tool={tool} standalone />}
      </div>
      {tool?.tool_type === 'a2a' && <A2ARunsPanel tool={tool} />}
    </div>
  );
}

const A2A_TERMINAL_STATES = new Set(['completed', 'failed', 'canceled', 'cancelled', 'rejected']);

function A2ARunsPanel({ tool }: { tool: ToolRead }) {
  const { locale, t } = useAppIntl();
  const toast = createToastNotifier({ t });
  const tenantContext = useTenantSession();
  const tenantClient = useMemo(() => createTenantClient(tenantContext), [tenantContext]);
  const tenantId = tenantContext?.tenantId || '';
  const userId = tenantContext?.userId || '';
  const [runs, setRuns] = useState<A2ATaskRunRead[]>([]);
  const [adapter, setAdapter] = useState<CodexA2AAdapterRead | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const agentQuery = currentAgentQuery(tenantId, userId);
  const loadControllerRef = useRef<AbortController | null>(null);
  const cancelControllerRef = useRef<AbortController | null>(null);

  const load = async () => {
    if (!tenantContext) return;
    loadControllerRef.current?.abort();
    const controller = new AbortController();
    loadControllerRef.current = controller;
    const generation = tenantContext.generation;
    setLoading(true);
    try {
      const [nextRuns, nextAdapter] = await Promise.all([
        tenantClient.get<A2ATaskRunRead[]>(
          `/api/enterprise/tools/${tool.id}/a2a-runs?tenant_id=${tenantId}${agentQuery}&limit=20`,
          { signal: controller.signal },
        ),
        tenantClient.get<CodexA2AAdapterRead>(
          `/api/enterprise/tools/a2a/codex-adapter?tenant_id=${tenantId}${agentQuery}`,
          { signal: controller.signal },
        ),
      ]);
      if (!isCurrentTenantRequest(tenantContext, generation, controller)) return;
      setRuns(nextRuns);
      setAdapter(nextAdapter);
    } catch (error) {
      if (!isCurrentTenantRequest(tenantContext, generation, controller)) return;
      console.error('[tools-page] load A2A runs failed', error);
      toast.error(toolErrorDescriptor(error, TOOLS_MESSAGE_IDS.toastLoadA2ARunsFailed));
    } finally {
      if (isCurrentTenantRequest(tenantContext, generation, controller)) setLoading(false);
    }
  };

  useEffect(() => {
    if (!tenantContext) return undefined;
    void load();
    return () => {
      loadControllerRef.current?.abort();
      cancelControllerRef.current?.abort();
    };
    // Tool identity is the stable boundary for this panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantContext, tenantClient, tenantId, tool.id, userId]);

  async function cancel(run: A2ATaskRunRead) {
    if (!tenantContext) return;
    const context = tenantContext;
    const generation = context.generation;
    cancelControllerRef.current?.abort();
    const controller = new AbortController();
    cancelControllerRef.current = controller;
    try {
      await tenantClient.post(
        `/api/enterprise/tools/${tool.id}/a2a-runs/${run.id}:cancel?tenant_id=${tenantId}${agentQuery}`,
        {},
        { signal: controller.signal },
      );
      if (!isCurrentTenantRequest(context, generation, controller)) return;
      toast.success(createMessageDescriptor(TOOLS_MESSAGE_IDS.toastCancelSubmitted));
      await load();
    } catch (error) {
      if (!isCurrentTenantRequest(context, generation, controller)) return;
      console.error('[tools-page] cancel A2A run failed', error);
      toast.error(toolErrorDescriptor(error, TOOLS_MESSAGE_IDS.toastCancelFailed));
    } finally {
      if (cancelControllerRef.current === controller) cancelControllerRef.current = null;
    }
  }

  const codexEndpoint = adapter ? new URL(adapter.endpoint_url, window.location.origin).toString() : '';
  const isCodexConnection = Boolean(codexEndpoint && tool.url.replace(/\/$/, '') === codexEndpoint.replace(/\/$/, ''));

  return (
    <SectionCard
      className="mt-[20px]"
      title={<span className="flex items-center gap-[8px]"><Activity className="size-[16px]" />{t(TOOLS_MESSAGE_IDS.a2aHeading)}</span>}
      extra={(
        <UIButton variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
          <RotateCcw className={cn('size-[14px]', loading && 'animate-spin')} />
          {t(TOOLS_MESSAGE_IDS.actionRefresh)}
        </UIButton>
      )}
      loading={loading && runs.length === 0}
      bodyClassName="flex flex-col gap-[14px]"
    >
      <div className={cn('grid gap-[12px] rounded-[14px] border p-[16px] md:grid-cols-[minmax(0,1fr)_auto]', isCodexConnection ? 'border-emerald-200 bg-emerald-50/60' : 'border-sky-200 bg-sky-50/50')}>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-[8px]">
            <TerminalSquare className="size-[16px]" />
            <strong className="text-[13px] text-[#2f3442]">
              {isCodexConnection ? t(TOOLS_MESSAGE_IDS.a2aCodexAdapter) : t(TOOLS_MESSAGE_IDS.a2aStandardAgent)}
            </strong>
            {isCodexConnection && (
              <StatusBadge tone={adapter?.available ? 'green' : 'red'}>
                {t(adapter?.available ? TOOLS_MESSAGE_IDS.statusConnected : TOOLS_MESSAGE_IDS.statusNotEnabled)}
              </StatusBadge>
            )}
          </div>
          <p className="mt-[7px] font-mono text-[11px] leading-[17px] break-all text-[#687083]"><RawIdentifier value={tool.url} /></p>
        </div>
        <div className="flex items-center gap-[8px] text-[11px] text-[#687083]"><span className="size-[7px] rounded-full bg-emerald-400" />{t(TOOLS_MESSAGE_IDS.a2aPersistenceHint)}</div>
      </div>

      {runs.length === 0 ? (
        <div className="rounded-[14px] border border-dashed border-[#dfe3ea] px-[20px] py-[28px] text-center text-[12px] text-[#858b9c]">{t(TOOLS_MESSAGE_IDS.a2aEmpty)}</div>
      ) : runs.map((run) => {
        const open = expanded === run.id;
        const terminal = A2A_TERMINAL_STATES.has(run.status);
        return (
          <div key={run.id} className="overflow-hidden rounded-[14px] border border-[#e4e7ec] bg-white shadow-[0_1px_2px_rgba(16,24,40,0.03)]">
            <button type="button" className="flex w-full items-center gap-[12px] px-[16px] py-[14px] text-left hover:bg-[#fafbfc]" onClick={() => setExpanded(open ? null : run.id)}>
              <span className={cn('size-[9px] shrink-0 rounded-full', run.status === 'completed' ? 'bg-emerald-400' : run.status === 'failed' ? 'bg-red-400' : terminal ? 'bg-slate-400' : 'animate-pulse bg-sky-400')} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-[10px] gap-y-[4px]"><strong className="text-[13px] text-[#2f3442]">{a2aStatusLabel(run.status, t)}</strong><span className="font-mono text-[11px] text-[#858b9c]"><RawIdentifier value={run.remote_task_id || run.id} /></span></div>
                <p className="mt-[3px] text-[11px] text-[#858b9c]">
                  {t(TOOLS_MESSAGE_IDS.a2aRunSummary, {
                    updatedAt: formatToolsDateTime(run.updated_at, locale),
                    eventCount: run.events.length,
                    artifactCount: run.artifacts.length,
                  })}
                  {run.recovery_attempts
                    ? ` · ${t(TOOLS_MESSAGE_IDS.a2aRecoveryCount, { count: run.recovery_attempts })}`
                    : ''}
                </p>
              </div>
              {!terminal && (
                <UIButton variant="outline" size="sm" onClick={(event) => { event.stopPropagation(); void cancel(run); }}>
                  <XCircle className="size-[13px]" />
                  {t(TOOLS_MESSAGE_IDS.actionCancel)}
                </UIButton>
              )}
              <IconChevronDown className={cn('size-[14px] text-[#858b9c] transition-transform', open && 'rotate-180')} />
            </button>
            {open && <div className="grid gap-[14px] border-t border-[#eceef1] bg-[#fafbfc] p-[16px] lg:grid-cols-2">
              <div>
                <span className={SUBSECTION_TITLE_CLASS}>{t(TOOLS_MESSAGE_IDS.a2aTimeline)}</span>
                <div className="mt-[10px] flex max-h-[280px] flex-col gap-[8px] overflow-auto pr-[4px]">
                  {run.events.map((event) => (
                    <div key={`${run.id}-${event.sequence}`} className="grid grid-cols-[34px_minmax(0,1fr)] gap-[8px] text-[11px]">
                      <span className="font-mono text-[#9aa0af]">#{event.sequence}</span>
                      <div>
                        <strong className="text-[#464c5e]"><RawIdentifier value={event.event_type} /></strong>
                        <span className="ml-[8px] text-[#9aa0af]">{formatToolsDateTime(event.created_at, locale)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="flex flex-col gap-[10px]"><span className={SUBSECTION_TITLE_CLASS}>{t(TOOLS_MESSAGE_IDS.a2aPersistedState)}</span><CodeBlock className="max-h-[280px] whitespace-pre-wrap wrap-break-word" code={formatJson({ task_id: run.remote_task_id, context_id: run.context_id, codex_session_id: run.codex_session_id, status: run.status, cancel_requested: run.cancel_requested, artifacts: run.artifacts, error: run.error })} language="json" /></div>
            </div>}
          </div>
        );
      })}
    </SectionCard>
  );
}

/** 将 A2A 状态码映射为本地化产品状态，未知值保持原始协议标识。 */
function a2aStatusLabel(status: string, translate: ToolsTranslate): ReactNode {
  const messageId: MessageId | undefined = {
    submitted: TOOLS_MESSAGE_IDS.a2aStatusSubmitted,
    working: TOOLS_MESSAGE_IDS.a2aStatusWorking,
    running: TOOLS_MESSAGE_IDS.a2aStatusWorking,
    completed: TOOLS_MESSAGE_IDS.a2aStatusCompleted,
    failed: TOOLS_MESSAGE_IDS.a2aStatusFailed,
    canceled: TOOLS_MESSAGE_IDS.a2aStatusCanceled,
    cancelled: TOOLS_MESSAGE_IDS.a2aStatusCanceled,
    rejected: TOOLS_MESSAGE_IDS.a2aStatusRejected,
    'input-required': TOOLS_MESSAGE_IDS.a2aStatusInputRequired,
  }[status];
  return messageId ? translate(messageId) : <RawIdentifier value={status} />;
}

type McpFormValues = {
  name: string;
  display_name: string;
  description: string;
  bucket: string;
  transport: MCPTransport;
  url: string;
  headers: string;
  command: string;
  args: string;
  env: string;
  cwd: string;
  apps_mode: MCPAppsMode;
  auth_mode: MCPAuthMode;
  oauth_client_id: string;
  oauth_client_metadata_url: string;
  oauth_redirect_uri: string;
  capability_scope: CapabilityScope;
  enabled: boolean;
};

const MCP_FORM_INITIAL_VALUES: McpFormValues = {
  name: '',
  display_name: '',
  description: '',
  bucket: '',
  transport: 'streamable_http',
  url: '',
  headers: '{}',
  command: '',
  args: '',
  env: '{}',
  cwd: '',
  apps_mode: 'disabled',
  auth_mode: 'none',
  oauth_client_id: '',
  oauth_client_metadata_url: '',
  oauth_redirect_uri: '',
  capability_scope: 'general',
  enabled: true,
};

type DiscoveredRow = MCPDiscoverResponse['tools'][number] & { selected: boolean };

/** 编辑 MCP 连接与发现结果；产品文案由当前界面 locale 解析，远端工具数据保持原样。 */
function McpServerEditorPage({ mode, currentUser, onLogout }: { mode: 'new' | 'edit' } & ToolPageProps) {
  const { t } = useAppIntl();
  const toast = createToastNotifier({ t });
  const tenantContext = useTenantSession();
  const tenantClient = useMemo(() => createTenantClient(tenantContext), [tenantContext]);
  const tenantId = tenantContext?.tenantId || '';
  const userId = tenantContext?.userId || '';
  const [values, setValues] = useState<McpFormValues>({ ...MCP_FORM_INITIAL_VALUES });
  const [server, setServer] = useState<MCPServerRead | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [oauthBusy, setOauthBusy] = useState(false);
  const [oauthStatus, setOauthStatus] = useState<MCPOAuthStatusRead | null>(null);
  const [discovered, setDiscovered] = useState<DiscoveredRow[]>([]);
  const navigate = useNavigate();
  const { serverId } = useParams();
  const isEdit = mode === 'edit';
  const loadControllerRef = useRef<AbortController | null>(null);
  const saveControllerRef = useRef<AbortController | null>(null);
  const discoverControllerRef = useRef<AbortController | null>(null);
  const syncControllerRef = useRef<AbortController | null>(null);

  useEffect(() => () => {
    [loadControllerRef, saveControllerRef, discoverControllerRef, syncControllerRef]
      .forEach((ref) => ref.current?.abort());
  }, [tenantContext?.tenantId, tenantContext?.generation]);

  const setField = <K extends keyof McpFormValues>(name: K, value: McpFormValues[K]) =>
    setValues((prev) => ({ ...prev, [name]: value }));

  useEffect(() => {
    if (!isEdit) {
      setValues({ ...MCP_FORM_INITIAL_VALUES });
      setServer(null);
      setOauthStatus(null);
      setDiscovered([]);
      return;
    }
    if (!tenantContext || !serverId) return;
    const context = tenantContext;
    const generation = context.generation;
    loadControllerRef.current?.abort();
    const controller = new AbortController();
    loadControllerRef.current = controller;
    setLoading(true);
    tenantClient
      .get<MCPServerRead>(`/api/enterprise/mcp-servers/${serverId}?tenant_id=${tenantId}`, {
        signal: controller.signal,
      })
      .then((row) => {
        if (!isCurrentTenantRequest(context, generation, controller)) return;
        setServer(row);
        setValues(serverToFormValues(row));
        if (row.auth_mode === 'oauth_personal') {
          void loadOAuthStatus(row.id);
        } else {
          setOauthStatus(null);
        }
      })
      .catch((error) => {
        if (!isCurrentTenantRequest(context, generation, controller)) return;
        console.error('[tools-page] load MCP server failed', error);
        toast.error(toolErrorDescriptor(error, TOOLS_MESSAGE_IDS.toastLoadServerFailed));
      })
      .finally(() => {
        if (loadControllerRef.current === controller) loadControllerRef.current = null;
        if (isCurrentTenantRequest(context, generation, controller)) setLoading(false);
      });
  }, [isEdit, serverId, t, tenantClient, tenantContext, tenantId]);

  const transportOption = TRANSPORT_OPTIONS.find((item) => item.value === values.transport);
  const isRemote = values.transport === 'streamable_http' || values.transport === 'sse';
  const isStdio = values.transport === 'stdio';
  const isOAuth = values.auth_mode === 'oauth_personal';
  const savedOAuthValues = server ? serverToFormValues(server) : null;
  const oauthConfigurationDirty = Boolean(savedOAuthValues && (
    values.auth_mode !== savedOAuthValues.auth_mode
    || values.transport !== savedOAuthValues.transport
    || values.url.trim() !== savedOAuthValues.url.trim()
    || values.headers.trim() !== savedOAuthValues.headers.trim()
    || values.oauth_client_id.trim() !== savedOAuthValues.oauth_client_id.trim()
    || values.oauth_client_metadata_url.trim() !== savedOAuthValues.oauth_client_metadata_url.trim()
    || values.oauth_redirect_uri.trim() !== savedOAuthValues.oauth_redirect_uri.trim()
  ));

  async function loadOAuthStatus(targetServerId: string): Promise<void> {
    /** Refresh only the signed-in user's credential-free authorization projection. */
    try {
      const status = await tenantClient.get<MCPOAuthStatusRead>(
        `/api/enterprise/mcp-servers/${targetServerId}/oauth/status?tenant_id=${tenantId}`,
      );
      setOauthStatus(status);
    } catch (error) {
      console.error('[tools-page] load MCP OAuth status failed', error);
      toast.error(toolErrorDescriptor(error, TOOLS_MESSAGE_IDS.toastOAuthStatusFailed));
    }
  }

  async function beginOAuth(): Promise<void> {
    /** Ask the backend SDK bridge for a one-time URL and continue in the current tab. */
    if (!server) return;
    setOauthBusy(true);
    try {
      const started = await tenantClient.post<MCPOAuthStartResult>(
        `/api/enterprise/mcp-servers/${server.id}/oauth/start`,
        { tenant_id: tenantId },
      );
      setOauthStatus({
        server_id: server.id,
        auth_mode: 'oauth_personal',
        state: 'authorizing',
        expires_at: started.expires_at,
        scopes: [],
        error_code: null,
      });
      window.open(started.authorization_url, '_self');
    } catch (error) {
      console.error('[tools-page] start MCP OAuth failed', error);
      toast.error(toolErrorDescriptor(error, TOOLS_MESSAGE_IDS.toastOAuthStartFailed));
    } finally {
      setOauthBusy(false);
    }
  }

  async function disconnectOAuth(): Promise<void> {
    /** Remove only the signed-in user's grant, then refresh its non-secret state. */
    if (!server) return;
    setOauthBusy(true);
    try {
      await tenantClient.delete(
        `/api/enterprise/mcp-servers/${server.id}/oauth?tenant_id=${tenantId}`,
      );
      await loadOAuthStatus(server.id);
      toast.success(createMessageDescriptor(TOOLS_MESSAGE_IDS.toastOAuthDisconnected));
    } catch (error) {
      console.error('[tools-page] disconnect MCP OAuth failed', error);
      toast.error(toolErrorDescriptor(error, TOOLS_MESSAGE_IDS.toastOAuthDisconnectFailed));
    } finally {
      setOauthBusy(false);
    }
  }

  function buildConnection(): MCPServerConnection | null {
    let headers: Record<string, string>;
    let env: Record<string, string>;
    try {
      headers = parseJson<Record<string, string>>(values.headers, {});
      env = parseJson<Record<string, string>>(values.env, {});
    } catch {
      toast.error(createMessageDescriptor(TOOLS_MESSAGE_IDS.toastHeadersEnvInvalid));
      return null;
    }
    const args = parseMcpArgs(values.args);
    if (isStdio) {
      return {
        transport: values.transport,
        url: null,
        headers,
        command: String(values.command || '').trim() || null,
        args,
        env,
        cwd: String(values.cwd || '').trim() || null,
      };
    }
    return {
      transport: values.transport,
      url: String(values.url || '').trim() || null,
      headers,
      command: null,
      args,
      env,
      cwd: null,
    };
  }

  function buildPayload(): { payload: Record<string, unknown>; connection: MCPServerConnection } | null {
    const connection = buildConnection();
    if (!connection) return null;
    return {
      connection,
      payload: {
        name: String(values.name || '').trim(),
        display_name: values.display_name,
        description: values.description,
        bucket: values.bucket,
        connection,
        apps_mode: values.apps_mode,
        auth_mode: values.auth_mode,
        oauth_client_id: values.oauth_client_id.trim() || null,
        oauth_client_metadata_url: values.oauth_client_metadata_url.trim() || null,
        oauth_redirect_uri: values.oauth_redirect_uri.trim() || null,
        capability_scope: values.capability_scope,
        enabled: values.enabled,
      },
    };
  }

  async function save() {
    if (!String(values.name || '').trim()) {
      toast.error(createMessageDescriptor(TOOLS_MESSAGE_IDS.toastMcpNameRequired));
      return;
    }
    const built = buildPayload();
    if (!built) return;
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return;
    saveControllerRef.current?.abort();
    const controller = new AbortController();
    saveControllerRef.current = controller;
    setSaving(true);
    try {
      const saved = isEdit && serverId
        ? await tenantClient.put<MCPServerRead>(`/api/enterprise/mcp-servers/${serverId}`, built.payload, { signal: controller.signal })
        : await tenantClient.post<MCPServerRead>('/api/enterprise/mcp-servers', built.payload, { signal: controller.signal });
      if (!isCurrentTenantRequest(context, generation, controller)) return;
      toast.success(createMessageDescriptor(TOOLS_MESSAGE_IDS.toastSaved));
      announceEnterpriseCapabilityCatalogChange({
        resourceType: 'tool',
        agentId: readEmployeeScope(tenantId, userId) || undefined,
      });
      setServer(saved);
      setValues(serverToFormValues(saved));
      if (saved.auth_mode === 'oauth_personal') {
        void loadOAuthStatus(saved.id);
      } else {
        setOauthStatus(null);
      }
      if (!isEdit) {
        navigate(`/enterprise/tools/mcp/${saved.id}/edit`, { replace: true });
      }
    } catch (error) {
      if (!isCurrentTenantRequest(context, generation, controller)) return;
      console.error('[tools-page] save MCP server failed', error);
      toast.error(toolErrorDescriptor(error, TOOLS_MESSAGE_IDS.toastSaveFailed));
    } finally {
      if (saveControllerRef.current === controller) saveControllerRef.current = null;
      if (isCurrentTenantRequest(context, generation, controller)) setSaving(false);
    }
  }

  async function discover() {
    const built = buildPayload();
    if (!built) return;
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return;
    discoverControllerRef.current?.abort();
    const controller = new AbortController();
    discoverControllerRef.current = controller;
    setDiscovering(true);
    try {
      const agentQuery = currentAgentQuery(tenantId, userId);
      const response = server
        ? await tenantClient.post<MCPDiscoverResponse>(`/api/enterprise/mcp-servers/${server.id}/discover${agentQuery ? `?${agentQuery.slice(1)}` : ''}`, {
            tenant_id: tenantId,
            connection: built.connection,
            apps_mode: values.apps_mode,
          }, { signal: controller.signal })
        : await tenantClient.post<MCPDiscoverResponse>('/api/enterprise/mcp-servers/discover', {
            tenant_id: tenantId,
            connection: built.connection,
            apps_mode: values.apps_mode,
          }, { signal: controller.signal });
      if (!isCurrentTenantRequest(context, generation, controller)) return;
      if (!response.success) {
        toast.error(toolErrorDescriptor(response.error, TOOLS_MESSAGE_IDS.toastDiscoverFailed));
        return;
      }
      setDiscovered(response.tools.map((tool) => ({ ...tool, selected: !tool.imported })));
      toast.success(createMessageDescriptor(TOOLS_MESSAGE_IDS.toastDiscovered, {
        count: response.tools.length,
      }));
    } catch (error) {
      if (!isCurrentTenantRequest(context, generation, controller)) return;
      console.error('[tools-page] discover MCP tools failed', error);
      toast.error(toolErrorDescriptor(error, TOOLS_MESSAGE_IDS.toastDiscoverFailed));
    } finally {
      if (discoverControllerRef.current === controller) discoverControllerRef.current = null;
      if (isCurrentTenantRequest(context, generation, controller)) setDiscovering(false);
    }
  }

  async function sync() {
    if (!server) {
      toast.warning(createMessageDescriptor(TOOLS_MESSAGE_IDS.toastSaveBeforeSync));
      return;
    }
    const selectedNames = discovered.filter((tool) => tool.selected).map((tool) => tool.name);
    if (discovered.length > 0 && selectedNames.length === 0) {
      toast.warning(createMessageDescriptor(TOOLS_MESSAGE_IDS.toastSelectToolToSync));
      return;
    }
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return;
    syncControllerRef.current?.abort();
    const controller = new AbortController();
    syncControllerRef.current = controller;
    setSyncing(true);
    try {
      const agentQuery = currentAgentQuery(tenantId, userId);
      const response = await tenantClient.post<MCPSyncResponse>(
        `/api/enterprise/mcp-servers/${server.id}/sync${agentQuery ? `?${agentQuery.slice(1)}` : ''}`,
        {
          tenant_id: tenantId,
          tool_names: discovered.length ? selectedNames : null,
        },
        { signal: controller.signal },
      );
      if (!isCurrentTenantRequest(context, generation, controller)) return;
      if (!response.success) {
        toast.error(toolErrorDescriptor(response.error, TOOLS_MESSAGE_IDS.toastSyncFailed));
        return;
      }
      toast.success(createMessageDescriptor(TOOLS_MESSAGE_IDS.toastSynced, {
        importedCount: response.imported.length,
        updatedCount: response.updated.length,
      }));
      announceEnterpriseCapabilityCatalogChange({
        resourceType: 'tool',
        agentId: readEmployeeScope(tenantId, userId) || undefined,
      });
      try {
        const refreshed = await tenantClient.get<MCPServerRead>(
          `/api/enterprise/mcp-servers/${server.id}?tenant_id=${tenantId}`,
          { signal: controller.signal },
        );
        if (isCurrentTenantRequest(context, generation, controller)) setServer(refreshed);
      } catch {
        // ignore refresh failure
      }
      if (!isCurrentTenantRequest(context, generation, controller)) return;
      await discover();
    } catch (error) {
      if (!isCurrentTenantRequest(context, generation, controller)) return;
      console.error('[tools-page] sync MCP tools failed', error);
      toast.error(toolErrorDescriptor(error, TOOLS_MESSAGE_IDS.toastSyncFailed));
    } finally {
      if (syncControllerRef.current === controller) syncControllerRef.current = null;
      if (isCurrentTenantRequest(context, generation, controller)) setSyncing(false);
    }
  }

  const discoveredColumns: DataTableColumn<DiscoveredRow>[] = [
    {
      key: 'selected',
      title: '',
      width: 40,
      render: (row) => (
        <Checkbox
          checked={row.selected}
          onCheckedChange={(next) =>
            setDiscovered((prev) =>
              prev.map((item) => (item.name === row.name ? { ...item, selected: next === true } : item)),
            )
          }
          aria-label={t(TOOLS_MESSAGE_IDS.selectTool, { name: row.name })}
        />
      ),
    },
    {
      key: 'name',
      title: t(TOOLS_MESSAGE_IDS.discoveryTool),
      width: 220,
      className: 'whitespace-normal',
      render: (row) => (
        <span className="block wrap-break-word font-medium text-[#18181a]" title={row.name}>
          <RawIdentifier value={row.name} />
        </span>
      ),
    },
    {
      key: 'description',
      title: t(TOOLS_MESSAGE_IDS.discoveryDescriptionColumn),
      className: 'whitespace-normal',
      render: (row) => (
        <span className="block wrap-break-word text-[#858b9c]">
          {row.description ? <RawContent value={row.description} /> : t(TOOLS_MESSAGE_IDS.mcpNoDescription)}
        </span>
      ),
    },
    {
      key: 'app',
      title: t(TOOLS_MESSAGE_IDS.discoveryApp),
      width: 116,
      render: (row) => row.app ? (
        <StatusBadge tone="blue">
          {row.app.visibility.includes('model')
            ? t(TOOLS_MESSAGE_IDS.appsModelAndApp)
            : t(TOOLS_MESSAGE_IDS.appsOnly)}
        </StatusBadge>
      ) : (
        <span className="text-[#a1a6b3]">—</span>
      ),
    },
    {
      key: 'imported',
      title: t(TOOLS_MESSAGE_IDS.discoveryStatus),
      width: 96,
      render: (row) => (
        <StatusBadge tone={row.imported ? 'green' : 'gray'}>
          {t(row.imported ? TOOLS_MESSAGE_IDS.statusImported : TOOLS_MESSAGE_IDS.statusNotImported)}
        </StatusBadge>
      ),
    },
  ];

  return (
    <div className="min-h-full box-border px-[48px] pt-[32px] pb-[43px] max-[900px]:px-[16px]" aria-busy={loading}>
      <AppHeader
        onLogout={onLogout}
        userName={currentUser?.username}
        title={t(isEdit ? TOOLS_MESSAGE_IDS.editorEditMcpTitle : TOOLS_MESSAGE_IDS.editorNewMcpTitle)}
        description={t(TOOLS_MESSAGE_IDS.editorDescriptionMcp)}
      />
      <div className="mt-[20px] mb-[16px] flex flex-wrap justify-end gap-[16px]">
        <UIButton variant="outline" onClick={() => navigate('/enterprise/tools')} className={RETURN_BUTTON_CLASS}>
          <IconArrowRight className="size-3.5 rotate-180" />
          {t(TOOLS_MESSAGE_IDS.actionBack)}
        </UIButton>
        <UIButton disabled={saving} onClick={() => void save()} className={PRIMARY_BUTTON_CLASS}>
          {t(TOOLS_MESSAGE_IDS.actionSave)}
        </UIButton>
      </div>
      {!isEdit && <ToolTypeSwitcher active="mcp" />}
      <div className="grid grid-cols-1 items-start gap-[20px] xl:grid-cols-2">
        <SectionCard title={t(TOOLS_MESSAGE_IDS.sectionConnection)} loading={loading && isEdit && !server}>
          <div className="flex flex-col gap-[16px]">
            <div className="grid grid-cols-1 gap-[16px] sm:grid-cols-2">
              <Field
                label={t(TOOLS_MESSAGE_IDS.fieldMcpName)}
                htmlFor="mcp-name"
                hint={t(isEdit ? TOOLS_MESSAGE_IDS.hintMcpNameLocked : TOOLS_MESSAGE_IDS.hintMcpNameRules)}
              >
                <Input
                  id="mcp-name"
                  placeholder={createMessageDescriptor(TOOLS_MESSAGE_IDS.placeholderMcpName)}
                  disabled={isEdit}
                  value={values.name}
                  onChange={(event) => setField('name', sanitizeMcpName(event.target.value))}
                />
              </Field>
              <Field label={t(TOOLS_MESSAGE_IDS.fieldMcpDisplayName)} htmlFor="mcp-display-name">
                <Input
                  id="mcp-display-name"
                  placeholder={t(TOOLS_MESSAGE_IDS.placeholderMcpDisplayName)}
                  value={values.display_name}
                  onChange={(event) => setField('display_name', event.target.value)}
                />
              </Field>
            </div>

            <Field label={t(TOOLS_MESSAGE_IDS.fieldMcpDescription)} htmlFor="mcp-description">
              <Textarea
                id="mcp-description"
                rows={2}
                placeholder={t(TOOLS_MESSAGE_IDS.placeholderMcpDescription)}
                value={values.description}
                onChange={(event) => setField('description', event.target.value)}
              />
            </Field>

            <Field label={t(TOOLS_MESSAGE_IDS.fieldMcpBucket)} htmlFor="mcp-bucket">
              <Input
                id="mcp-bucket"
                placeholder={t(TOOLS_MESSAGE_IDS.placeholderMcpBucket)}
                value={values.bucket}
                onChange={(event) => setField('bucket', event.target.value)}
              />
            </Field>

            <CapabilityScopeControl
              value={values.capability_scope}
              onChange={(value) => setField('capability_scope', value)}
              resourceType="tool"
            />

            <div
              className={cn(
                'rounded-[14px] border px-[16px] py-[14px] transition-colors',
                values.apps_mode === 'auto'
                  ? 'border-[#b9ded4] bg-[#f1faf7]'
                  : 'border-[#e5e7eb] bg-[#fafbfc]',
              )}
            >
              <div className="flex items-center justify-between gap-[18px]">
                <div className="flex min-w-0 flex-col gap-[4px]">
                  <div className="flex flex-wrap items-center gap-[8px]">
                    <span className={FIELD_LABEL_CLASS}>{t(TOOLS_MESSAGE_IDS.appsProtocol)}</span>
                    <StatusBadge tone={values.apps_mode === 'auto' ? 'green' : 'gray'}>
                      {t(values.apps_mode === 'auto' ? TOOLS_MESSAGE_IDS.appsEnabled : TOOLS_MESSAGE_IDS.appsDisabled)}
                    </StatusBadge>
                  </div>
                  <span className={HINT_CLASS}>
                    {t(TOOLS_MESSAGE_IDS.appsProtocolHint)}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-[10px]">
                  <span className="text-[12px] font-medium text-[#667085]">
                    {t(values.apps_mode === 'auto' ? TOOLS_MESSAGE_IDS.appsValueOn : TOOLS_MESSAGE_IDS.appsValueOff)}
                  </span>
                  <Switch
                    aria-label={t(TOOLS_MESSAGE_IDS.appsToggleAria)}
                    checked={values.apps_mode === 'auto'}
                    onCheckedChange={(next) => setField('apps_mode', next ? 'auto' : 'disabled')}
                  />
                </div>
              </div>
            </div>

            <Field
              label={t(TOOLS_MESSAGE_IDS.fieldTransport)}
              hint={transportOption ? t(transportOption.hintId) : undefined}
            >
              <UISelect
                value={values.transport}
                onValueChange={(value) => {
                  const transport = value as MCPTransport;
                  setField('transport', transport);
                  if (transport !== 'streamable_http' && values.auth_mode === 'oauth_personal') {
                    setField('auth_mode', 'none');
                  }
                }}
              >
                <SelectTrigger className={cn(SELECT_TRIGGER_CLASS, 'w-full')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TRANSPORT_OPTIONS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {t(item.labelId)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </UISelect>
            </Field>

            <Field
              label={t(TOOLS_MESSAGE_IDS.fieldMcpAuthMode)}
              hint={t(TOOLS_MESSAGE_IDS.hintMcpAuthMode)}
            >
              <UISelect
                value={values.auth_mode}
                onValueChange={(value) => {
                  const authMode = value as MCPAuthMode;
                  setField('auth_mode', authMode);
                  if (authMode === 'oauth_personal') setField('transport', 'streamable_http');
                }}
              >
                <SelectTrigger className={cn(SELECT_TRIGGER_CLASS, 'w-full')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t(TOOLS_MESSAGE_IDS.oauthModeNone)}</SelectItem>
                  <SelectItem value="oauth_personal">
                    {t(TOOLS_MESSAGE_IDS.oauthModePersonal)}
                  </SelectItem>
                </SelectContent>
              </UISelect>
            </Field>

            {isRemote && (
              <>
                <Field label={t(TOOLS_MESSAGE_IDS.fieldMcpUrl)} htmlFor="mcp-url">
                  <Input
                    id="mcp-url"
                    placeholder={createMessageDescriptor(TOOLS_MESSAGE_IDS.placeholderMcpUrl)}
                    value={values.url}
                    onChange={(event) => setField('url', event.target.value)}
                  />
                </Field>
                <Field label={t(TOOLS_MESSAGE_IDS.fieldMcpHeaders)} htmlFor="mcp-headers">
                  <Textarea
                    id="mcp-headers"
                    rows={4}
                    className={MONO_INPUT_CLASS}
                    value={values.headers}
                    onChange={(event) => setField('headers', event.target.value)}
                  />
                </Field>
              </>
            )}

            {isOAuth && (
              <div className="flex flex-col gap-[14px] rounded-[14px] border border-[#dce6f7] bg-[#f7f9fd] p-[16px]">
                <div className="flex flex-col gap-[4px]">
                  <span className="text-[14px] font-medium text-[#18181a]">
                    {t(TOOLS_MESSAGE_IDS.sectionOAuth)}
                  </span>
                  <span className={HINT_CLASS}>
                    {t(TOOLS_MESSAGE_IDS.hintMcpOAuthPublicOnly)}
                  </span>
                </div>
                <div className="grid grid-cols-1 gap-[14px] sm:grid-cols-2">
                  <Field
                    label={t(TOOLS_MESSAGE_IDS.fieldMcpOAuthClientId)}
                    htmlFor="mcp-oauth-client-id"
                  >
                    <Input
                      id="mcp-oauth-client-id"
                      placeholder={t(TOOLS_MESSAGE_IDS.placeholderMcpOAuthClientId)}
                      value={values.oauth_client_id}
                      onChange={(event) => setField('oauth_client_id', event.target.value)}
                    />
                  </Field>
                  <Field
                    label={t(TOOLS_MESSAGE_IDS.fieldMcpOAuthClientMetadataUrl)}
                    htmlFor="mcp-oauth-client-metadata-url"
                  >
                    <Input
                      id="mcp-oauth-client-metadata-url"
                      placeholder={t(TOOLS_MESSAGE_IDS.placeholderMcpOAuthClientMetadataUrl)}
                      value={values.oauth_client_metadata_url}
                      onChange={(event) => setField('oauth_client_metadata_url', event.target.value)}
                    />
                  </Field>
                </div>
                <Field
                  label={t(TOOLS_MESSAGE_IDS.fieldMcpOAuthRedirectUri)}
                  htmlFor="mcp-oauth-redirect-uri"
                >
                  <Input
                    id="mcp-oauth-redirect-uri"
                    placeholder={t(TOOLS_MESSAGE_IDS.placeholderMcpOAuthRedirectUri)}
                    value={values.oauth_redirect_uri}
                    onChange={(event) => setField('oauth_redirect_uri', event.target.value)}
                  />
                </Field>
                {server && (
                  <div className="flex flex-wrap items-center justify-between gap-[12px] rounded-[12px] border border-[#e5e7eb] bg-white px-[14px] py-[12px]">
                    <div className="flex min-w-0 flex-col gap-[4px]">
                      <StatusBadge tone={oauthStatus?.state === 'connected' ? 'green' : oauthStatus?.state === 'reconnect_required' ? 'red' : 'gray'}>
                        {t(
                          oauthStatus?.state === 'connected'
                            ? TOOLS_MESSAGE_IDS.statusOAuthConnected
                            : oauthStatus?.state === 'authorizing'
                              ? TOOLS_MESSAGE_IDS.statusOAuthAuthorizing
                              : oauthStatus?.state === 'reconnect_required'
                                ? TOOLS_MESSAGE_IDS.statusOAuthReconnectRequired
                                : TOOLS_MESSAGE_IDS.statusOAuthDisconnected,
                        )}
                      </StatusBadge>
                      <span className={HINT_CLASS}>{t(TOOLS_MESSAGE_IDS.hintMcpOAuthStatus)}</span>
                    </div>
                    <div className="flex flex-wrap gap-[8px]">
                      {oauthStatus?.state === 'connected' || oauthStatus?.state === 'authorizing' ? (
                        <UIButton
                          variant="outline"
                          disabled={oauthBusy}
                          onClick={() => void disconnectOAuth()}
                          className={RETURN_BUTTON_CLASS}
                        >
                          {t(TOOLS_MESSAGE_IDS.actionOAuthDisconnect)}
                        </UIButton>
                      ) : (
                        <UIButton
                          disabled={oauthBusy || oauthConfigurationDirty}
                          onClick={() => void beginOAuth()}
                          className={PRIMARY_BUTTON_CLASS}
                        >
                          {t(
                            oauthStatus?.state === 'reconnect_required'
                              ? TOOLS_MESSAGE_IDS.actionOAuthReconnect
                              : TOOLS_MESSAGE_IDS.actionOAuthConnect,
                          )}
                        </UIButton>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {isStdio && (
              <>
                <Field label={t(TOOLS_MESSAGE_IDS.fieldCommand)} htmlFor="mcp-command">
                  <Input
                    id="mcp-command"
                  placeholder={createMessageDescriptor(TOOLS_MESSAGE_IDS.placeholderMcpCommand)}
                    value={values.command}
                    onChange={(event) => setField('command', event.target.value)}
                  />
                </Field>
                <Field label={t(TOOLS_MESSAGE_IDS.fieldArgs)} htmlFor="mcp-args" hint={t(TOOLS_MESSAGE_IDS.hintMcpArgs)}>
                  <Textarea
                    id="mcp-args"
                    rows={4}
                    className={MONO_INPUT_CLASS}
                    placeholder={createMessageDescriptor(TOOLS_MESSAGE_IDS.placeholderMcpArgs)}
                    value={values.args}
                    onChange={(event) => setField('args', event.target.value)}
                  />
                </Field>
                <Field label={t(TOOLS_MESSAGE_IDS.fieldEnv)} htmlFor="mcp-env">
                  <Textarea
                    id="mcp-env"
                    rows={4}
                    className={MONO_INPUT_CLASS}
                    value={values.env}
                    onChange={(event) => setField('env', event.target.value)}
                  />
                </Field>
                <Field
                  label={t(TOOLS_MESSAGE_IDS.fieldCwd)}
                  htmlFor="mcp-cwd"
                  hint={t(TOOLS_MESSAGE_IDS.hintMcpCwd)}
                >
                  <Input
                    id="mcp-cwd"
                    placeholder={createMessageDescriptor(TOOLS_MESSAGE_IDS.placeholderMcpCwd)}
                    value={values.cwd}
                    onChange={(event) => setField('cwd', event.target.value)}
                  />
                </Field>
              </>
            )}

            <div className="flex items-center justify-between rounded-[12px] border border-[#eceef1] bg-[#fafbfc] px-[14px] py-[12px]">
              <div className="flex flex-col gap-[2px]">
                <span className={FIELD_LABEL_CLASS}>{t(TOOLS_MESSAGE_IDS.fieldEnabledToolGroup)}</span>
                <span className={HINT_CLASS}>{t(TOOLS_MESSAGE_IDS.hintEnabledToolGroup)}</span>
              </div>
              <Switch checked={values.enabled} onCheckedChange={(next) => setField('enabled', next)} />
            </div>
          </div>
        </SectionCard>

        <SectionCard
          title={t(TOOLS_MESSAGE_IDS.sectionDiscovery)}
          bodyClassName="flex flex-col gap-[14px]"
          extra={(
            <div className="flex items-center gap-[8px]">
              <UIButton variant="outline" disabled={discovering} onClick={() => void discover()} className={RETURN_BUTTON_CLASS}>
                <IconRefresh className="size-[14px] shrink-0" />
                {t(TOOLS_MESSAGE_IDS.actionDiscover)}
              </UIButton>
              <UIButton disabled={!server || syncing} onClick={() => void sync()} className={PRIMARY_BUTTON_CLASS}>
                {t(TOOLS_MESSAGE_IDS.actionSync)}
              </UIButton>
            </div>
          )}
        >
          <p className={HINT_CLASS}>
            {t(server ? TOOLS_MESSAGE_IDS.discoveryDescriptionSaved : TOOLS_MESSAGE_IDS.discoveryDescription)}
          </p>
          {discovered.length ? (
            <DataTable
              aria-label={t(TOOLS_MESSAGE_IDS.discoveryListAria)}
              columns={discoveredColumns}
              data={discovered}
              rowKey={(row) => row.name}
              loading={discovering}
              emptyText={t(TOOLS_MESSAGE_IDS.discoveryEmpty)}
            />
          ) : (
            <div className="grid min-h-[180px] place-items-center rounded-[12px] border border-dashed border-[#eceef1] p-[20px] text-center text-[13px] text-[#858b9c]">
              {t(TOOLS_MESSAGE_IDS.discoveryEmpty)}
            </div>
          )}
        </SectionCard>
      </div>
    </div>
  );
}

/** 工具编辑字段；产品标签走当前 locale，名称、URL、协议和 JSON 保持原始输入语义。 */
function ToolFormFields({
  values,
  setField,
  bucketValues,
  lockName = false,
}: {
  values: ToolFormValues;
  setField: <K extends keyof ToolFormValues>(name: K, value: ToolFormValues[K]) => void;
  bucketValues: string[];
  lockName?: boolean;
}) {
  const { t } = useAppIntl();
  return (
    <div className="flex flex-col gap-[16px]">
      <div className="grid grid-cols-1 gap-[16px] sm:grid-cols-2">
        <Field label={t(TOOLS_MESSAGE_IDS.fieldName)} htmlFor="tool-name">
          <div className="relative">
            <ToolOutlined className="pointer-events-none absolute left-[10px] top-1/2 -translate-y-1/2 text-[#858b9c]" />
            <Input
              id="tool-name"
              className="pl-[30px]"
              placeholder={createMessageDescriptor(TOOLS_MESSAGE_IDS.placeholderToolName)}
              value={values.name || ''}
              disabled={lockName}
              onChange={(event) => {
                if (lockName) return;
                setField('name', event.target.value);
              }}
            />
          </div>
        </Field>
        <Field label={t(TOOLS_MESSAGE_IDS.fieldDisplayName)} htmlFor="tool-display-name">
          <Input
            id="tool-display-name"
            placeholder={t(TOOLS_MESSAGE_IDS.placeholderToolDisplayName)}
            value={values.display_name || ''}
            onChange={(event) => setField('display_name', event.target.value)}
          />
        </Field>
      </div>

      <div className="grid grid-cols-1 gap-[16px] sm:grid-cols-2">
        <Field label={t(TOOLS_MESSAGE_IDS.fieldBucket)} htmlFor="tool-bucket">
          <Input
            id="tool-bucket"
            list="tool-bucket-options"
            placeholder={t(TOOLS_MESSAGE_IDS.placeholderToolBucket)}
            value={values.bucket || ''}
            onChange={(event) => setField('bucket', event.target.value)}
          />
          <datalist id="tool-bucket-options">
            {bucketValues.map((value) => {
              const label = value || t(TOOLS_MESSAGE_IDS.statusUnbucketed);
              return <option key={value || '__unbucketed__'} value={value} label={label}>{label}</option>;
            })}
          </datalist>
        </Field>
      </div>

      <Field label={t(TOOLS_MESSAGE_IDS.fieldDescription)} htmlFor="tool-description">
        <Textarea
          id="tool-description"
          rows={2}
          placeholder={t(TOOLS_MESSAGE_IDS.placeholderToolDescription)}
          value={values.description || ''}
          onChange={(event) => setField('description', event.target.value)}
        />
      </Field>

      <div
        className={cn(
          'grid grid-cols-1 gap-[16px]',
          values.tool_type === 'http' && 'sm:grid-cols-[140px_minmax(0,1fr)]',
        )}
      >
        {values.tool_type === 'http' && <Field label={t(TOOLS_MESSAGE_IDS.fieldHttpMethod)}>
          <UISelect value={values.method} onValueChange={(value) => setField('method', value)}>
            <SelectTrigger className={cn(SELECT_TRIGGER_CLASS, 'w-full')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((value) => (
                <SelectItem key={value} value={value}>{value}</SelectItem>
              ))}
            </SelectContent>
          </UISelect>
        </Field>}
        <Field label={t(values.tool_type === 'a2a' ? TOOLS_MESSAGE_IDS.fieldA2AEndpoint : TOOLS_MESSAGE_IDS.fieldUrl)} htmlFor="tool-url">
          <Input
            id="tool-url"
            placeholder={createMessageDescriptor(
              values.tool_type === 'a2a'
                ? TOOLS_MESSAGE_IDS.placeholderToolA2AUrl
                : TOOLS_MESSAGE_IDS.placeholderToolUrl,
            )}
            value={values.url || ''}
            onChange={(event) => setField('url', event.target.value)}
          />
        </Field>
      </div>

      {values.tool_type === 'a2a' && <A2AConnectionFields values={values} setField={setField} />}

      <Field
        label={t(TOOLS_MESSAGE_IDS.fieldTimeout)}
        htmlFor="tool-timeout-seconds"
        hint={t(TOOLS_MESSAGE_IDS.hintTimeout)}
      >
        <Input
          id="tool-timeout-seconds"
          type="number"
          min={1}
          max={3600}
          step={1}
          value={values.timeout_seconds}
          onChange={(event) => {
            const next = Number(event.target.value);
            setField('timeout_seconds', Number.isFinite(next) ? next : 8);
          }}
        />
      </Field>

      <div className="grid grid-cols-1 gap-[16px] sm:grid-cols-2">
        <Field label={t(TOOLS_MESSAGE_IDS.fieldHeaders)} htmlFor="tool-headers">
          <Textarea
            id="tool-headers"
            rows={4}
            className={MONO_INPUT_CLASS}
            value={values.headers}
            onChange={(event) => setField('headers', event.target.value)}
          />
        </Field>
        <Field label={t(TOOLS_MESSAGE_IDS.fieldAuth)} htmlFor="tool-auth">
          <Textarea
            id="tool-auth"
            rows={4}
            className={MONO_INPUT_CLASS}
            value={values.auth}
            onChange={(event) => setField('auth', event.target.value)}
          />
        </Field>
      </div>

      <div className="grid grid-cols-1 gap-[16px] sm:grid-cols-2">
        <Field label={t(TOOLS_MESSAGE_IDS.fieldInputSchema)} htmlFor="tool-input-schema">
          <Textarea
            id="tool-input-schema"
            rows={5}
            className={MONO_INPUT_CLASS}
            value={values.input_schema}
            onChange={(event) => setField('input_schema', event.target.value)}
          />
        </Field>
        <Field label={t(TOOLS_MESSAGE_IDS.fieldOutputSchema)} htmlFor="tool-output-schema">
          <Textarea
            id="tool-output-schema"
            rows={5}
            className={MONO_INPUT_CLASS}
            value={values.output_schema}
            onChange={(event) => setField('output_schema', event.target.value)}
          />
        </Field>
      </div>

      <Field label={t(TOOLS_MESSAGE_IDS.fieldAllowedSkills)} htmlFor="tool-allowed-skills" hint={t(TOOLS_MESSAGE_IDS.hintAllowedSkills)}>
        <Input
          id="tool-allowed-skills"
          placeholder={createMessageDescriptor(TOOLS_MESSAGE_IDS.placeholderAllowedSkills)}
          value={values.allowed_skills || ''}
          onChange={(event) => setField('allowed_skills', event.target.value)}
        />
      </Field>

      <CapabilityScopeControl
        value={normalizeCapabilityScope(values.capability_scope)}
        onChange={(value) => setField('capability_scope', value)}
        resourceType="tool"
      />

      <div className="flex items-center justify-between rounded-[12px] border border-[#eceef1] bg-[#fafbfc] px-[14px] py-[12px]">
        <div className="flex flex-col gap-[2px]">
          <span className={FIELD_LABEL_CLASS}>{t(TOOLS_MESSAGE_IDS.fieldEnabledTool)}</span>
          <span className={HINT_CLASS}>{t(TOOLS_MESSAGE_IDS.hintEnabledTool)}</span>
        </div>
        <Switch checked={values.enabled} onCheckedChange={(next) => setField('enabled', next)} />
      </div>
    </div>
  );
}

/** 配置 A2A 长任务协议；协议字段与远端地址是原始技术数据，说明文字随 UI locale 变化。 */
function A2AConnectionFields({
  values,
  setField,
}: {
  values: ToolFormValues;
  setField: <K extends keyof ToolFormValues>(name: K, value: ToolFormValues[K]) => void;
}) {
  const { t } = useAppIntl();
  const tenantContext = useTenantSession();
  const tenantClient = useMemo(() => createTenantClient(tenantContext), [tenantContext]);
  const tenantId = tenantContext?.tenantId || '';
  const userId = tenantContext?.userId || '';
  const [adapter, setAdapter] = useState<CodexA2AAdapterRead | null>(null);
  const adapterControllerRef = useRef<AbortController | null>(null);
  const config = safeJsonObject(values.mcp_config);
  const updateConfig = (patch: Record<string, unknown>) => {
    setField('mcp_config', JSON.stringify({ ...config, ...patch }, null, 2));
  };

  useEffect(() => {
    if (!tenantContext) return;
    const context = tenantContext;
    const generation = context.generation;
    adapterControllerRef.current?.abort();
    const controller = new AbortController();
    tenantClient.get<CodexA2AAdapterRead>(
      `/api/enterprise/tools/a2a/codex-adapter?tenant_id=${tenantId}${currentAgentQuery(tenantId, userId)}`,
      { signal: controller.signal },
    )
      .then((nextAdapter) => {
        if (isCurrentTenantRequest(context, generation, controller)) setAdapter(nextAdapter);
      })
      .catch(() => {
        if (isCurrentTenantRequest(context, generation, controller)) setAdapter(null);
      })
      .finally(() => {
        if (adapterControllerRef.current === controller) adapterControllerRef.current = null;
      });
    adapterControllerRef.current = controller;
    return () => controller.abort();
  }, [tenantClient, tenantContext, tenantId, userId]);

  const useCodex = () => {
    if (!adapter) return;
    setField('url', new URL(adapter.endpoint_url, window.location.origin).toString());
    updateConfig({
      agent_card_url: new URL(adapter.agent_card_url, window.location.origin).toString(),
      discover_agent_card: true,
      require_agent_card: true,
      streaming: true,
      subscribe: true,
      a2a_version: '1.0',
      accepted_output_modes: ['text/plain', 'application/json', 'application/octet-stream'],
    });
    setField('timeout_seconds', Math.min(3600, Math.max(1, adapter.timeout_seconds)));
  };

  return (
    <div className="flex flex-col gap-[14px] rounded-[14px] border border-sky-200 bg-sky-50/40 p-[16px]">
      <div className="flex flex-wrap items-start justify-between gap-[12px]">
        <div>
          <p className="text-[13px] font-semibold text-[#2f3442]">{t(TOOLS_MESSAGE_IDS.a2aConnectionTitle)}</p>
          <p className="mt-[4px] text-[11px] leading-[17px] text-[#687083]">{t(TOOLS_MESSAGE_IDS.a2aConnectionDescription)}</p>
        </div>
        {adapter && (
          <UIButton type="button" variant="outline" size="sm" onClick={useCodex} disabled={!adapter.available}>
            <TerminalSquare className="size-[14px]" />
            {t(adapter.available ? TOOLS_MESSAGE_IDS.a2aCodexConnect : TOOLS_MESSAGE_IDS.a2aCodexDisabled)}
          </UIButton>
        )}
      </div>
      <div className="grid gap-[12px] md:grid-cols-2">
        <SwitchRowCompact label={t(TOOLS_MESSAGE_IDS.a2aDiscoverAgentCard)} hint={t(TOOLS_MESSAGE_IDS.hintA2AAgentCard)} checked={config.discover_agent_card !== false} onChange={(checked) => updateConfig({ discover_agent_card: checked })} />
        <SwitchRowCompact label={t(TOOLS_MESSAGE_IDS.a2aRequireAgentCard)} hint={t(TOOLS_MESSAGE_IDS.hintA2AForceAgentCard)} checked={config.require_agent_card === true} onChange={(checked) => updateConfig({ require_agent_card: checked })} />
        <SwitchRowCompact label={t(TOOLS_MESSAGE_IDS.a2aStreaming)} hint={t(TOOLS_MESSAGE_IDS.hintA2AStreaming)} checked={config.streaming !== false} onChange={(checked) => updateConfig({ streaming: checked })} />
        <SwitchRowCompact label={t(TOOLS_MESSAGE_IDS.a2aSubscribe)} hint={t(TOOLS_MESSAGE_IDS.hintA2ASubscribe)} checked={config.subscribe !== false} onChange={(checked) => updateConfig({ subscribe: checked })} />
      </div>
      <div className="grid gap-[12px] md:grid-cols-2">
        <Field label={t(TOOLS_MESSAGE_IDS.a2aAgentCardOptional)} htmlFor="tool-a2a-card-url">
          <Input
            id="tool-a2a-card-url"
            value={String(config.agent_card_url || '')}
            placeholder={createMessageDescriptor(TOOLS_MESSAGE_IDS.placeholderA2ACardUrl)}
            onChange={(event) => updateConfig({ agent_card_url: event.target.value })}
          />
        </Field>
        <Field label={t(TOOLS_MESSAGE_IDS.a2aPollInterval)} htmlFor="tool-a2a-poll">
          <Input id="tool-a2a-poll" type="number" min={0.1} max={30} step={0.1} value={Number(config.poll_interval_seconds || 0.5)} onChange={(event) => updateConfig({ poll_interval_seconds: Number(event.target.value) || 0.5 })} />
        </Field>
      </div>
      <Field label={t(TOOLS_MESSAGE_IDS.a2aAdvancedConfig)} htmlFor="tool-a2a-config" hint={t(TOOLS_MESSAGE_IDS.hintAdvancedConfig)}>
        <Textarea
          id="tool-a2a-config"
          rows={7}
          className={MONO_INPUT_CLASS}
          value={values.mcp_config}
          onChange={(event) => setField('mcp_config', event.target.value)}
          placeholder={createMessageDescriptor(TOOLS_MESSAGE_IDS.placeholderA2AConfig)}
        />
      </Field>
    </div>
  );
}

function SwitchRowCompact({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <label className="flex min-h-[58px] items-center justify-between gap-[12px] rounded-[12px] border border-white bg-white/80 px-[13px] py-[10px]"><span><span className="block text-[12px] font-medium text-[#464c5e]">{label}</span><span className="mt-[2px] block text-[10px] leading-[15px] text-[#858b9c]">{hint}</span></span><Switch checked={checked} onCheckedChange={onChange} /></label>;
}

/** 在未保存前探测工具连接；请求结果是原始技术输出，提示与状态使用语义消息。 */
function ToolProbeCard({ values }: { values: ToolFormValues }) {
  const { t } = useAppIntl();
  const toast = createToastNotifier({ t });
  const tenantContext = useTenantSession();
  const tenantClient = useMemo(() => createTenantClient(tenantContext), [tenantContext]);
  const tenantId = tenantContext?.tenantId || '';
  const [sampleJson, setSampleJson] = useState('{}');
  const [result, setResult] = useState('');
  const [loading, setLoading] = useState(false);
  const probeControllerRef = useRef<AbortController | null>(null);
  const method = values.method || 'POST';
  const isGetMethod = method === 'GET';

  useEffect(() => () => probeControllerRef.current?.abort(), [tenantContext?.tenantId, tenantContext?.generation]);

  async function probe() {
    if (!tenantContext) return;
    const context = tenantContext;
    const generation = context.generation;
    if (!String(values.name || '').trim()) {
      toast.error(createMessageDescriptor(TOOLS_MESSAGE_IDS.toastToolNameRequired));
      return;
    }
    if (!String(values.url || '').trim()) {
      toast.error(createMessageDescriptor(TOOLS_MESSAGE_IDS.toastUrlRequired));
      return;
    }
    const payload = buildToolPayload(values);
    if (!payload) {
      toast.error(createMessageDescriptor(TOOLS_MESSAGE_IDS.toastJsonConfigInvalid));
      return;
    }
    let sampleArguments: Record<string, unknown>;
    try {
      sampleArguments = parseJson(sampleJson, {});
    } catch {
      toast.error(createMessageDescriptor(TOOLS_MESSAGE_IDS.toastInvalidProbeArguments));
      return;
    }
    if (
      payload.tool_type === 'http'
      && payload.method !== 'GET'
      && payload.url.includes('?')
      && Object.keys(sampleArguments).length === 0
    ) {
      toast.error(createMessageDescriptor(TOOLS_MESSAGE_IDS.toastQueryArgumentRule));
      return;
    }
    probeControllerRef.current?.abort();
    const controller = new AbortController();
    probeControllerRef.current = controller;
    setLoading(true);
    try {
      const response = await tenantClient.post('/api/enterprise/tools/probe', {
        tenant_id: tenantId,
        name: payload.name,
        display_name: payload.display_name,
        description: payload.description,
        bucket: payload.bucket,
        tool_type: payload.tool_type,
        method: payload.method,
        url: payload.url,
        headers: payload.headers,
        auth: payload.auth,
        mcp_config: payload.mcp_config,
        input_schema: payload.input_schema,
        output_schema: payload.output_schema,
        sample_arguments: sampleArguments,
      }, { signal: controller.signal });
      if (isCurrentTenantRequest(context, generation, controller)) {
        setResult(JSON.stringify(response, null, 2));
      }
    } catch (error) {
      if (!isCurrentTenantRequest(context, generation, controller)) return;
      console.error('[tools-page] probe tool failed', error);
      toast.error(toolErrorDescriptor(error, TOOLS_MESSAGE_IDS.toastProbeFailed));
    } finally {
      if (probeControllerRef.current === controller) probeControllerRef.current = null;
      if (isCurrentTenantRequest(context, generation, controller)) setLoading(false);
    }
  }

  return (
    <SectionCard
      title={t(TOOLS_MESSAGE_IDS.sectionProbe)}
      bodyClassName="flex flex-col gap-[14px]"
      extra={(
        <UIButton variant="outline" disabled={loading} onClick={() => void probe()} className={RETURN_BUTTON_CLASS}>
          <ExperimentOutlined />
          {t(TOOLS_MESSAGE_IDS.actionProbe)}
        </UIButton>
      )}
    >
      <p className={HINT_CLASS}>{t(TOOLS_MESSAGE_IDS.probeDescription)}</p>
      <div className="flex flex-col gap-[8px]">
        <span className={SUBSECTION_TITLE_CLASS}>
          {t(isGetMethod ? TOOLS_MESSAGE_IDS.probeArgumentsGet : TOOLS_MESSAGE_IDS.probeArgumentsBody)}
        </span>
        <p className={HINT_CLASS}>
          {t(isGetMethod ? TOOLS_MESSAGE_IDS.probeGetHint : TOOLS_MESSAGE_IDS.probeBodyHint)}
        </p>
        <Textarea
          rows={5}
          className={MONO_INPUT_CLASS}
          value={sampleJson}
          onChange={(event) => setSampleJson(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-[8px]">
        <span className={SUBSECTION_TITLE_CLASS}>{t(TOOLS_MESSAGE_IDS.probeResult)}</span>
        <Textarea rows={8} readOnly className={MONO_INPUT_CLASS} value={result} />
      </div>
    </SectionCard>
  );
}

/** 调用已保存工具并展示原始返回；操作文案本地化，工具名称与结果不翻译。 */
function SavedToolTestCard({ tool, standalone = false }: { tool: ToolRead; standalone?: boolean }) {
  const { t } = useAppIntl();
  const toast = createToastNotifier({ t });
  const tenantContext = useTenantSession();
  const tenantClient = useMemo(() => createTenantClient(tenantContext), [tenantContext]);
  const tenantId = tenantContext?.tenantId || '';
  const userId = tenantContext?.userId || '';
  const [testJson, setTestJson] = useState(() => JSON.stringify(exampleFromSchema(tool.input_schema), null, 2));
  const [testResult, setTestResult] = useState('');
  const [loading, setLoading] = useState(false);
  const testControllerRef = useRef<AbortController | null>(null);

  useEffect(() => () => testControllerRef.current?.abort(), [tenantContext?.tenantId, tenantContext?.generation]);

  useEffect(() => {
    setTestJson(JSON.stringify(exampleFromSchema(tool.input_schema), null, 2));
    setTestResult('');
  }, [tool.id, tool.input_schema]);

  async function test() {
    if (!tenantContext) return;
    let argumentsJson: Record<string, unknown>;
    try {
      argumentsJson = parseJson(testJson, {});
    } catch {
      toast.error(createMessageDescriptor(TOOLS_MESSAGE_IDS.toastInvalidProbeArguments));
      return;
    }
    const context = tenantContext;
    const generation = context.generation;
    testControllerRef.current?.abort();
    const controller = new AbortController();
    testControllerRef.current = controller;
    setLoading(true);
    try {
      const agentQuery = currentAgentQuery(tenantId, userId);
      const response = await tenantClient.post(`/api/enterprise/tools/${tool.id}/test${agentQuery ? `?${agentQuery.slice(1)}` : ''}`, {
        tenant_id: tenantId,
        arguments: argumentsJson,
      }, { signal: controller.signal });
      if (isCurrentTenantRequest(context, generation, controller)) {
        setTestResult(JSON.stringify(response, null, 2));
      }
    } catch (error) {
      if (!isCurrentTenantRequest(context, generation, controller)) return;
      console.error('[tools-page] call saved tool failed', error);
      toast.error(toolErrorDescriptor(error, TOOLS_MESSAGE_IDS.toastCallFailed));
    } finally {
      if (testControllerRef.current === controller) testControllerRef.current = null;
      if (isCurrentTenantRequest(context, generation, controller)) setLoading(false);
    }
  }

  return (
    <SectionCard
      className={standalone ? undefined : 'xl:sticky xl:top-[18px]'}
      bodyClassName="flex flex-col gap-[16px]"
      title={(
        <span className="inline-flex items-center gap-[8px]">
          <ExperimentOutlined />
          {t(standalone ? TOOLS_MESSAGE_IDS.sectionCallTest : TOOLS_MESSAGE_IDS.savedTestTitle)}
        </span>
      )}
      extra={(
        <UIButton disabled={loading} onClick={() => void test()} className={PRIMARY_BUTTON_CLASS}>
          <ExperimentOutlined />
          {t(TOOLS_MESSAGE_IDS.savedTestInvoke)}
        </UIButton>
      )}
    >
      <div className="flex items-start justify-between gap-[12px] rounded-[12px] border border-[#eceef1] bg-[#fafbfc] px-[14px] py-[12px]">
        <span className="min-w-0 flex-1 wrap-break-word text-[13px] leading-[1.65] text-[#858b9c]">
          {t(TOOLS_MESSAGE_IDS.savedTestDescription, { name: tool.display_name || tool.name })}
        </span>
        <span className="shrink-0">
          <StatusBadge tone="gray">{toolTypeLabel(tool, t)}</StatusBadge>
        </span>
      </div>
      <div className="flex flex-col gap-[10px]">
        <span className={SUBSECTION_TITLE_CLASS}>{t(TOOLS_MESSAGE_IDS.savedTestArguments)}</span>
        <Textarea
          rows={8}
          className={MONO_INPUT_CLASS}
          value={testJson}
          onChange={(event) => setTestJson(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-[10px]">
        <div className="flex items-center justify-between gap-[10px]">
          <span className={SUBSECTION_TITLE_CLASS}>{t(TOOLS_MESSAGE_IDS.savedTestResult)}</span>
          <StatusBadge tone={testResult ? 'green' : 'gray'}>
            {t(testResult ? TOOLS_MESSAGE_IDS.savedTestReturned : TOOLS_MESSAGE_IDS.savedTestWaiting)}
          </StatusBadge>
        </div>
        {testResult ? (
          <CodeBlock className="max-h-[340px] whitespace-pre-wrap wrap-break-word" code={testResult} language="json" />
        ) : (
          <div className="grid min-h-[180px] place-items-center rounded-[12px] border border-dashed border-[#eceef1] p-[20px] text-center text-[13px] text-[#858b9c]">
            {t(TOOLS_MESSAGE_IDS.savedTestEmpty)}
          </div>
        )}
      </div>
    </SectionCard>
  );
}

/** 加载工具分桶原始值；空分桶的显示标签由当前 locale 生成，业务值保持空字符串。 */
async function loadBucketValues(
  client: TenantClient,
  tenantId: string,
  userId: string,
  options?: RequestInit,
) {
  const rows = await client.get<ToolRead[]>(
    `/api/enterprise/tools?tenant_id=${tenantId}${currentAgentQuery(tenantId, userId)}`,
    options,
  );
  return Array.from(new Set(rows.map((row) => {
    const value = row.bucket || '';
    return value === LEGACY_UNBUCKETED_BUCKET_MARKER ? '' : value;
  })));
}

function currentAgentQuery(tenantId: string, userId: string): string {
  const agentId = tenantId && userId ? readEmployeeScope(tenantId, userId) : '';
  return agentId ? `&agent_id=${encodeURIComponent(agentId)}` : '';
}

/** 将后端工具记录转换为编辑表单；缺省分桶保持业务空值，不写入界面语言文案。 */
function toolToFormValues(row: ToolRead): ToolFormValues {
  return {
    ...TOOL_FORM_INITIAL_VALUES,
    ...row,
    bucket: row.bucket || '',
    tool_type: row.tool_type === 'mcp' || row.tool_type === 'a2a' ? row.tool_type : 'http',
    headers: JSON.stringify(row.headers || {}, null, 2),
    auth: JSON.stringify(row.auth || {}, null, 2),
    mcp_config: JSON.stringify(row.mcp_config || {}, null, 2),
    input_schema: JSON.stringify(row.input_schema || {}, null, 2),
    output_schema: JSON.stringify(row.output_schema || {}, null, 2),
    allowed_skills: (row.allowed_skills || []).join(','),
    timeout_seconds: row.execution_policy?.timeout_seconds ?? 8,
    capability_scope: normalizeCapabilityScope(row.capability_scope),
  };
}

/** 构造工具 API payload；JSON 解析失败返回 null，由调用组件通过语义 toast 提示。 */
function buildToolPayload(values: ToolFormValues) {
  try {
    return {
      name: String(values.name || '').trim(),
      display_name: values.display_name,
      description: values.description,
      bucket: values.bucket || '',
      tool_type: values.tool_type || 'http',
      method: values.method,
      url: String(values.url || '').trim(),
      headers: parseJson(values.headers, {}),
      auth: parseJson(values.auth, {}),
      mcp_config: values.tool_type === 'mcp' || values.tool_type === 'a2a' ? parseJson(values.mcp_config, {}) : {},
      execution_policy: {
        timeout_seconds: Math.max(1, Math.min(3600, Number(values.timeout_seconds) || 8)),
      },
      input_schema: parseJson(values.input_schema, {}),
      output_schema: parseJson(values.output_schema, {}),
      allowed_skills: String(values.allowed_skills || '').split(',').map((item) => item.trim()).filter(Boolean),
      capability_scope: normalizeCapabilityScope(values.capability_scope),
      enabled: values.enabled,
    };
  } catch {
    return null;
  }
}

/** 汇总工具原始分桶，产品显示层通过 bucketLabel 翻译空值。 */
function buildBucketStats(rows: ToolRead[]) {
  const map = new Map<string, { bucket: string; total: number; enabled: number; disabled: number }>();
  rows.forEach((row) => {
    const bucket = row.bucket || '';
    const item = map.get(bucket) || { bucket, total: 0, enabled: 0, disabled: 0 };
    item.total += 1;
    if (row.enabled) item.enabled += 1;
    else item.disabled += 1;
    map.set(bucket, item);
  });
  return Array.from(map.values()).sort((a, b) => b.total - a.total || a.bucket.localeCompare(b.bucket));
}

function parseJson<T>(value: string, fallback: T): T {
  if (!value) return fallback;
  return JSON.parse(value) as T;
}

function safeJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function formatJson(value: unknown): string {
  return JSON.stringify(value || {}, null, 2);
}

/** 返回 schema properties 数量；数字格式化由调用方按当前 locale 完成。 */
function schemaPropertyCount(schema: Record<string, unknown>): number {
  const properties = schema.properties && typeof schema.properties === 'object'
    ? schema.properties as Record<string, unknown>
    : {};
  return Object.keys(properties).length;
}

/** 将已知工具协议映射为产品标签，未知协议保持技术标识并标记为 raw。 */
function toolProtocolLabel(toolType: ToolRead['tool_type'], translate: ToolsTranslate): ReactNode {
  if (toolType === 'mcp') return translate(TOOLS_MESSAGE_IDS.protocolMcp);
  if (toolType === 'a2a') return translate(TOOLS_MESSAGE_IDS.protocolA2A);
  if (toolType === 'http') return translate(TOOLS_MESSAGE_IDS.protocolHttp);
  return <RawIdentifier value={String(toolType)} />;
}

/** 将工具记录的协议字段委托给受控产品标签映射。 */
function toolTypeLabel(tool: ToolRead, translate: ToolsTranslate): ReactNode {
  return toolProtocolLabel(tool.tool_type, translate);
}

/** 将空分桶转换为本地化状态，其余分桶名称作为原始业务标识显示。 */
function bucketLabel(bucket: string | undefined, translate: ToolsTranslate): ReactNode {
  return bucket ? <RawIdentifier value={bucket} /> : translate(TOOLS_MESSAGE_IDS.statusUnbucketed);
}

/** 将 MCP 服务器记录转换为编辑表单；远端业务名称与连接值保持原样。 */
function serverToFormValues(row: MCPServerRead): McpFormValues {
  const connection = row.connection;
  return {
    name: row.name,
    display_name: row.display_name || '',
    description: row.description || '',
    bucket: row.bucket || '',
    transport: connection.transport,
    url: connection.url || '',
    headers: JSON.stringify(connection.headers || {}, null, 2),
    command: connection.command || '',
    args: (connection.args || []).join('\n'),
    env: JSON.stringify(connection.env || {}, null, 2),
    cwd: connection.cwd || '',
    apps_mode: row.apps_mode || 'disabled',
    auth_mode: row.auth_mode || 'none',
    oauth_client_id: row.oauth_client_id || '',
    oauth_client_metadata_url: row.oauth_client_metadata_url || '',
    oauth_redirect_uri: row.oauth_redirect_uri || '',
    capability_scope: normalizeCapabilityScope(row.capability_scope),
    enabled: row.enabled,
  };
}

export function parseMcpArgs(value: string): string[] {
  return String(value || '')
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** 将已知 MCP 传输协议本地化，未知协议以 raw 标识展示而不伪造文案。 */
function transportLabel(transport: MCPTransport | string, translate: ToolsTranslate): ReactNode {
  const option = TRANSPORT_OPTIONS.find((item) => item.value === transport);
  return option ? translate(option.labelId) : <RawIdentifier value={String(transport)} />;
}

/**
 * 规范化 MCP 服务器名称（唯一标识）：
 * 中文自动转拼音（无声调），只保留字母/数字/下划线，其余转下划线，最长 15 字符。
 */
function sanitizeMcpName(raw: string): string {
  const input = String(raw || '');
  // 含中文时先整体转拼音（不带声调），拼音之间用下划线连接。
  const converted = /[\u4e00-\u9fa5]/.test(input)
    ? pinyin(input, { toneType: 'none', type: 'array', nonZh: 'consecutive' }).join('_')
    : input;
  const normalized = converted
    .replace(/[^a-zA-Z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+/, '');
  return normalized.slice(0, 15);
}

function serverEndpoint(connection: MCPServerConnection): string {
  if (connection.transport === 'stdio') return connection.command || '—';
  if (connection.transport === 'builtin') return 'builtin.demo';
  return connection.url || '—';
}

function exampleFromSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = schema.properties && typeof schema.properties === 'object'
    ? schema.properties as Record<string, Record<string, unknown>>
    : {};
  return Object.fromEntries(
    Object.entries(properties).map(([key, value]) => [key, exampleValue(key, value)]),
  );
}

function exampleValue(key: string, schema: Record<string, unknown>): unknown {
  if (schema.default !== undefined) return schema.default;
  if (schema.example !== undefined) return schema.example;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (schema.type === 'integer') return 1;
  if (schema.type === 'number') return 1;
  if (schema.type === 'boolean') return true;
  if (schema.type === 'array') return [];
  if (schema.type === 'object') return {};
  return `sample_${key}`;
}
