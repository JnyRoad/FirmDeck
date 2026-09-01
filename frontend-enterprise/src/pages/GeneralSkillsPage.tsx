import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  DeleteOutlined,
  EditOutlined,
  ExperimentOutlined,
  GithubOutlined,
  PlusOutlined,
  TeamOutlined,
  UploadOutlined,
} from '../icons';
import type { ChangeEvent, DragEvent, HTMLAttributes, ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Ban, ChevronRight, CircleCheck, Copy, Eye, EyeOff, FilePlus2, FolderPlus, Users } from 'lucide-react';
import { ContextMenu } from 'radix-ui';

import { API_BASE, ApiError } from '../api/client';
import { createTenantClient } from '../api/tenant-client';
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
import { ModelConfigDropdown } from '@/components/ModelConfigDropdown';
import { Paginator } from '@/components/Paginator';
import { RawContent } from '@/i18n/RawContent';
import chineseMessages from '@/i18n/messages/zh-CN.json';
import englishMessages from '@/i18n/messages/en-US.json';
import type { MessageId } from '@/i18n/types';
import { useAppIntl } from '@/i18n/useAppIntl';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Select as UISelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui';
import { Button as UIButton } from '@/components/ui/button';
import { notify } from '@/components/ui/app-toast';
import { apiErrorMessage } from '@/lib/apiErrorMessages';
import { cn } from '@/lib/utils';
import {
  isTeamScope,
  persistSharedAgentScope,
  readEmployeeScope,
} from '@/lib/agent-scope-storage';
import { tenantUserStorageKey } from '@/lib/tenant-storage';
import {
  MENU_CONTENT_CLASS,
  MENU_ITEM_CLASS,
  MENU_ITEM_DANGER_CLASS,
  MOBILE_CARD_CLASS,
  SELECT_TRIGGER_CLASS,
  formatDateTime,
} from '@/lib/enterprise-ui';
import { StatCard } from '@/components/StatCard';
import { ResourceImportDialog } from '@/components/ResourceImportDialog';
import CodeBlock, { renderCodeTokens } from '../components/CodeBlock';
import { renderMarkdownBlocks } from './chat/chatHelpers';

type TenantStreamEvent = {
  event: string;
  data: Record<string, unknown>;
};

/** 只有请求所属租户代次仍然有效时，异步回调才允许触碰页面状态或提示。 */
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

/** Build a stream URL from the verified tenant and reject caller-supplied mismatches. */
function tenantStreamUrl(path: string, tenantId: string): string {
  const hasAbsoluteBase = /^(?:https?:|blob:)/i.test(path);
  const url = new URL(hasAbsoluteBase ? path : `${API_BASE}${path}`, window.location.origin);
  const requestedTenantIds = url.searchParams.getAll('tenant_id');
  if (requestedTenantIds.some((value) => value !== tenantId)) {
    throw new Error('租户请求上下文不匹配');
  }
  url.searchParams.set('tenant_id', tenantId);
  return !API_BASE && !hasAbsoluteBase
    ? `${url.pathname}${url.search}${url.hash}`
    : url.toString();
}

/** Link a request abort signal to the verified tenant generation signal. */
function combineTenantStreamSignals(
  tenantSignal: AbortSignal,
  requestSignal?: AbortSignal,
): { signal: AbortSignal; cleanup: () => void } {
  if (!requestSignal || requestSignal === tenantSignal) {
    return { signal: tenantSignal, cleanup: () => undefined };
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (tenantSignal.aborted || requestSignal.aborted) controller.abort();
  else {
    tenantSignal.addEventListener('abort', abort, { once: true });
    requestSignal.addEventListener('abort', abort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      tenantSignal.removeEventListener('abort', abort);
      requestSignal.removeEventListener('abort', abort);
    },
  };
}

/** Parse one SSE block while keeping malformed payloads diagnosable to callers. */
function parseTenantSseBlock(block: string): TenantStreamEvent | null {
  const lines = block.split('\n').map((line) => line.trimEnd());
  const eventLine = lines.find((line) => line.startsWith('event:'));
  const dataLines = lines.filter((line) => line.startsWith('data:'));
  if (!eventLine || dataLines.length === 0) return null;
  const event = eventLine.replace(/^event:\s*/, '');
  const rawData = dataLines.map((line) => line.replace(/^data:\s*/, '')).join('\n');
  try {
    return { event, data: JSON.parse(rawData) as Record<string, unknown> };
  } catch {
    return { event, data: { raw: rawData } };
  }
}

/** Stream an enterprise endpoint with the verified bearer, tenant query and generation fence. */
async function streamTenantPost(
  context: TenantSessionContextValue | null,
  path: string,
  body: Record<string, unknown>,
  onEvent: (item: TenantStreamEvent) => void,
  requestSignal?: AbortSignal,
): Promise<void> {
  if (!context) throw new Error('租户请求上下文不可用');
  const generation = context.generation;
  const combined = combineTenantStreamSignals(context.signal, requestSignal);
  const isCurrent = () => (
    !combined.signal.aborted
    && !context.signal.aborted
    && context.isCurrentGeneration(generation)
  );
  try {
    if (!isCurrent()) return;
    if (body.tenant_id !== undefined && body.tenant_id !== context.tenantId) {
      throw new Error('租户请求上下文不匹配');
    }
    const response = await fetch(tenantStreamUrl(path, context.tenantId), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${context.session.token}`,
      },
      body: JSON.stringify({ ...body, tenant_id: context.tenantId }),
      signal: combined.signal,
    });
    if (!isCurrent()) return;
    if (!response.ok) {
      const text = await response.text();
      if (!isCurrent()) return;
      throw new ApiError(response.status, text, response.statusText);
    }
    if (!response.body) throw new Error('当前浏览器不支持流式响应');
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!isCurrent()) {
        await reader.cancel().catch(() => undefined);
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() || '';
      blocks.forEach((block) => {
        if (!isCurrent()) return;
        const parsed = parseTenantSseBlock(block);
        if (parsed) onEvent(parsed);
      });
    }
    if (!isCurrent()) return;
    buffer += decoder.decode();
    const parsed = parseTenantSseBlock(buffer);
    if (parsed && isCurrent()) onEvent(parsed);
  } finally {
    combined.cleanup();
  }
}
import IconAdd from '../assets/icons/add.svg?react';
import IconArrowRight from '../assets/icons/arrow-right.svg?react';
import IconFolder from '../assets/icons/cap-folder.svg?react';
import IconMagicWand from '../assets/icons/cap-magicwand.svg?react';
import IconChevronDown from '../assets/icons/chevron-down.svg?react';
import IconPlay from '../assets/icons/play.svg?react';
import IconClear from '../assets/icons/field-clear.svg?react';
import IconEdit from '../assets/icons/edit.svg?react';
import IconMore from '../assets/icons/more.svg?react';
import IconRefresh from '../assets/icons/refresh.svg?react';
import IconProfileFile from '../assets/icons/profile-file.svg?react';
import IconSearch from '../assets/icons/search.svg?react';
import IconSkill from '../assets/icons/plaza-skill.svg?react';
import IconTrash from '../assets/icons/trash.svg?react';
import {
  canManageEmployeeAgent,
  openGalleryAgentId,
  openGalleryImportSourceOptions,
  resourceCreatorName,
  visibleEmployeeAgents,
} from '../employee';
import { useClientPagination } from '../hooks/useClientPagination';
import { StatusBadge } from './scheduled-tasks/StatusBadge';
import type { BadgeTone } from './scheduled-tasks/shared';
import type {
  AgentProfileRead,
  CapabilityScope,
  GeneralSkillRead,
  GeneralSkillRunResponse,
  ModelConfigRead,
} from '../types';

const GENERAL_SKILL_PAGE_SIZE = 10;
const GENERAL_SKILL_RUN_MODEL_STORAGE_KEY = 'general-skill-run-model';

const GENERAL_SKILLS_MESSAGE_IDS = {
  pageTitle: 'generalSkillsPage.pageTitle',
  scopedPageTitle: 'generalSkillsPage.scopedPageTitle',
  listOverall: 'generalSkillsPage.listOverall',
  listScoped: 'generalSkillsPage.listScoped',
  total: 'generalSkillsPage.total',
  enabled: 'generalSkillsPage.enabled',
  draft: 'generalSkillsPage.draft',
  archived: 'generalSkillsPage.archived',
  refresh: 'generalSkillsPage.refresh',
  add: 'generalSkillsPage.add',
  create: 'generalSkillsPage.create',
  searchLabel: 'generalSkillsPage.searchLabel',
  searchPlaceholder: 'generalSkillsPage.searchPlaceholder',
  clearSearch: 'generalSkillsPage.clearSearch',
  statusFilter: 'generalSkillsPage.statusFilter',
  statusAll: 'generalSkillsPage.statusAll',
  listAria: 'generalSkillsPage.listAria',
  paginationAria: 'generalSkillsPage.paginationAria',
  actionAria: 'generalSkillsPage.actionAria',
  actionEdit: 'generalSkillsPage.actionEdit',
  actionEditLocal: 'generalSkillsPage.actionEditLocal',
  actionArchive: 'generalSkillsPage.actionArchive',
  actionPublish: 'generalSkillsPage.actionPublish',
  actionDelete: 'generalSkillsPage.actionDelete',
  actionRemove: 'generalSkillsPage.actionRemove',
  copyFromMarketplace: 'generalSkillsPage.copyFromMarketplace',
  importFromOpenSource: 'generalSkillsPage.importFromOpenSource',
  copyFromEmployee: 'generalSkillsPage.copyFromEmployee',
  importMarketplaceTitle: 'generalSkillsPage.importMarketplaceTitle',
  importEmployeeTitle: 'generalSkillsPage.importEmployeeTitle',
  importMarketplacePlaceholder: 'generalSkillsPage.importMarketplacePlaceholder',
  importEmployeePlaceholder: 'generalSkillsPage.importEmployeePlaceholder',
  importItemsLabel: 'generalSkillsPage.importItemsLabel',
  importEmpty: 'generalSkillsPage.importEmpty',
  importMarketplaceNote: 'generalSkillsPage.importMarketplaceNote',
  importEmployeeNote: 'generalSkillsPage.importEmployeeNote',
  emptyManage: 'generalSkillsPage.emptyManage',
  emptyReadonly: 'generalSkillsPage.emptyReadonly',
  emptyScoped: 'generalSkillsPage.emptyScoped',
  deleteTitle: 'generalSkillsPage.deleteTitle',
  deleteDescriptionOverall: 'generalSkillsPage.deleteDescriptionOverall',
  deleteDescriptionScoped: 'generalSkillsPage.deleteDescriptionScoped',
  invalidFileName: 'generalSkillsPage.invalidFileName',
  duplicateFileOrFolder: 'generalSkillsPage.duplicateFileOrFolder',
  duplicateAncestorFile: 'generalSkillsPage.duplicateAncestorFile',
  invalidFolderName: 'generalSkillsPage.invalidFolderName',
  folderInsideSelf: 'generalSkillsPage.folderInsideSelf',
  duplicateRenameTarget: 'generalSkillsPage.duplicateRenameTarget',
  importFirst: 'generalSkillsPage.importFirst',
  enterTestQuery: 'generalSkillsPage.enterTestQuery',
  runComplete: 'generalSkillsPage.runComplete',
  runFailed: 'generalSkillsPage.runFailed',
  runStreamEnded: 'generalSkillsPage.runStreamEnded',
  runTimedOut: 'generalSkillsPage.runTimedOut',
  importedSingleFile: 'generalSkillsPage.importedSingleFile',
  importedNoFiles: 'generalSkillsPage.importedNoFiles',
  importedFiles: 'generalSkillsPage.importedFiles',
  importedFilesSkipped: 'generalSkillsPage.importedFilesSkipped',
  missingSkillFile: 'generalSkillsPage.missingSkillFile',
  importAction: 'generalSkillsPage.importAction',
  chooseFile: 'generalSkillsPage.chooseFile',
  chooseFolder: 'generalSkillsPage.chooseFolder',
  backToSkills: 'generalSkillsPage.backToSkills',
  saveAction: 'generalSkillsPage.saveAction',
  basicInfo: 'generalSkillsPage.basicInfo',
  skillNameLabel: 'generalSkillsPage.skillNameLabel',
  skillNamePlaceholder: 'generalSkillsPage.skillNamePlaceholder',
  descriptionLabel: 'generalSkillsPage.descriptionLabel',
  descriptionPlaceholder: 'generalSkillsPage.descriptionPlaceholder',
  homepageLabel: 'generalSkillsPage.homepageLabel',
  homepagePlaceholder: 'generalSkillsPage.homepagePlaceholder',
  slugLabel: 'generalSkillsPage.slugLabel',
  slugPlaceholderLocked: 'generalSkillsPage.slugPlaceholderLocked',
  slugPlaceholderEditable: 'generalSkillsPage.slugPlaceholderEditable',
  runTestTitle: 'generalSkillsPage.runTestTitle',
  runAction: 'generalSkillsPage.runAction',
  selectSkillLabel: 'generalSkillsPage.selectSkillLabel',
  selectSkillPlaceholderSaved: 'generalSkillsPage.selectSkillPlaceholderSaved',
  selectSkillPlaceholder: 'generalSkillsPage.selectSkillPlaceholder',
  testQuestionLabel: 'generalSkillsPage.testQuestionLabel',
  testQuestionPlaceholder: 'generalSkillsPage.testQuestionPlaceholder',
  filesTitle: 'generalSkillsPage.filesTitle',
  dropHint: 'generalSkillsPage.dropHint',
  fileSystemTitle: 'generalSkillsPage.fileSystemTitle',
  fileSystemAria: 'generalSkillsPage.fileSystemAria',
  createEntry: 'generalSkillsPage.createEntry',
  createFile: 'generalSkillsPage.createFile',
  createFolder: 'generalSkillsPage.createFolder',
  deleteFileAction: 'generalSkillsPage.deleteFileAction',
  noSelectedFile: 'generalSkillsPage.noSelectedFile',
  switchToEdit: 'generalSkillsPage.switchToEdit',
  switchToPreview: 'generalSkillsPage.switchToPreview',
  editMode: 'generalSkillsPage.editMode',
  previewMode: 'generalSkillsPage.previewMode',
  noContent: 'generalSkillsPage.noContent',
  resultTitle: 'generalSkillsPage.resultTitle',
  resultRunning: 'generalSkillsPage.resultRunning',
  resultSuccess: 'generalSkillsPage.resultSuccess',
  resultFailed: 'generalSkillsPage.resultFailed',
  collapseResults: 'generalSkillsPage.collapseResults',
  expandResults: 'generalSkillsPage.expandResults',
  finalReply: 'generalSkillsPage.finalReply',
  replyRunning: 'generalSkillsPage.replyRunning',
  replyEmpty: 'generalSkillsPage.replyEmpty',
  executionTrace: 'generalSkillsPage.executionTrace',
  runnerAttempt: 'generalSkillsPage.runnerAttempt',
  runnerTitle: 'generalSkillsPage.runnerTitle',
  phaseFallback: 'generalSkillsPage.phaseFallback',
  traceViewResult: 'generalSkillsPage.traceViewResult',
  traceViewOutput: 'generalSkillsPage.traceViewOutput',
  traceViewDetail: 'generalSkillsPage.traceViewDetail',
  outputTitle: 'generalSkillsPage.outputTitle',
  stdoutTitle: 'generalSkillsPage.stdoutTitle',
  stderrTitle: 'generalSkillsPage.stderrTitle',
  structuredResult: 'generalSkillsPage.structuredResult',
  noStructuredResult: 'generalSkillsPage.noStructuredResult',
  noStdout: 'generalSkillsPage.noStdout',
  noStderr: 'generalSkillsPage.noStderr',
  resultEmptyHint: 'generalSkillsPage.resultEmptyHint',
  fileDeleteTitle: 'generalSkillsPage.fileDeleteTitle',
  fileDeleteDescription: 'generalSkillsPage.fileDeleteDescription',
  folderDeleteTitle: 'generalSkillsPage.folderDeleteTitle',
  folderDeleteDescription: 'generalSkillsPage.folderDeleteDescription',
  createFolderTitle: 'generalSkillsPage.createFolderTitle',
  createFileTitle: 'generalSkillsPage.createFileTitle',
  createFolderPlaceholder: 'generalSkillsPage.createFolderPlaceholder',
  createFilePlaceholder: 'generalSkillsPage.createFilePlaceholder',
  cancelAction: 'generalSkillsPage.cancelAction',
  importPrepareTitle: 'generalSkillsPage.importPrepareTitle',
  importPrepareDescription: 'generalSkillsPage.importPrepareDescription',
  importPrepareSkip: 'generalSkillsPage.importPrepareSkip',
  importPrepareSave: 'generalSkillsPage.importPrepareSave',
  renameFolderTitle: 'generalSkillsPage.renameFolderTitle',
  renameFileTitle: 'generalSkillsPage.renameFileTitle',
  renameAction: 'generalSkillsPage.renameAction',
  enabledSuccess: 'generalSkillsPage.enabledSuccess',
  archivedSuccess: 'generalSkillsPage.archivedSuccess',
  publishToMarketplaceSuccess: 'generalSkillsPage.publishToMarketplaceSuccess',
  removedSuccess: 'generalSkillsPage.removedSuccess',
  deletedSuccess: 'generalSkillsPage.deletedSuccess',
  loadFailed: 'generalSkillsPage.loadFailed',
  loadAgentsFailed: 'generalSkillsPage.loadAgentsFailed',
  loadSourceSkillsFailed: 'generalSkillsPage.loadSourceSkillsFailed',
  copySkillsFailed: 'generalSkillsPage.copySkillsFailed',
  selectEmployeeFirst: 'generalSkillsPage.selectEmployeeFirst',
  selectMarketplaceFirst: 'generalSkillsPage.selectMarketplaceFirst',
  selectSourceFirst: 'generalSkillsPage.selectSourceFirst',
  selectSkillsFirst: 'generalSkillsPage.selectSkillsFirst',
  copiedSkillsSuccess: 'generalSkillsPage.copiedSkillsSuccess',
  enterOpenSourceUrl: 'generalSkillsPage.enterOpenSourceUrl',
  importedOpenSourceSuccess: 'generalSkillsPage.importedOpenSourceSuccess',
  importCanceled: 'generalSkillsPage.importCanceled',
  importOpenSourceFailed: 'generalSkillsPage.importOpenSourceFailed',
  uploadPackageSuccess: 'generalSkillsPage.uploadPackageSuccess',
  uploadPackageFailed: 'generalSkillsPage.uploadPackageFailed',
  createFolderBaseName: 'generalSkillsPage.createFolderBaseName',
  createFolderIndexedName: 'generalSkillsPage.createFolderIndexedName',
  skillEntryProtectedRename: 'generalSkillsPage.skillEntryProtectedRename',
  skillEntryProtectedDelete: 'generalSkillsPage.skillEntryProtectedDelete',
  protectedFolderDelete: 'generalSkillsPage.protectedFolderDelete',
  newBlankTitle: 'generalSkillsPage.newBlankTitle',
  editTitle: 'generalSkillsPage.editTitle',
  pageDescriptionOverallNew: 'generalSkillsPage.pageDescriptionOverallNew',
  pageDescriptionOverallEdit: 'generalSkillsPage.pageDescriptionOverallEdit',
  pageDescriptionScopedNew: 'generalSkillsPage.pageDescriptionScopedNew',
  pageDescriptionScopedEdit: 'generalSkillsPage.pageDescriptionScopedEdit',
  editTargetMissing: 'generalSkillsPage.editTargetMissing',
  adminOnlyEdit: 'generalSkillsPage.adminOnlyEdit',
  missingSkillMarkdown: 'generalSkillsPage.missingSkillMarkdown',
  saveFailed: 'generalSkillsPage.saveFailed',
  saveCreated: 'generalSkillsPage.saveCreated',
  saveUpdated: 'generalSkillsPage.saveUpdated',
  enableFailed: 'generalSkillsPage.enableFailed',
  archiveFailed: 'generalSkillsPage.archiveFailed',
  publishToMarketplaceFailed: 'generalSkillsPage.publishToMarketplaceFailed',
  removeFailed: 'generalSkillsPage.removeFailed',
  deleteSkillFailed: 'generalSkillsPage.deleteSkillFailed',
  plazaCopyRequiresEmployee: 'generalSkillsPage.plazaCopyRequiresEmployee',
  publishToMarketplaceAction: 'generalSkillsPage.publishToMarketplaceAction',
  columnName: 'generalSkillsPage.columnName',
  columnDescription: 'generalSkillsPage.columnDescription',
  noDescription: 'generalSkillsPage.noDescription',
  columnFiles: 'generalSkillsPage.columnFiles',
  filesCount: 'generalSkillsPage.filesCount',
  columnCapabilityScope: 'generalSkillsPage.columnCapabilityScope',
  columnCreator: 'generalSkillsPage.columnCreator',
  creatorPrefix: 'generalSkillsPage.creatorPrefix',
  columnStatus: 'generalSkillsPage.columnStatus',
  columnUpdatedAt: 'generalSkillsPage.columnUpdatedAt',
  columnActions: 'generalSkillsPage.columnActions',
  fileCountAndUpdatedAt: 'generalSkillsPage.fileCountAndUpdatedAt',
  importOpenSourceTitle: 'generalSkillsPage.importOpenSourceTitle',
  importOpenSourceHelp: 'generalSkillsPage.importOpenSourceHelp',
  importOpenSourcePlaceholder: 'generalSkillsPage.importOpenSourcePlaceholder',
  expandLabel: 'generalSkillsPage.expandLabel',
  collapseLabel: 'generalSkillsPage.collapseLabel',
  loading: 'generalSkillsPage.loading',
} as const satisfies Record<string, MessageId>;

type GeneralSkillsCopy = { [K in keyof typeof GENERAL_SKILLS_MESSAGE_IDS]: string };

const GENERAL_SKILL_PHASE_MESSAGE_IDS = {
  skill_loaded: 'generalSkillsPage.phase.skillLoaded',
  planning: 'generalSkillsPage.phase.planning',
  plan_created: 'generalSkillsPage.phase.planCreated',
  attempt_started: 'generalSkillsPage.phase.attemptStarted',
  running_code: 'generalSkillsPage.phase.runningCode',
  stdout_chunk: 'generalSkillsPage.phase.stdoutChunk',
  stderr_chunk: 'generalSkillsPage.phase.stderrChunk',
  code_finished: 'generalSkillsPage.phase.codeFinished',
  code_timeout: 'generalSkillsPage.phase.codeTimeout',
  reflection_passed: 'generalSkillsPage.phase.reflectionPassed',
  reflection_retrying: 'generalSkillsPage.phase.reflectionRetrying',
  reflection_stopped: 'generalSkillsPage.phase.reflectionStopped',
  repair_planning: 'generalSkillsPage.phase.repairPlanning',
  repair_failed: 'generalSkillsPage.phase.repairFailed',
  plan_failed: 'generalSkillsPage.phase.planFailed',
  replying: 'generalSkillsPage.phase.replying',
  reply_created: 'generalSkillsPage.phase.replyCreated',
  reply_failed: 'generalSkillsPage.phase.replyFailed',
} as const satisfies Record<string, MessageId>;

/** 将稳定 message ID 映射展开为当前 locale 的显示文案。 */
function buildLocalizedCopy<T extends Record<string, MessageId>>(
  messageIds: T,
  locale: 'zh-CN' | 'en-US',
  translate: ReturnType<typeof useAppIntl>['t'],
): { [K in keyof T]: string } {
  const catalog = locale === 'en-US'
    ? englishMessages as Record<string, string>
    : chineseMessages as Record<string, string>;
  return Object.fromEntries(
    Object.entries(messageIds).map(([key, id]) => [key, catalog[id] ?? translate(id)]),
  ) as { [K in keyof T]: string };
}

/** 返回技能广场页当前 locale 的语义文案。 */
function useGeneralSkillsCopy(): GeneralSkillsCopy {
  const { locale, t } = useAppIntl();
  return buildLocalizedCopy(GENERAL_SKILLS_MESSAGE_IDS, locale, t);
}

/** 用当前 locale 的语义模板生成默认技能 markdown。 */
function defaultSkillMarkdown(translate: ReturnType<typeof useAppIntl>['t']): string {
  return translate('generalSkillsPage.defaultSkillMarkdown');
}

/** 返回当前 locale 的技能状态 badge 文案。 */
function generalSkillStatusBadge(
  status: GeneralSkillRead['status'],
  copy: GeneralSkillsCopy,
): { tone: BadgeTone; text: string } {
  const map: Record<GeneralSkillRead['status'], { tone: BadgeTone; text: string }> = {
    draft: { tone: 'blue', text: copy.draft },
    published: { tone: 'green', text: copy.enabled },
    archived: { tone: 'gray', text: copy.archived },
  };
  return map[status];
}

/** 生成带动态参数的轻量文案，catalog 解锁前避免散落手工拼接。 */
function interpolate(template: string, params: Record<string, string | number>): string {
  return Object.entries(params).reduce(
    (text, [key, value]) => text.split(`{${key}}`).join(String(value)),
    template,
  );
}

const SECTION_CARD_CLASS =
  'flex flex-col gap-[24px] rounded-[20px_20px_0_0] bg-[#FFF] p-[18px] shadow-[0_-4px_16px_0_rgba(0,0,0,0.05)]';
const SECTION_CARD_TITLE_CLASS = 'text-[14px] font-medium text-[#18181a]';
const FIELD_LABEL_CLASS = 'text-[13px] font-medium text-[#18181a]';
const RETURN_BUTTON_CLASS =
  'h-8 gap-1 rounded-[10px] border-[0.5px] border-[#e3e7f1] bg-white px-5 text-[12px] font-normal text-[#757f9c] hover:border-[#cbd3e6]! hover:bg-white! hover:text-[#18181a]! aria-expanded:border-[#cbd3e6]! aria-expanded:bg-white! aria-expanded:text-[#18181a]!';
const PRIMARY_BUTTON_CLASS =
  'h-8 gap-1 rounded-[10px] bg-[#18181a] px-5 text-[12px] font-normal text-white hover:bg-[#303030]';
const DELETE_BUTTON_CLASS =
  'h-8 gap-1 rounded-[10px] border-[0.5px] border-[#e3e7f1] bg-white px-5 text-[12px] font-normal text-[#d20b0b] hover:border-[#f3b6b6]! hover:bg-[#fce7e7]! hover:text-[#d20b0b]! aria-expanded:border-[#f3b6b6]! aria-expanded:bg-[#fce7e7]! aria-expanded:text-[#d20b0b]!';
const EDITOR_ACTION_OUTLINE_CLASS = RETURN_BUTTON_CLASS;
const EDITOR_ACTION_PRIMARY_CLASS = PRIMARY_BUTTON_CLASS;
const HIDDEN_FILE_INPUT_CLASS =
  'pointer-events-none fixed size-px opacity-0 [inset:auto_auto_0_0]';
const SKILL_EDITOR_DRAG_ACTIVE_CLASS =
  'ring-1 ring-[#18181a]/20 shadow-[0_-4px_16px_0_rgba(0,0,0,0.08)]';
const SKILL_DROP_HINT_CLASS =
  'pointer-events-none absolute inset-x-[18px] bottom-[18px] top-[46px] z-[6] flex items-center justify-center gap-3 rounded-[14px] border border-dashed border-[#18181a] bg-white/90 text-[15px] font-semibold text-[#18181a] shadow-sm backdrop-blur-sm';
const SKILL_FILE_EDITOR_CLASS =
  'grid min-h-[560px] flex-1 grid-cols-[minmax(180px,240px)_minmax(0,1fr)] overflow-hidden border-t border-[#e3e7f1] bg-[#fafafa]';
const SKILL_FILE_TREE_CLASS =
  'grid min-w-0 grid-rows-[auto_minmax(0,1fr)_auto] border-r border-[#e3e7f1] bg-white';
const SKILL_FILE_TREE_HEADER_CLASS =
  'flex min-h-[44px] items-center gap-2 border-b border-[#e3e7f1] bg-[#f6f6f6] px-[14px] text-[12px] font-medium text-[#757f9c]';
const SKILL_FILE_TREE_LIST_CLASS =
  'min-h-0 overflow-auto bg-white p-2';
const SKILL_FILE_TREE_ACTIONS_CLASS =
  'flex gap-2 border-t border-[#e3e7f1] bg-white p-[10px]';
const SKILL_FILE_PANE_CLASS =
  'grid min-w-0 grid-rows-[auto_minmax(0,1fr)]';
const SKILL_FILE_TAB_CLASS =
  'flex min-h-[44px] items-center gap-2 border-b border-[#e3e7f1] bg-[#f6f6f6] px-[14px] text-[12px] font-medium text-[#757f9c]';
const SKILL_FILE_TAB_ACTION_BUTTON_CLASS =
  'inline-flex h-[28px] shrink-0 items-center gap-[4px] rounded-[6px] px-[8px] text-[12px] font-medium text-[#757f9c] transition-colors hover:bg-[#edf1f7] hover:text-[#18181a] disabled:pointer-events-none disabled:opacity-40';
const SKILL_CODE_EDITOR_CLASS =
  'relative min-h-0 overflow-hidden bg-[#fafafa] font-mono text-[13px] leading-[1.7] tab-[2] shadow-[inset_0_1px_0_#e3e7f1]';
const SKILL_MARKDOWN_PREVIEW_CLASS =
  'min-h-0 overflow-auto bg-white p-[18px_20px] text-[14px] leading-[1.8] text-[#18181a]';
const SKILL_MARKDOWN_PREVIEW_BODY_CLASS =
  '[&>h1]:mb-4 [&>h1]:text-[22px] [&>h1]:font-semibold [&>h1]:leading-[1.35] [&>h2]:mb-3 [&>h2]:mt-6 [&>h2]:text-[18px] [&>h2]:font-semibold [&>h2]:leading-[1.4] [&>h3]:mb-2 [&>h3]:mt-5 [&>h3]:text-[16px] [&>h3]:font-semibold [&>p]:mb-3 [&>p]:whitespace-pre-wrap [&>ul]:mb-3 [&>ol]:mb-3 [&>ul]:pl-6 [&>ol]:pl-6 [&>li]:mb-1 [&>blockquote]:mb-3 [&>blockquote]:border-l-2 [&>blockquote]:border-[#e3e7f1] [&>blockquote]:pl-4 [&>blockquote]:text-[#757f9c] [&>code]:rounded-[4px] [&>code]:bg-[#f6f7fb] [&>code]:px-1 [&>code]:py-[1px] [&>code]:font-mono [&>pre]:mb-3 [&>pre]:overflow-auto [&>pre]:rounded-[10px] [&>pre]:bg-[#f6f7fb] [&>pre]:p-4 [&_table]:mb-3 [&_table]:w-full [&_table]:border-collapse [&_th]:border [&_th]:border-[#e3e7f1] [&_th]:bg-[#f6f7fb] [&_th]:px-3 [&_th]:py-2 [&_td]:border [&_td]:border-[#e3e7f1] [&_td]:px-3 [&_td]:py-2';
const SKILL_CODE_HIGHLIGHT_CLASS =
  'pointer-events-none absolute inset-0 z-[1] m-0 overflow-hidden whitespace-pre p-[18px_20px] text-[#18181a] tab-[2]';
const SKILL_CODE_HIGHLIGHT_CODE_CLASS =
  'block w-max min-w-full font-[inherit] will-change-transform';
const SKILL_CODE_INPUT_CLASS =
  'absolute inset-0 z-[2] m-0 size-full min-h-0 resize-none overflow-auto rounded-none border-0 bg-transparent! p-[18px_20px] font-[inherit] leading-[inherit] tracking-normal whitespace-pre text-transparent caret-[#18181a] outline-none tab-[2] [scrollbar-gutter:stable] selection:bg-[rgba(0,120,215,0.24)] [-webkit-text-fill-color:transparent]';
const SKILL_RESULT_LAYOUT_CLASS = 'grid gap-5';
const SKILL_SECTION_LABEL_CLASS =
  'mb-2 text-[12px] font-semibold text-[#757f9c]';
const SKILL_REPLY_PANEL_CLASS =
  'rounded-xl border border-[#eceef1] bg-white p-[16px_18px]';
const SKILL_REPLY_TEXT_CLASS =
  'mb-0! text-[15px] leading-[1.8] text-[#18181a]';
const SKILL_TRACE_LIST_CLASS =
  'grid gap-[10px] rounded-xl border border-[#eceef1] bg-[#fbfcfd] p-[12px_14px]';
const SKILL_TRACE_ITEM_CLASS =
  'grid min-w-0 grid-cols-[12px_minmax(0,1fr)] gap-[10px]';
const SKILL_TRACE_ITEM_BODY_CLASS = 'min-w-0 max-w-full';
const SKILL_TRACE_DOT_CLASS =
  'mt-[9px] size-[7px] shrink-0 rounded-full bg-[#18181a]';
const SKILL_TRACE_TITLE_CLASS =
  'text-[13px] font-semibold text-[#18181a]';
const SKILL_TRACE_MESSAGE_CLASS =
  'mt-[2px] break-words text-[12px] leading-[1.55] text-[#757f9c]';
const SKILL_TRACE_CODE_DETAILS_CLASS =
  'group/gs-trace box-border w-full min-w-0 max-w-full overflow-hidden rounded-xl border border-[#eceef1] bg-white';
const SKILL_TRACE_CODE_SUMMARY_CLASS =
  'flex min-h-[38px] cursor-pointer list-none items-center gap-2 px-3 py-[9px] text-[12px] font-semibold text-[#18181a] select-none group-open/gs-trace:border-b group-open/gs-trace:border-[#eceef1] [&::-webkit-details-marker]:hidden';
const SKILL_CODE_BLOCK_CLASS =
  'm-0 max-h-[520px] max-w-full overflow-auto whitespace-pre border-0 p-[16px_18px] font-mono text-[12px] leading-[1.65]';
const SKILL_OUTPUT_STACK_CLASS = 'grid gap-[10px]';

function skillFileNodeClass(active: boolean) {
  return cn(
    'flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg border-0 bg-transparent px-[10px] py-2 text-left text-[12px] text-[#757f9c] transition-[background,color,box-shadow] duration-150',
    'hover:bg-[#f6f6f6] hover:text-[#18181a]',
    active && 'bg-[#f6f6f6] text-[#18181a]',
  );
}

function TraceDisclosureLabel() {
  const copy = useGeneralSkillsCopy();
  return (
    <span className="ml-auto text-[12px] font-medium text-[#757f9c]">
      <span className="group-open/gs-trace:hidden">{copy.expandLabel}</span>
      <span className="hidden group-open/gs-trace:inline">{copy.collapseLabel}</span>
    </span>
  );
}

const GENERAL_SKILL_RUN_IDLE_TIMEOUT_MS = 600_000;
const FOLDER_INPUT_PROPS = {
  webkitdirectory: '',
  directory: '',
} as Record<string, string>;

type GeneralSkillFile = {
  path: string;
  content: string;
  size?: number;
  mime_type?: string;
};

type SkillFileTreeNode =
  | { kind: 'folder'; name: string; path: string; children: SkillFileTreeNode[] }
  | { kind: 'file'; name: string; path: string; file: GeneralSkillFile };

type DroppedSkillFile = {
  file: File;
  path: string;
};

type GeneralSkillImportMode = 'plaza' | 'employee';

type SkillFileSystemEntry = {
  name: string;
  fullPath: string;
  isFile: boolean;
  isDirectory: boolean;
};

type SkillFileEntry = SkillFileSystemEntry & {
  file: (success: (file: File) => void, failure?: (error: DOMException) => void) => void;
};

type SkillDirectoryEntry = SkillFileSystemEntry & {
  createReader: () => {
    readEntries: (
      success: (entries: SkillFileSystemEntry[]) => void,
      failure?: (error: DOMException) => void,
    ) => void;
  };
};

/** 返回执行阶段的语义标题；未知阶段保留稳定 phase 标识。 */
function generalSkillPhaseLabel(
  phase: string,
  translate: ReturnType<typeof useAppIntl>['t'],
  fallback: string,
): string {
  if (Object.prototype.hasOwnProperty.call(GENERAL_SKILL_PHASE_MESSAGE_IDS, phase)) {
    return translate(GENERAL_SKILL_PHASE_MESSAGE_IDS[phase as keyof typeof GENERAL_SKILL_PHASE_MESSAGE_IDS]);
  }
  return String(phase || fallback);
}

/** 将后端异常投影为安全 UI 文案；未知原始异常统一回退到调用方指定的语义消息。 */
function generalSkillsPageErrorMessage(
  error: unknown,
  fallback: string,
  translate: ReturnType<typeof useAppIntl>['t'],
): string {
  const generic = translate('common.error.generic');
  const message = apiErrorMessage(error, 'common.error.generic', { t: translate });
  return message === generic ? fallback : message;
}

function formatJson(value: unknown): string {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value, null, 2);
}

function codeLanguage(value: string, fallback = 'text'): string {
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  try {
    JSON.parse(trimmed);
    return 'json';
  } catch {
    return fallback;
  }
}

function isSkillPackageArchive(file: File): boolean {
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  return name.endsWith('.zip') || type === 'application/zip' || type === 'application/x-zip-compressed';
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result || '');
      resolve(value.includes(',') ? value.split(',', 2)[1] : value);
    };
    reader.onerror = () => reject(reader.error || new Error('File read failed'));
    reader.readAsDataURL(file);
  });
}

function RunCodePanel({
  title,
  code,
  language,
  defaultOpen = false,
  className,
}: {
  title: string;
  code: string;
  language?: string;
  defaultOpen?: boolean;
  className?: string;
}) {
  return (
    <details className={cn(SKILL_TRACE_CODE_DETAILS_CLASS, 'mt-0', className)} open={defaultOpen}>
      <summary className={SKILL_TRACE_CODE_SUMMARY_CLASS}>
        {title}
        <TraceDisclosureLabel />
      </summary>
      <CodeBlock className={SKILL_CODE_BLOCK_CLASS} code={code} language={language || codeLanguage(code)} />
    </details>
  );
}

type GeneralSkillPageProps = {
  currentUser?: EnterpriseAuthUser;
  onLogout?: () => void;
};

export function GeneralSkillNewPage(props: GeneralSkillPageProps = {}) {
  return <GeneralSkillEditorPage mode="new" {...props} />;
}

export function GeneralSkillEditPage(props: GeneralSkillPageProps = {}) {
  return <GeneralSkillEditorPage mode="edit" {...props} />;
}

/** 按租户会话代次隔离技能列表状态，切换租户时先卸载旧内容再加载新数据。 */
export default function GeneralSkillsPage(props: { embedded?: boolean } & GeneralSkillPageProps) {
  const tenantContext = useTenantSession();
  const tenantScopeKey = tenantContext
    ? tenantContext.tenantId
    : 'no-tenant';
  return <GeneralSkillsPageContent key={tenantScopeKey} {...props} />;
}

function GeneralSkillsPageContent({ embedded = false, currentUser, onLogout }: { embedded?: boolean } & GeneralSkillPageProps) {
  const { t } = useAppIntl();
  const tenantContext = useTenantSession();
  const tenantClient = useMemo(() => createTenantClient(tenantContext), [tenantContext]);
  const tenantId = tenantContext?.tenantId || '';
  const userId = tenantContext?.userId || '';
  const copy = useGeneralSkillsCopy();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [rows, setRows] = useState<GeneralSkillRead[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | GeneralSkillRead['status']>('all');
  const [agentId, setAgentId] = useState(
    () => tenantId && userId ? readEmployeeScope(tenantId, userId) : '',
  );
  const [isOverallAgent, setIsOverallAgent] = useState(true);
  const [agents, setAgents] = useState<AgentProfileRead[]>([]);
  const [clawhubModalOpen, setClawhubModalOpen] = useState(false);
  const [clawhubSource, setClawhubSource] = useState('');
  const [clawhubLoading, setClawhubLoading] = useState(false);
  const clawhubAbortRef = useRef<AbortController | null>(null);
  const [agentImportOpen, setAgentImportOpen] = useState(false);
  const [agentImportMode, setAgentImportMode] = useState<GeneralSkillImportMode>('plaza');
  const [agentImportLoading, setAgentImportLoading] = useState(false);
  const [agentImportAgents, setAgentImportAgents] = useState<AgentProfileRead[]>([]);
  const [agentImportSourceAgentId, setAgentImportSourceAgentId] = useState('');
  const [agentImportSourceSkills, setAgentImportSourceSkills] = useState<GeneralSkillRead[]>([]);
  const [agentImportSelectedSkillIds, setAgentImportSelectedSkillIds] = useState<string[]>([]);
  const [agentScopeLoaded, setAgentScopeLoaded] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<GeneralSkillRead | null>(null);
  const [deleting, setDeleting] = useState(false);
  const listLoadControllerRef = useRef<AbortController | null>(null);
  const listAgentScopeControllerRef = useRef<AbortController | null>(null);
  const listPublishControllerRef = useRef<AbortController | null>(null);
  const listDeleteControllerRef = useRef<AbortController | null>(null);
  const listImportAgentsControllerRef = useRef<AbortController | null>(null);
  const listImportSourceControllerRef = useRef<AbortController | null>(null);
  const listImportSubmitControllerRef = useRef<AbortController | null>(null);
  const tenantScopeKey = tenantContext
    ? `${tenantId}:${userId}:${tenantContext.generation}`
    : 'no-tenant';
  const [stateScopeKey, setStateScopeKey] = useState(tenantScopeKey);
  const hasCurrentTenantState = stateScopeKey === tenantScopeKey;

  useEffect(() => {
    if (hasCurrentTenantState) return;
    setRows([]);
    setAgents([]);
    setAgentScopeLoaded(false);
    setSearchText('');
    setStatusFilter('all');
    setAgentId(tenantId && userId ? readEmployeeScope(tenantId, userId) : '');
    setIsOverallAgent(true);
    setDeleting(false);
    setLoading(false);
    setAgentImportLoading(false);
    setAgentImportMode('plaza');
    setAgentImportAgents([]);
    setAgentImportSourceAgentId('');
    setAgentImportSourceSkills([]);
    setAgentImportSelectedSkillIds([]);
    setAgentImportOpen(false);
    setClawhubLoading(false);
    setClawhubSource('');
    setClawhubModalOpen(false);
    setDeleteTarget(null);
    setStateScopeKey(tenantScopeKey);
  }, [hasCurrentTenantState, tenantId, tenantScopeKey, userId]);

  useEffect(() => {
    setDeleting(false);
    setAgentImportLoading(false);
    return () => {
      [
        listLoadControllerRef,
        listAgentScopeControllerRef,
        listPublishControllerRef,
        listDeleteControllerRef,
        clawhubAbortRef,
        listImportAgentsControllerRef,
        listImportSourceControllerRef,
        listImportSubmitControllerRef,
      ].forEach((ref) => ref.current?.abort());
    };
  }, [tenantContext?.tenantId, tenantContext?.generation]);

  useEffect(() => {
    setAgentId(tenantId && userId ? readEmployeeScope(tenantId, userId) : '');
    setRows([]);
    setAgents([]);
    setAgentScopeLoaded(false);
  }, [tenantId, userId]);

  const scopedRows = hasCurrentTenantState ? rows : [];
  const scopedAgents = hasCurrentTenantState ? agents : [];
  const scopedAgentId = hasCurrentTenantState ? agentId : '';
  const scopedIsOverallAgent = hasCurrentTenantState ? isOverallAgent : true;
  const pageTitle = scopedIsOverallAgent ? copy.pageTitle : copy.scopedPageTitle;
  const listLabel = scopedIsOverallAgent ? copy.listOverall : copy.listScoped;
  const currentAgent = useMemo(() => scopedAgents.find((item) => item.id === scopedAgentId), [scopedAgents, scopedAgentId]);
  const canManageCurrentScope = currentAgent
    ? canManageEmployeeAgent(currentAgent, currentUser)
    : isEnterpriseAdmin(currentUser) && scopedIsOverallAgent;

  const load = () => {
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return Promise.resolve();
    const agentSuffix = agentId ? `&agent_id=${encodeURIComponent(agentId)}` : '';
    listLoadControllerRef.current?.abort();
    const controller = new AbortController();
    listLoadControllerRef.current = controller;
    setLoading(true);
    return tenantClient
      .get<GeneralSkillRead[]>(`/api/enterprise/general-skills?tenant_id=${tenantId}${agentSuffix}`, {
        signal: controller.signal,
      })
      .then((items) => {
        if (isCurrentTenantRequest(context, generation, controller)) setRows(items);
      })
      .catch((error) => {
        if (isCurrentTenantRequest(context, generation, controller)) {
          notify.error(generalSkillsPageErrorMessage(error, copy.loadFailed, t));
        }
      })
      .finally(() => {
        if (listLoadControllerRef.current === controller) listLoadControllerRef.current = null;
        if (isCurrentTenantRequest(context, generation, controller)) setLoading(false);
      });
  };

  useEffect(() => {
    if (!hasCurrentTenantState) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, hasCurrentTenantState, tenantContext, tenantClient, tenantId, tenantScopeKey]);

  useEffect(() => {
    if (!tenantContext || !hasCurrentTenantState) return;
    const context = tenantContext;
    const generation = context.generation;
    listAgentScopeControllerRef.current?.abort();
    const controller = new AbortController();
    listAgentScopeControllerRef.current = controller;
    tenantClient
      .get<AgentProfileRead[]>(`/api/enterprise/agents?tenant_id=${tenantId}`, { signal: controller.signal })
      .then((items) => {
        if (!isCurrentTenantRequest(context, generation, controller)) return;
        setAgents(items);
        setIsOverallAgent(Boolean(items.find((item) => item.id === agentId)?.is_overall ?? true));
        setAgentScopeLoaded(true);
      })
      .catch(() => {
        if (!isCurrentTenantRequest(context, generation, controller)) return;
        setIsOverallAgent(true);
        setAgentScopeLoaded(true);
      })
      .finally(() => {
        if (listAgentScopeControllerRef.current === controller) listAgentScopeControllerRef.current = null;
      });
    return () => controller.abort();
  }, [agentId, hasCurrentTenantState, tenantContext, tenantClient, tenantId, tenantScopeKey]);

  useEffect(() => {
    if (!hasCurrentTenantState) return;
    if (searchParams.get('add') !== 'plaza') return;
    if (!agentScopeLoaded) return;
    const resourceId = searchParams.get('resourceId') || undefined;
    if (scopedIsOverallAgent) {
      notify.warning(copy.plazaCopyRequiresEmployee);
    } else {
      void requestAgentImport('plaza', resourceId);
    }
    const next = new URLSearchParams(searchParams);
    next.delete('add');
    next.delete('resourceId');
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentScopeLoaded, hasCurrentTenantState, scopedIsOverallAgent, searchParams, setSearchParams]);

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
    return scopedRows.filter((row) => {
      const matchesStatus = statusFilter === 'all' || row.status === statusFilter;
      const haystack = [
        row.name,
        row.slug,
        row.description,
        row.homepage,
        resourceCreatorName(row),
      ].filter(Boolean).join(' ').toLowerCase();
      return matchesStatus && (!keyword || haystack.includes(keyword));
    });
  }, [scopedRows, searchText, statusFilter]);

  const pagination = useClientPagination(filteredRows, GENERAL_SKILL_PAGE_SIZE, `${searchText}|${statusFilter}`);

  const stats = useMemo(() => ({
    total: scopedRows.length,
    published: scopedRows.filter((row) => row.status === 'published').length,
    draft: scopedRows.filter((row) => row.status === 'draft').length,
    archived: scopedRows.filter((row) => row.status === 'archived').length,
  }), [scopedRows]);

  async function setSkillPublished(row: GeneralSkillRead, published: boolean) {
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return;
    listPublishControllerRef.current?.abort();
    const controller = new AbortController();
    listPublishControllerRef.current = controller;
    try {
      const agentSuffix = agentId ? `&agent_id=${encodeURIComponent(agentId)}` : '';
      const next = await tenantClient.post<GeneralSkillRead>(
        `/api/enterprise/general-skills/${row.slug}/${published ? 'publish' : 'archive'}?tenant_id=${tenantId}${agentSuffix}`,
        undefined,
        { signal: controller.signal },
      );
      if (!isCurrentTenantRequest(context, generation, controller)) return;
      setRows((current) => current.map((item) => (item.id === next.id ? next : item)));
      notify.success(published ? copy.enabledSuccess : copy.archivedSuccess);
    } catch (error) {
      if (!isCurrentTenantRequest(context, generation, controller)) return;
      notify.error(generalSkillsPageErrorMessage(error, published ? copy.enableFailed : copy.archiveFailed, t));
    } finally {
      if (listPublishControllerRef.current === controller) listPublishControllerRef.current = null;
    }
  }

  async function publishSkillToGallery(row: GeneralSkillRead) {
    if (!agentId) return;
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return;
    listPublishControllerRef.current?.abort();
    const controller = new AbortController();
    listPublishControllerRef.current = controller;
    try {
      const next = await tenantClient.post<GeneralSkillRead>(
        `/api/enterprise/general-skills/${encodeURIComponent(row.slug)}/publish-to-gallery?tenant_id=${tenantId}&agent_id=${encodeURIComponent(agentId)}`,
        undefined,
        { signal: controller.signal },
      );
      if (!isCurrentTenantRequest(context, generation, controller)) return;
      setRows((current) => current.map((item) => (item.id === next.id ? next : item)));
      notify.success(copy.publishToMarketplaceSuccess);
    } catch (error) {
      if (!isCurrentTenantRequest(context, generation, controller)) return;
      notify.error(generalSkillsPageErrorMessage(error, copy.publishToMarketplaceFailed, t));
    } finally {
      if (listPublishControllerRef.current === controller) listPublishControllerRef.current = null;
    }
  }

  async function confirmDeleteSkill() {
    const row = deleteTarget;
    if (!row || !row.id || !row.slug) return;
    const branchMode = !scopedIsOverallAgent;
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return;
    listDeleteControllerRef.current?.abort();
    const controller = new AbortController();
    listDeleteControllerRef.current = controller;
    setDeleting(true);
    try {
      const agentSuffix = agentId ? `&agent_id=${encodeURIComponent(agentId)}` : '';
      await tenantClient.delete(
        `/api/enterprise/general-skills/${row.slug}?tenant_id=${tenantId}${agentSuffix}`,
        undefined,
        { signal: controller.signal },
      );
      if (!isCurrentTenantRequest(context, generation, controller)) return;
      setRows((current) => current.filter((item) => item.id !== row.id));
      notify.success(branchMode ? copy.removedSuccess : copy.deletedSuccess);
      setDeleteTarget(null);
    } catch (error) {
      if (!isCurrentTenantRequest(context, generation, controller)) return;
      notify.error(generalSkillsPageErrorMessage(error, branchMode ? copy.removeFailed : copy.deleteSkillFailed, t));
    } finally {
      if (listDeleteControllerRef.current === controller) listDeleteControllerRef.current = null;
      if (isCurrentTenantRequest(context, generation, controller)) setDeleting(false);
    }
  }

  function requestClawHubImport() {
    clawhubAbortRef.current?.abort();
    clawhubAbortRef.current = null;
    setClawhubLoading(false);
    setClawhubSource('');
    setClawhubModalOpen(true);
  }

  function cancelClawHubImport() {
    clawhubAbortRef.current?.abort();
    clawhubAbortRef.current = null;
    setClawhubLoading(false);
    setClawhubModalOpen(false);
  }

  async function requestAgentImport(mode: GeneralSkillImportMode, selectedResourceId?: string) {
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return;
    listImportAgentsControllerRef.current?.abort();
    const controller = new AbortController();
    listImportAgentsControllerRef.current = controller;
    try {
      const agents = await tenantClient.get<AgentProfileRead[]>(`/api/enterprise/agents?tenant_id=${tenantId}`, {
        signal: controller.signal,
      });
      if (!isCurrentTenantRequest(context, generation, controller)) return;
      const firstSource = mode === 'plaza'
        ? openGalleryAgentId(agents)
        : visibleEmployeeAgents(agents, currentUser, { activeOnly: true, excludeAgentId: agentId })[0]?.id || '';
      setAgentImportMode(mode);
      setAgentImportAgents(agents);
      setAgentImportSourceAgentId(firstSource);
      setAgentImportSelectedSkillIds([]);
      setAgentImportOpen(true);
      if (firstSource) {
        const sourceRows = await loadAgentImportSourceSkills(firstSource);
        if (!isCurrentTenantRequest(context, generation, controller)) return;
        if (selectedResourceId && sourceRows.some((item) => item.id === selectedResourceId)) {
          setAgentImportSelectedSkillIds([selectedResourceId]);
        }
      } else {
        setAgentImportSourceSkills([]);
      }
    } catch (error) {
      if (!isCurrentTenantRequest(context, generation, controller)) return;
      notify.error(generalSkillsPageErrorMessage(error, copy.loadAgentsFailed, t));
    } finally {
      if (listImportAgentsControllerRef.current === controller) listImportAgentsControllerRef.current = null;
    }
  }

  async function loadAgentImportSourceSkills(sourceAgentId: string): Promise<GeneralSkillRead[]> {
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return [];
    listImportSourceControllerRef.current?.abort();
    const controller = new AbortController();
    listImportSourceControllerRef.current = controller;
    setAgentImportSourceSkills([]);
    setAgentImportSelectedSkillIds([]);
    if (!sourceAgentId) {
      listImportSourceControllerRef.current = null;
      return [];
    }
    try {
      const sourceRows = await tenantClient.get<GeneralSkillRead[]>(
        `/api/enterprise/general-skills?tenant_id=${tenantId}&agent_id=${encodeURIComponent(sourceAgentId)}`,
        { signal: controller.signal },
      );
      if (!isCurrentTenantRequest(context, generation, controller)) return [];
      const existingIds = new Set(rows.map((item) => item.id));
      const publishedRows = sourceRows.filter((item) => item.status === 'published' && !existingIds.has(item.id));
      setAgentImportSourceSkills(publishedRows);
      return publishedRows;
    } catch (error) {
      if (!isCurrentTenantRequest(context, generation, controller)) return [];
      notify.error(generalSkillsPageErrorMessage(error, copy.loadSourceSkillsFailed, t));
      return [];
    } finally {
      if (listImportSourceControllerRef.current === controller) listImportSourceControllerRef.current = null;
    }
  }

  async function submitAgentImportSkills() {
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return;
    if (!agentId) {
      notify.warning(copy.selectEmployeeFirst);
      return;
    }
    if (!agentImportSourceAgentId) {
      notify.warning(agentImportMode === 'plaza' ? copy.selectMarketplaceFirst : copy.selectSourceFirst);
      return;
    }
    if (!agentImportSelectedSkillIds.length) {
      notify.warning(copy.selectSkillsFirst);
      return;
    }
    listImportSubmitControllerRef.current?.abort();
    const controller = new AbortController();
    listImportSubmitControllerRef.current = controller;
    setAgentImportLoading(true);
    try {
      await tenantClient.post(`/api/enterprise/agents/${encodeURIComponent(agentId)}/resources/import`, {
        tenant_id: tenantId,
        source_agent_id: agentImportSourceAgentId,
        resource_type: 'general_skill',
        resource_ids: agentImportSelectedSkillIds,
      }, { signal: controller.signal });
      if (!isCurrentTenantRequest(context, generation, controller)) return;
      notify.success(interpolate(copy.copiedSkillsSuccess, { count: agentImportSelectedSkillIds.length }));
      setAgentImportOpen(false);
      await load();
    } catch (error) {
      if (!isCurrentTenantRequest(context, generation, controller)) return;
      notify.error(generalSkillsPageErrorMessage(error, copy.copySkillsFailed, t));
    } finally {
      if (listImportSubmitControllerRef.current === controller) listImportSubmitControllerRef.current = null;
      if (isCurrentTenantRequest(context, generation, controller)) setAgentImportLoading(false);
    }
  }

  async function importClawHubSource() {
    if (!clawhubSource.trim()) {
      notify.warning(copy.enterOpenSourceUrl);
      return;
    }
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return;
    const controller = new AbortController();
    clawhubAbortRef.current?.abort();
    clawhubAbortRef.current = controller;
    setClawhubLoading(true);
    try {
      const row = await tenantClient.postWithSignal<GeneralSkillRead>('/api/enterprise/general-skills/import-skillhub', {
        tenant_id: tenantId,
        agent_id: !scopedIsOverallAgent && scopedAgentId ? scopedAgentId : undefined,
        source: clawhubSource.trim(),
        status: 'published',
      }, controller.signal);
      if (!isCurrentTenantRequest(context, generation, controller)) return;
      notify.success(interpolate(copy.importedOpenSourceSuccess, { name: row.name }));
      setRows((current) => [row, ...current.filter((item) => item.id !== row.id && item.slug !== row.slug)]);
      setClawhubModalOpen(false);
      navigate(`/enterprise/general-skills/${encodeURIComponent(row.slug)}/edit`);
    } catch (error) {
      if (!isCurrentTenantRequest(context, generation, controller)) return;
      if (isAbortError(error)) {
        notify.info(copy.importCanceled);
        return;
      }
      notify.error(generalSkillsPageErrorMessage(error, copy.importOpenSourceFailed, t));
    } finally {
      if (clawhubAbortRef.current === controller) {
        clawhubAbortRef.current = null;
        if (isCurrentTenantRequest(context, generation, controller)) setClawhubLoading(false);
      }
    }
  }

  function renderActions(row: GeneralSkillRead) {
    const published = row.status === 'published';
    if (scopedIsOverallAgent && !canManageCurrentScope) {
      return null;
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
          <DropdownMenuItem
            className={MENU_ITEM_CLASS}
            onSelect={() => navigate(`/enterprise/general-skills/${encodeURIComponent(row.slug)}/edit`)}
          >
            <IconEdit />
            {scopedIsOverallAgent ? copy.actionEdit : copy.actionEditLocal}
          </DropdownMenuItem>
          {published ? (
            <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => void setSkillPublished(row, false)}>
              <Ban />
              {copy.actionArchive}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => void setSkillPublished(row, true)}>
              <CircleCheck />
              {copy.actionPublish}
            </DropdownMenuItem>
          )}
          {!scopedIsOverallAgent && row.metadata?.scope === 'agent_private' && (
            <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => void publishSkillToGallery(row)}>
              <UploadOutlined />
              {copy.publishToMarketplaceAction}
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator className="my-[2px] bg-[#eef0f4]" />
          <DropdownMenuItem
            variant="destructive"
            className={MENU_ITEM_DANGER_CLASS}
            onSelect={() => setDeleteTarget(row)}
          >
            <IconTrash />
            {scopedIsOverallAgent ? copy.actionDelete : copy.actionRemove}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  const columns: DataTableColumn<GeneralSkillRead>[] = [
    {
      key: 'name',
      title: copy.columnName,
      width: 200,
      className: 'text-[#18181a]',
      render: (row) => (
        <div className="flex min-w-0 flex-col gap-[2px]">
          <span className="truncate font-medium leading-[18px] text-[#18181a]" title={row.name}>
            <RawContent value={row.name} />
          </span>
          <span className="truncate text-[#858b9c]" title={row.slug}>
            <RawContent value={row.slug} />
          </span>
        </div>
      ),
    },
    {
      key: 'description',
      title: copy.columnDescription,
      className: 'whitespace-normal',
      render: (row) => row.description
        ? <span className="line-clamp-2 wrap-break-word"><RawContent value={row.description} /></span>
        : <span className="line-clamp-2 wrap-break-word">{copy.noDescription}</span>,
    },
    {
      key: 'files',
      title: copy.columnFiles,
      width: 90,
      render: (row) => interpolate(copy.filesCount, { count: row.skill_files?.length || 1 }),
    },
    {
      key: 'capability_scope',
      title: copy.columnCapabilityScope,
      width: 105,
      render: (row) => <CapabilityScopeBadge value={row.capability_scope} />,
    },
    {
      key: 'creator',
      title: copy.columnCreator,
      width: 120,
      render: (row) => {
        const creator = resourceCreatorName(row);
        return (
          <span className="block truncate text-[#858b9c]" title={creator || ''}>
            {creator ? <RawContent value={creator} /> : '-'}
          </span>
        );
      },
    },
    {
      key: 'status',
      title: copy.columnStatus,
      width: 100,
      render: (row) => {
        const preset = generalSkillStatusBadge(row.status, copy) || { tone: 'gray' as BadgeTone, text: row.status };
        return <StatusBadge tone={preset.tone}>{preset.text}</StatusBadge>;
      },
    },
    {
      key: 'updated',
      title: copy.columnUpdatedAt,
      width: 170,
      render: (row) => formatDateTime(row.updated_at),
    },
    {
      key: 'actions',
      title: copy.columnActions,
      width: 70,
      align: 'right',
      render: (row) => renderActions(row),
    },
  ];

  const renderMobileCard = (row: GeneralSkillRead) => {
    const preset = generalSkillStatusBadge(row.status, copy) || { tone: 'gray' as BadgeTone, text: row.status };
    return (
      <article className={MOBILE_CARD_CLASS} key={row.id}>
        <div className="flex min-w-0 items-start justify-between gap-[10px]">
          <div className="min-w-0">
            <strong className="block truncate text-[14px] font-semibold text-[#18181a]"><RawContent value={row.name} /></strong>
            <span className="mt-[2px] block truncate text-[12px] text-[#858b9c]"><RawContent value={row.slug} /></span>
            <span className="mt-[2px] block truncate text-[12px] text-[#858b9c]">
              {copy.creatorPrefix}
              {resourceCreatorName(row) ? <RawContent value={resourceCreatorName(row) || ''} /> : '-'}
            </span>
          </div>
          {renderActions(row)}
        </div>
        {row.description && (
          <p className="mt-[8px] line-clamp-2 text-[12px] leading-[1.55] text-[#858b9c]"><RawContent value={row.description} /></p>
        )}
        <div className="mt-[10px] flex items-center justify-between gap-[10px] text-[12px] text-[#858b9c]">
          <div className="flex items-center gap-[6px]">
            <StatusBadge tone={preset.tone}>{preset.text}</StatusBadge>
            <CapabilityScopeBadge value={row.capability_scope} />
          </div>
          <span>{interpolate(copy.fileCountAndUpdatedAt, { count: row.skill_files?.length || 1, updatedAt: formatDateTime(row.updated_at) })}</span>
        </div>
      </article>
    );
  };

  const listEmptyText = scopedIsOverallAgent
    ? canManageCurrentScope ? copy.emptyManage : copy.emptyReadonly
    : copy.emptyScoped;

  if (!agentScopeLoaded) return <CapabilityScopeLoading />;

  return (
    <div className={embedded ? undefined : 'min-h-full box-border px-[48px] pt-[32px] pb-[43px] max-[900px]:px-[16px]'}>
      {!embedded && (
        <>
          <AppHeader onLogout={onLogout} userName={currentUser?.username} title={pageTitle} />
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
                <DropdownMenuTrigger data-guide-target="skills-create" className="flex h-[34px] items-center gap-[4px] rounded-[10px] bg-[#18181a] px-[20px] text-[12px] font-normal text-white outline-none transition-colors hover:bg-[#303030]">
                  <IconAdd className="size-[14px]" />
                  {copy.add}
                  <IconChevronDown className="size-[12px]" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className={MENU_CONTENT_CLASS}>
                  <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => navigate('/enterprise/general-skills/new')}>
                    <IconAdd />
                    {copy.create}
                  </DropdownMenuItem>
                  {!scopedIsOverallAgent && (
                    <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => void requestAgentImport('plaza')}>
                      <Copy />
                      {copy.copyFromMarketplace}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => requestClawHubImport()}>
                    <GithubOutlined />
                    {copy.importFromOpenSource}
                  </DropdownMenuItem>
                  {!scopedIsOverallAgent && (
                    <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => void requestAgentImport('employee')}>
                      <Users />
                      {copy.copyFromEmployee}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </>
      )}

      <div className="flex flex-col gap-[24px] rounded-[20px_20px_0_0] bg-[#FFF] p-[18px] shadow-[0_-4px_16px_0_rgba(0,0,0,0.05)]">
        <div className="flex flex-wrap items-stretch gap-[20px]" aria-label={copy.total}>
          <StatCard label={copy.total} value={stats.total} />
          <StatCard label={copy.enabled} value={stats.published} tone="green" />
          <StatCard label={copy.draft} value={stats.draft} />
          <StatCard label={copy.archived} value={stats.archived} />
        </div>

        <div className="flex flex-col gap-[18px]">
          <div className="flex items-center gap-[6px] px-[12px] text-[#757f9c]">
            <IconMagicWand className="size-[14px] shrink-0" />
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
                aria-label={copy.searchLabel}
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
            <UISelect value={statusFilter} onValueChange={(value) => setStatusFilter(value as 'all' | GeneralSkillRead['status'])}>
              <SelectTrigger className={cn(SELECT_TRIGGER_CLASS, 'w-[130px]')} aria-label={copy.statusFilter}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{copy.statusAll}</SelectItem>
                <SelectItem value="published">{copy.enabled}</SelectItem>
                <SelectItem value="draft">{copy.draft}</SelectItem>
                <SelectItem value="archived">{copy.archived}</SelectItem>
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
      </div>

      <ClawHubDialog
        open={clawhubModalOpen}
        loading={clawhubLoading}
        source={clawhubSource}
        onSourceChange={setClawhubSource}
        onClose={cancelClawHubImport}
        onSubmit={() => void importClawHubSource()}
      />

      <ResourceImportDialog
        open={agentImportOpen}
        loading={agentImportLoading}
        icon={<IconSkill className="size-[14px] shrink-0" />}
        title={agentImportMode === 'plaza' ? copy.importMarketplaceTitle : copy.importEmployeeTitle}
        sourcePlaceholder={agentImportMode === 'plaza' ? copy.importMarketplacePlaceholder : copy.importEmployeePlaceholder}
        sources={agentImportMode === 'plaza'
          ? openGalleryImportSourceOptions(agentImportAgents, copy.importMarketplacePlaceholder)
          : visibleEmployeeAgents(agentImportAgents, currentUser, { activeOnly: true, excludeAgentId: agentId })
            .map((item) => ({ value: item.id, label: item.name }))}
        sourceId={agentImportSourceAgentId}
        itemsLabel={copy.importItemsLabel}
        items={agentImportSourceSkills.map((item) => ({
          id: item.id,
          label: (
            <>
              <RawContent value={item.name} />
              <span className="text-[#858b9c]"> · {item.slug}</span>
            </>
          ),
        }))}
        selectedIds={agentImportSelectedSkillIds}
        emptyText={copy.importEmpty}
        note={
          agentImportMode === 'plaza'
            ? copy.importMarketplaceNote
            : copy.importEmployeeNote
        }
        onSourceChange={(value) => {
          setAgentImportSourceAgentId(value);
          void loadAgentImportSourceSkills(value);
        }}
        onSelectedChange={setAgentImportSelectedSkillIds}
        onClose={() => setAgentImportOpen(false)}
        onSubmit={() => void submitAgentImportSkills()}
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        loading={deleting}
        title={deleteTarget
          ? copy.deleteTitle
            .replace('{action}', scopedIsOverallAgent ? copy.actionDelete : copy.actionRemove)
            .replace('{name}', deleteTarget.name)
          : ''}
        description={
          scopedIsOverallAgent
            ? copy.deleteDescriptionOverall
            : copy.deleteDescriptionScoped
        }
        confirmText={scopedIsOverallAgent ? copy.actionDelete : copy.actionRemove}
        onConfirm={() => void confirmDeleteSkill()}
      />
    </div>
  );
}

function ClawHubDialog({
  open,
  loading,
  source,
  onSourceChange,
  onClose,
  onSubmit,
}: {
  open: boolean;
  loading: boolean;
  source: string;
  onSourceChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const copy = useGeneralSkillsCopy();
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        aria-describedby={undefined}
        className="flex w-[calc(100%-2rem)] flex-col gap-[16px] overflow-hidden rounded-[14px] px-[20px] py-[16px] sm:max-w-[560px]"
      >
        <div className="flex items-center gap-[6px] px-[12px] text-[#757f9c]">
          <IconSkill className="size-[14px] shrink-0" />
          <DialogTitle className="text-[14px] font-normal leading-none text-[#757f9c]">
            {copy.importOpenSourceTitle}
          </DialogTitle>
        </div>

        <div className="flex flex-col gap-[12px] px-[12px]">
          <p className="text-[12px] leading-[1.6] text-[#858b9c]">
            {copy.importOpenSourceHelp}
          </p>
          <input
            autoComplete="off"
            data-1p-ignore="true"
            data-lpignore="true"
            data-bwignore="true"
            value={source}
            onChange={(event) => onSourceChange(event.target.value)}
            placeholder={copy.importOpenSourcePlaceholder}
            className="h-[34px] w-full rounded-[10px] border-[0.5px] border-[#e3e7f1] bg-white px-[12px] text-[12px] text-[#17191f] outline-none transition-colors placeholder:text-[#c0c6d4] focus:border-[#18181a]"
          />
        </div>

        <div className="flex items-center justify-end gap-[8px] px-[12px]">
          <UIButton
            variant="outline"
            disabled={loading}
            onClick={onClose}
            className="h-[32px] w-[80px] rounded-[10px] border-[#e3e7f1] bg-white px-[12px] text-[14px] font-normal text-[#464c5e] hover:border-[#e3e7f1] hover:bg-[#f6f6f6] hover:text-[#18181a]"
          >
            {copy.cancelAction}
          </UIButton>
          <UIButton
            disabled={loading}
            onClick={onSubmit}
            className="h-[32px] w-[80px] rounded-[10px] bg-[#18181a] px-[12px] text-[14px] font-normal text-white hover:bg-[#303030]"
          >
            {copy.add}
          </UIButton>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function traceDetail(item: Record<string, unknown>): string {
  return [
    item.rationale,
    item.expected_output,
    item.phase === 'code_finished' ? item.stdout_preview : undefined,
    item.phase === 'code_finished' || item.phase === 'code_timeout' ? item.stderr_preview : undefined,
    item.run_id,
  ]
    .filter((value) => typeof value === 'string' && value.trim())
    .map(String)
    .join('\n');
}

function traceItemCode(item: Record<string, unknown>): string {
  return typeof item.code === 'string' && item.code.trim() ? item.code : '';
}

function resultSucceeded(result: Partial<GeneralSkillRunResponse> | null): boolean {
  if (!result) return false;
  const success = result.structured_result?.success;
  return success !== false && !result.stderr;
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  return error instanceof Error && error.name === 'AbortError';
}

function languageFromFilePath(path?: string): string {
  const extension = (path || '').split('.').pop()?.toLowerCase();
  if (extension === 'py') return 'python';
  if (extension === 'json') return 'json';
  if (extension === 'md' || extension === 'markdown') return 'markdown';
  return 'text';
}

function normalizeSkillFilePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/').trim();
}

function isValidSkillFilePath(path: string): boolean {
  const parts = path.split('/');
  return Boolean(path) && parts.every((part) => Boolean(part) && part !== '.' && part !== '..');
}

function skillFolderPaths(files: GeneralSkillFile[], explicitDirectories: string[]): string[] {
  const paths = new Set<string>();
  [...explicitDirectories, ...files.map((file) => file.path)]
    .forEach((rawPath) => {
      const parts = normalizeSkillFilePath(rawPath).split('/').filter(Boolean);
      const folderPartCount = explicitDirectories.includes(rawPath) ? parts.length : Math.max(0, parts.length - 1);
      for (let index = 1; index <= folderPartCount; index += 1) {
        paths.add(parts.slice(0, index).join('/'));
      }
    });
  return Array.from(paths).sort((left, right) => left.localeCompare(right, 'zh-CN'));
}

function buildSkillFileTree(files: GeneralSkillFile[], explicitDirectories: string[]): SkillFileTreeNode[] {
  const root: SkillFileTreeNode[] = [];
  const folders = new Map<string, Extract<SkillFileTreeNode, { kind: 'folder' }>>();

  const ensureFolder = (path: string) => {
    const normalized = normalizeSkillFilePath(path);
    const existing = folders.get(normalized);
    if (existing) return existing;
    const parts = normalized.split('/');
    const name = parts.pop() || normalized;
    const parentPath = parts.join('/');
    const node: Extract<SkillFileTreeNode, { kind: 'folder' }> = {
      kind: 'folder',
      name,
      path: normalized,
      children: [],
    };
    (parentPath ? ensureFolder(parentPath).children : root).push(node);
    folders.set(normalized, node);
    return node;
  };

  skillFolderPaths(files, explicitDirectories).forEach(ensureFolder);
  files.forEach((file) => {
    const normalized = normalizeSkillFilePath(file.path);
    const parts = normalized.split('/');
    const name = parts.pop() || normalized;
    const parentPath = parts.join('/');
    const node: SkillFileTreeNode = { kind: 'file', name, path: normalized, file };
    (parentPath ? ensureFolder(parentPath).children : root).push(node);
  });

  const sortNodes = (nodes: SkillFileTreeNode[]) => {
    nodes.sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === 'folder' ? -1 : 1;
      return left.name.localeCompare(right.name, 'zh-CN');
    });
    nodes.forEach((node) => {
      if (node.kind === 'folder') sortNodes(node.children);
    });
  };
  sortNodes(root);
  return root;
}

function mimeTypeFromSkillFilePath(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase();
  if (extension === 'md' || extension === 'markdown') return 'text/markdown';
  if (extension === 'json') return 'application/json';
  if (extension === 'py') return 'text/x-python';
  return 'text/plain';
}

function SkillFileTreeEntry({
  node,
  depth,
  expandedFolders,
  selectedFilePath,
  selectedFolderPath,
  onToggleFolder,
  onSelectFile,
  onCreateEntry,
  onRenameFile,
  onRenameFolder,
  onDeleteFile,
  onDeleteFolder,
}: {
  node: SkillFileTreeNode;
  depth: number;
  expandedFolders: Set<string>;
  selectedFilePath: string;
  selectedFolderPath: string | null;
  onToggleFolder: (path: string) => void;
  onSelectFile: (path: string) => void;
  onCreateEntry: (mode: 'file' | 'folder', parentPath: string) => void;
  onRenameFile: (file: GeneralSkillFile) => void;
  onRenameFolder: (path: string) => void;
  onDeleteFile: (file: GeneralSkillFile) => void;
  onDeleteFolder: (path: string) => void;
}) {
  const copy = useGeneralSkillsCopy();
  const paddingLeft = 8 + depth * 14;
  if (node.kind === 'folder') {
    const expanded = expandedFolders.has(node.path);
    return (
      <div role="treeitem" aria-expanded={expanded}>
        <ContextMenu.Root>
          <ContextMenu.Trigger asChild>
            <button
              type="button"
              className={skillFileNodeClass(node.path === selectedFolderPath)}
              style={{ paddingLeft }}
              onClick={() => onToggleFolder(node.path)}
              title={node.path}
            >
              <ChevronRight className={cn('size-[13px] shrink-0 transition-transform', expanded && 'rotate-90')} />
              <IconFolder className="size-[14px] shrink-0" />
              <span className="min-w-0 truncate">{node.name}</span>
            </button>
          </ContextMenu.Trigger>
          <ContextMenu.Portal>
            <ContextMenu.Content className={MENU_CONTENT_CLASS}>
              <ContextMenu.Item className={cn(MENU_ITEM_CLASS, 'flex items-center whitespace-nowrap')} onSelect={() => onCreateEntry('file', node.path)}>
                <FilePlus2 />
                {copy.createFile}
              </ContextMenu.Item>
              <ContextMenu.Item className={cn(MENU_ITEM_CLASS, 'flex items-center whitespace-nowrap')} onSelect={() => onCreateEntry('folder', node.path)}>
                <FolderPlus />
                {copy.createFolder}
              </ContextMenu.Item>
              <ContextMenu.Item className={cn(MENU_ITEM_CLASS, 'flex items-center whitespace-nowrap')} onSelect={() => onRenameFolder(node.path)}>
                <EditOutlined />
                {copy.renameAction}
              </ContextMenu.Item>
              <ContextMenu.Item className={cn(MENU_ITEM_DANGER_CLASS, 'flex items-center whitespace-nowrap')} onSelect={() => onDeleteFolder(node.path)}>
                <DeleteOutlined />
                {copy.deleteFileAction}
              </ContextMenu.Item>
            </ContextMenu.Content>
          </ContextMenu.Portal>
        </ContextMenu.Root>
        {expanded && (
          <div role="group">
            {node.children.map((child) => (
              <SkillFileTreeEntry
                key={`${child.kind}:${child.path}`}
                node={child}
                depth={depth + 1}
                expandedFolders={expandedFolders}
                selectedFilePath={selectedFilePath}
                selectedFolderPath={selectedFolderPath}
                onToggleFolder={onToggleFolder}
                onSelectFile={onSelectFile}
                onCreateEntry={onCreateEntry}
                onRenameFile={onRenameFile}
                onRenameFolder={onRenameFolder}
                onDeleteFile={onDeleteFile}
                onDeleteFolder={onDeleteFolder}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div role="treeitem">
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <button
            type="button"
            className={skillFileNodeClass(node.path === selectedFilePath && !selectedFolderPath)}
            style={{ paddingLeft: paddingLeft + 27 }}
            onClick={() => onSelectFile(node.path)}
            onContextMenu={() => onSelectFile(node.path)}
            title={node.path}
          >
            <IconProfileFile className="size-[14px] shrink-0" />
            <span className="min-w-0 truncate">{node.name}</span>
          </button>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className={MENU_CONTENT_CLASS}>
            <ContextMenu.Item className={cn(MENU_ITEM_CLASS, 'flex items-center whitespace-nowrap')} onSelect={() => onRenameFile(node.file)}>
              <EditOutlined />
              {copy.renameAction}
            </ContextMenu.Item>
            <ContextMenu.Item className={cn(MENU_ITEM_DANGER_CLASS, 'flex items-center whitespace-nowrap')} onSelect={() => onDeleteFile(node.file)}>
              <DeleteOutlined />
              {copy.deleteFileAction}
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
    </div>
  );
}

function packagePathFromRaw(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = normalized.split('/').filter(Boolean);
  return parts.length > 1 ? parts.slice(1).join('/') : normalized;
}

function packagePath(file: File): string {
  return packagePathFromRaw((file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name);
}

function readEntryFile(entry: SkillFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function readDirectoryEntries(entry: SkillDirectoryEntry): Promise<SkillFileSystemEntry[]> {
  const reader = entry.createReader();
  const output: SkillFileSystemEntry[] = [];

  return new Promise((resolve, reject) => {
    const readNext = () => {
      reader.readEntries((entries) => {
        if (!entries.length) {
          resolve(output);
          return;
        }
        output.push(...entries);
        readNext();
      }, reject);
    };
    readNext();
  });
}

async function collectDroppedEntryFiles(entry: SkillFileSystemEntry): Promise<DroppedSkillFile[]> {
  if (entry.isFile) {
    const file = await readEntryFile(entry as SkillFileEntry);
    return [{ file, path: packagePathFromRaw(entry.fullPath || file.name) }];
  }
  if (!entry.isDirectory) return [];
  const entries = await readDirectoryEntries(entry as SkillDirectoryEntry);
  const nested = await Promise.all(entries.map(collectDroppedEntryFiles));
  return nested.flat();
}

function dataTransferEntry(item: DataTransferItem): SkillFileSystemEntry | null {
  const getter = (item as unknown as { webkitGetAsEntry?: () => unknown }).webkitGetAsEntry;
  const entry = getter?.call(item);
  if (!entry || typeof entry !== 'object') return null;
  return entry as SkillFileSystemEntry;
}

async function droppedSkillFiles(dataTransfer: DataTransfer): Promise<DroppedSkillFile[]> {
  const entries = Array.from(dataTransfer.items || [])
    .map(dataTransferEntry)
    .filter((entry): entry is SkillFileSystemEntry => Boolean(entry));
  if (entries.length) {
    const nested = await Promise.all(entries.map(collectDroppedEntryFiles));
    return nested.flat();
  }
  return Array.from(dataTransfer.files || []).map((file) => ({ file, path: packagePath(file) }));
}

function parseMetadata(markdownText: string): Record<string, string> {
  const lines = markdownText.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return {};
  const result: Record<string, string> = {};
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === '---') break;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key && value) result[key] = value;
  }
  return result;
}

function applyMetadata(
  markdownText: string,
  setters: {
    setSkillName: (value: string) => void;
    setSkillSlug: (value: string) => void;
    setSkillDescription: (value: string) => void;
    setSkillHomepage: (value: string) => void;
  },
) {
  const metadata = parseMetadata(markdownText);
  if (metadata.name || metadata.title) setters.setSkillName(metadata.name || metadata.title);
  if (metadata.slug || metadata.id) setters.setSkillSlug(metadata.slug || metadata.id);
  if (metadata.description || metadata.summary) setters.setSkillDescription(metadata.description || metadata.summary);
  if (metadata.homepage || metadata.url) setters.setSkillHomepage(metadata.homepage || metadata.url);
}

function normalizedSkillFiles(files: GeneralSkillFile[] = []): string {
  return JSON.stringify(
    [...files]
      .map((file) => ({
        path: file.path,
        content: file.content,
        mime_type: file.mime_type || '',
      }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  );
}

function SectionCard({
  className,
  bodyClassName,
  title,
  extra,
  loading,
  children,
  ...rest
}: {
  className?: string;
  bodyClassName?: string;
  title?: ReactNode;
  extra?: ReactNode;
  loading?: boolean;
  children?: ReactNode;
} & Omit<HTMLAttributes<HTMLDivElement>, 'title'>) {
  const copy = useGeneralSkillsCopy();
  return (
    <section className={cn(SECTION_CARD_CLASS, 'overflow-hidden', className)} {...rest}>
      {(title || extra) && (
        <div className="flex min-h-[40px] items-center justify-between gap-[12px]">
          <div className={cn('min-w-0', SECTION_CARD_TITLE_CLASS)}>{title}</div>
          {extra ? <div className="shrink-0">{extra}</div> : null}
        </div>
      )}
      <div className={cn('min-h-0 flex-1', bodyClassName)}>
        {loading ? (
          <div className="py-[24px] text-center text-[13px] text-[#858b9c]">{copy.loading}</div>
        ) : (
          children
        )}
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-[6px]">
      <span className={FIELD_LABEL_CLASS}>{label}</span>
      {children}
    </div>
  );
}

/** 按租户会话代次隔离技能编辑器状态，防止草稿、文件和运行结果跨租户复用。 */
function GeneralSkillEditorPage(props: { mode: 'new' | 'edit' } & GeneralSkillPageProps) {
  const tenantContext = useTenantSession();
  const tenantScopeKey = tenantContext
    ? `${tenantContext.tenantId}:${tenantContext.userId}:${tenantContext.generation}`
    : 'no-tenant';
  return <GeneralSkillEditorPageContent key={tenantScopeKey} {...props} />;
}

function GeneralSkillEditorPageContent({ mode, currentUser, onLogout }: { mode: 'new' | 'edit' } & GeneralSkillPageProps) {
  const { t } = useAppIntl();
  const tenantContext = useTenantSession();
  const tenantClient = useMemo(() => createTenantClient(tenantContext), [tenantContext]);
  const tenantId = tenantContext?.tenantId || '';
  const userId = tenantContext?.userId || '';
  const copy = useGeneralSkillsCopy();
  const navigate = useNavigate();
  const { slug: routeSlug } = useParams();
  const [editorSearchParams] = useSearchParams();
  const forceGalleryScope = editorSearchParams.get('scope') === 'gallery';
  const [agentScopeLoaded, setAgentScopeLoaded] = useState(false);
  const [rows, setRows] = useState<GeneralSkillRead[]>([]);
  const [markdown, setMarkdown] = useState(() => defaultSkillMarkdown(t));
  const [skillName, setSkillName] = useState('');
  const [skillSlug, setSkillSlug] = useState('');
  const [skillDescription, setSkillDescription] = useState('');
  const [skillHomepage, setSkillHomepage] = useState('');
  const [capabilityScope, setCapabilityScope] = useState<CapabilityScope>('general');
  const [skillFiles, setSkillFiles] = useState<GeneralSkillFile[]>([
    { path: 'SKILL.md', content: defaultSkillMarkdown(t), size: defaultSkillMarkdown(t).length, mime_type: 'text/markdown' },
  ]);
  const [skillDirectories, setSkillDirectories] = useState<string[]>([]);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set());
  const [selectedFolderPath, setSelectedFolderPath] = useState<string | null>(null);
  const [selectedSlug, setSelectedSlug] = useState<string>();
  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [runResult, setRunResult] = useState<GeneralSkillRunResponse | null>(null);
  const [liveResult, setLiveResult] = useState<Partial<GeneralSkillRunResponse> | null>(null);
  const [resultExpanded, setResultExpanded] = useState(false);
  const [modelConfigs, setModelConfigs] = useState<ModelConfigRead[]>([]);
  const [selectedRunModelId, setSelectedRunModelId] = useState(
    () => tenantId && userId
      ? window.localStorage.getItem(tenantUserStorageKey(tenantId, userId, GENERAL_SKILL_RUN_MODEL_STORAGE_KEY)) || ''
      : '',
  );
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [selectedFilePath, setSelectedFilePath] = useState('SKILL.md');
  const [editorScroll, setEditorScroll] = useState({ top: 0, left: 0 });
  const [markdownPreviewOpen, setMarkdownPreviewOpen] = useState(false);
  const [clawhubModalOpen, setClawhubModalOpen] = useState(false);
  const [clawhubSource, setClawhubSource] = useState('');
  const [clawhubLoading, setClawhubLoading] = useState(false);
  const [agentImportOpen, setAgentImportOpen] = useState(false);
  const [agentImportMode, setAgentImportMode] = useState<GeneralSkillImportMode>('plaza');
  const [agentImportLoading, setAgentImportLoading] = useState(false);
  const [agentImportAgents, setAgentImportAgents] = useState<AgentProfileRead[]>([]);
  const [agentImportSourceAgentId, setAgentImportSourceAgentId] = useState('');
  const [agentImportSourceSkills, setAgentImportSourceSkills] = useState<GeneralSkillRead[]>([]);
  const [agentImportSelectedSkillIds, setAgentImportSelectedSkillIds] = useState<string[]>([]);
  const [agentId, setAgentId] = useState(
    () => tenantId && userId ? readEmployeeScope(tenantId, userId) : '',
  );
  const [isOverallAgent, setIsOverallAgent] = useState(true);
  const [agents, setAgents] = useState<AgentProfileRead[]>([]);
  const [deleteSkillTarget, setDeleteSkillTarget] = useState<GeneralSkillRead | null>(null);
  const [deleteFileTarget, setDeleteFileTarget] = useState<GeneralSkillFile | null>(null);
  const [deleteFolderTarget, setDeleteFolderTarget] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<GeneralSkillFile | null>(null);
  const [renameFolderTarget, setRenameFolderTarget] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [createEntryMode, setCreateEntryMode] = useState<'file' | 'folder' | null>(null);
  const [createEntryValue, setCreateEntryValue] = useState('');
  const [importPrepareOpen, setImportPrepareOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const clawhubAbortRef = useRef<AbortController | null>(null);
  const importPrepareActionRef = useRef<null | (() => void | Promise<void>)>(null);
  const knownFolderPathsRef = useRef<Set<string>>(new Set());
  const editorLoadControllerRef = useRef<AbortController | null>(null);
  const editorAgentScopeControllerRef = useRef<AbortController | null>(null);
  const editorModelControllerRef = useRef<AbortController | null>(null);
  const editorSaveControllerRef = useRef<AbortController | null>(null);
  const editorPublishControllerRef = useRef<AbortController | null>(null);
  const editorDeleteControllerRef = useRef<AbortController | null>(null);
  const editorImportAgentsControllerRef = useRef<AbortController | null>(null);
  const editorImportSourceControllerRef = useRef<AbortController | null>(null);
  const editorImportSubmitControllerRef = useRef<AbortController | null>(null);
  const editorRunControllerRef = useRef<AbortController | null>(null);

  useEffect(() => () => {
    [
      editorLoadControllerRef,
      editorAgentScopeControllerRef,
      editorModelControllerRef,
      editorSaveControllerRef,
      editorPublishControllerRef,
      editorDeleteControllerRef,
      clawhubAbortRef,
      editorImportAgentsControllerRef,
      editorImportSourceControllerRef,
      editorImportSubmitControllerRef,
      editorRunControllerRef,
    ].forEach((ref) => ref.current?.abort());
  }, [tenantContext?.tenantId, tenantContext?.generation]);

  const selectedSkill = useMemo(
    () => rows.find((row) => row.slug === selectedSlug),
    [rows, selectedSlug],
  );
  const activeResult = runResult || liveResult;
  const selectedFile = useMemo(
    () => skillFiles.find((file) => file.path === selectedFilePath) || skillFiles[0],
    [skillFiles, selectedFilePath],
  );
  const folderPaths = useMemo(
    () => skillFolderPaths(skillFiles, skillDirectories),
    [skillFiles.map((file) => file.path).join('\n'), skillDirectories.join('\n')],
  );
  const skillFileTree = useMemo(
    () => buildSkillFileTree(skillFiles, skillDirectories),
    [skillFiles, skillDirectories],
  );
  const selectedFileLanguage = useMemo(() => languageFromFilePath(selectedFile?.path), [selectedFile?.path]);
  const selectedFileCanPreview = selectedFileLanguage === 'markdown';
  const isNew = mode === 'new';
  const currentAgent = useMemo(() => agents.find((item) => item.id === agentId), [agents, agentId]);
  const canManageCurrentScope = currentAgent
    ? canManageEmployeeAgent(currentAgent, currentUser)
    : isEnterpriseAdmin(currentUser) && isOverallAgent;
  const pageTitle = isNew ? copy.newBlankTitle : copy.editTitle;
  const pageDescription = isOverallAgent
    ? (isNew ? copy.pageDescriptionOverallNew : copy.pageDescriptionOverallEdit)
    : (isNew ? copy.pageDescriptionScopedNew : copy.pageDescriptionScopedEdit);

  const load = () => {
    if (!tenantContext) return Promise.resolve();
    const context = tenantContext;
    const generation = context.generation;
    const agentSuffix = agentId ? `&agent_id=${encodeURIComponent(agentId)}` : '';
    editorLoadControllerRef.current?.abort();
    const controller = new AbortController();
    editorLoadControllerRef.current = controller;
    return tenantClient
      .get<GeneralSkillRead[]>(`/api/enterprise/general-skills?tenant_id=${tenantId}${agentSuffix}`, {
        signal: controller.signal,
      })
      .then((items) => {
        if (!isCurrentTenantRequest(context, generation, controller)) return;
        setRows(items);
        if (mode === 'edit') {
          const target = items.find((item) => item.slug === routeSlug);
          if (target) {
            editSkill(target);
          } else if (routeSlug) {
            notify.error(copy.editTargetMissing);
          }
        }
      })
      .catch((error) => {
        if (isCurrentTenantRequest(context, generation, controller)) {
          notify.error(generalSkillsPageErrorMessage(error, copy.loadFailed, t));
        }
      })
      .finally(() => {
        if (editorLoadControllerRef.current === controller) editorLoadControllerRef.current = null;
      });
  };

  useEffect(() => {
    if (mode === 'new') newSkill();
  }, [mode]);

  useEffect(() => {
    if (!tenantContext || mode === 'new' || (forceGalleryScope && !agentScopeLoaded)) return;
    void load();
  }, [agentId, mode, routeSlug, forceGalleryScope, agentScopeLoaded, tenantContext, tenantClient, tenantId]);

  useEffect(() => {
    if (!tenantContext) return;
    const context = tenantContext;
    const generation = context.generation;
    editorAgentScopeControllerRef.current?.abort();
    const controller = new AbortController();
    editorAgentScopeControllerRef.current = controller;
    tenantClient
      .get<AgentProfileRead[]>(`/api/enterprise/agents?tenant_id=${tenantId}`, { signal: controller.signal })
      .then((items) => {
        if (!isCurrentTenantRequest(context, generation, controller)) return;
        setAgents(items);
        const scopedAgent = forceGalleryScope
          ? items.find((item) => item.is_overall)
          : items.find((item) => item.id === agentId);
        if (scopedAgent && scopedAgent.id !== agentId) {
          persistSharedAgentScope(scopedAgent.id, tenantId, userId);
          setAgentId(scopedAgent.id);
        }
        setIsOverallAgent(Boolean(scopedAgent?.is_overall ?? true));
        setAgentScopeLoaded(true);
      })
      .catch(() => {
        if (!isCurrentTenantRequest(context, generation, controller)) return;
        setIsOverallAgent(true);
        setAgentScopeLoaded(true);
      })
      .finally(() => {
        if (editorAgentScopeControllerRef.current === controller) editorAgentScopeControllerRef.current = null;
      });
    return () => controller.abort();
  }, [agentId, forceGalleryScope, tenantClient, tenantContext, tenantId, userId]);

  useEffect(() => {
    if (!tenantContext) return;
    const context = tenantContext;
    const generation = context.generation;
    editorModelControllerRef.current?.abort();
    const controller = new AbortController();
    editorModelControllerRef.current = controller;
    tenantClient
      .get<ModelConfigRead[]>(`/api/enterprise/model-configs?tenant_id=${tenantId}`, { signal: controller.signal })
      .then((items) => {
        if (!isCurrentTenantRequest(context, generation, controller)) return;
        const enabled = items.filter((item) => item.enabled);
        setModelConfigs(enabled);
        setSelectedRunModelId((current) => {
          if (current && enabled.some((item) => item.id === current)) return current;
          const fallback = enabled.find((item) => item.is_default)?.id || enabled[0]?.id || '';
          if (fallback) {
            window.localStorage.setItem(
              tenantUserStorageKey(tenantId, userId, GENERAL_SKILL_RUN_MODEL_STORAGE_KEY),
              fallback,
            );
          }
          return fallback;
        });
      })
      .catch(() => {
        if (isCurrentTenantRequest(context, generation, controller)) setModelConfigs([]);
      })
      .finally(() => {
        if (editorModelControllerRef.current === controller) editorModelControllerRef.current = null;
      });
  }, [tenantClient, tenantContext, tenantId, userId]);

  useEffect(() => {
    const onScopeChange = (event: Event) => {
      if (forceGalleryScope) return;
      const next = (event as CustomEvent<{ agentId?: string }>).detail?.agentId || '';
      setAgentId(next && !isTeamScope(next) ? next : readEmployeeScope(tenantId, userId));
    };
    window.addEventListener('ultrarag-enterprise-agent-scope-change', onScopeChange);
    return () => window.removeEventListener('ultrarag-enterprise-agent-scope-change', onScopeChange);
  }, [forceGalleryScope, tenantId, userId]);

  useEffect(() => {
    folderInputRef.current?.setAttribute('webkitdirectory', '');
    folderInputRef.current?.setAttribute('directory', '');
  }, []);

  useEffect(() => {
    if (!skillFiles.length) return;
    if (!skillFiles.some((file) => file.path === selectedFilePath)) {
      const skillFile = skillFiles.find((file) => file.path.split('/').pop()?.toLowerCase() === 'skill.md');
      setSelectedFilePath(skillFile?.path || skillFiles[0].path);
    }
  }, [skillFiles, selectedFilePath]);

  useEffect(() => {
    const currentFolderPaths = new Set(folderPaths);
    const previousFolderPaths = knownFolderPathsRef.current;
    setExpandedFolders((current) => {
      const next = new Set(Array.from(current).filter((path) => currentFolderPaths.has(path)));
      folderPaths.forEach((path) => {
        if (!previousFolderPaths.has(path)) next.add(path);
      });
      return next;
    });
    knownFolderPathsRef.current = currentFolderPaths;
  }, [folderPaths.join('\n')]);

  useEffect(() => {
    if (selectedFolderPath && !folderPaths.includes(selectedFolderPath)) {
      setSelectedFolderPath(null);
    }
  }, [folderPaths.join('\n'), selectedFolderPath]);

  useEffect(() => {
    setEditorScroll({ top: 0, left: 0 });
  }, [selectedFilePath]);

  useEffect(() => {
    if (!selectedFileCanPreview) {
      setMarkdownPreviewOpen(false);
    }
  }, [selectedFileCanPreview]);

  function hasUnsavedEditingChanges(): boolean {
    if (!editingSlug) return false;
    const original = rows.find((row) => row.slug === editingSlug);
    if (!original) return false;
    const stableSlug = editingSlug || skillSlug;
    return (
      markdown !== original.skill_markdown
      || skillName !== original.name
      || stableSlug !== original.slug
      || skillDescription !== (original.description || '')
      || skillHomepage !== (original.homepage || '')
      || capabilityScope !== normalizeCapabilityScope(original.capability_scope)
      || normalizedSkillFiles(skillFiles) !== normalizedSkillFiles(
        original.skill_files?.length ? original.skill_files : [{ path: 'SKILL.md', content: original.skill_markdown }],
      )
      || [...skillDirectories].sort().join('\n') !== [...(original.skill_directories || [])].sort().join('\n')
    );
  }

  async function importSkill(): Promise<GeneralSkillRead | null> {
    if (!canManageCurrentScope) {
      notify.error(copy.adminOnlyEdit);
      return null;
    }
    if (!markdown.trim()) {
      notify.warning(copy.missingSkillMarkdown);
      return null;
    }
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return null;
    editorSaveControllerRef.current?.abort();
    const controller = new AbortController();
    editorSaveControllerRef.current = controller;
    setSaving(true);
    try {
      const row = await tenantClient.post<GeneralSkillRead>('/api/enterprise/general-skills/import', {
        tenant_id: tenantId,
        agent_id: !isOverallAgent && agentId ? agentId : undefined,
        name: skillName.trim() || undefined,
        slug: editingSlug || skillSlug.trim() || undefined,
        description: skillDescription.trim() || undefined,
        homepage: skillHomepage.trim() || undefined,
        capability_scope: capabilityScope,
        markdown,
        files: skillFiles.length ? skillFiles : [{ path: 'SKILL.md', content: markdown }],
        directories: skillDirectories,
        status: 'published',
        original_slug: editingSlug || undefined,
      }, { signal: controller.signal });
      if (!isCurrentTenantRequest(context, generation, controller)) return null;
      notify.success(interpolate(editingSlug ? copy.saveUpdated : copy.saveCreated, { name: row.name }));
      setSelectedSlug(row.slug);
      setEditingSlug(row.slug);
      setMarkdown(row.skill_markdown);
      setSkillName(row.name);
      setSkillSlug(row.slug);
      setSkillDescription(row.description || '');
      setSkillHomepage(row.homepage || '');
      setCapabilityScope(normalizeCapabilityScope(row.capability_scope));
      setSkillFiles(row.skill_files?.length ? row.skill_files : [{ path: 'SKILL.md', content: row.skill_markdown }]);
      setSkillDirectories(row.skill_directories || []);
      setSelectedFilePath((row.skill_files?.length ? row.skill_files : [{ path: 'SKILL.md' }])[0].path);
      setSelectedFolderPath(null);
      setRows((current) => {
        const withoutSaved = current.filter((item) => item.id !== row.id && item.slug !== row.slug);
        return [row, ...withoutSaved];
      });
      const scopeQuery = row.metadata?.scope === 'open_gallery' ? '?scope=gallery' : '';
      navigate(`/enterprise/general-skills/${encodeURIComponent(row.slug)}/edit${scopeQuery}`, { replace: !editingSlug });
      return row;
    } catch (error) {
      if (isCurrentTenantRequest(context, generation, controller)) {
        notify.error(generalSkillsPageErrorMessage(error, copy.saveFailed, t));
      }
      return null;
    } finally {
      if (editorSaveControllerRef.current === controller) editorSaveControllerRef.current = null;
      if (isCurrentTenantRequest(context, generation, controller)) setSaving(false);
    }
  }

  function newSkill() {
    const nextMarkdown = defaultSkillMarkdown(t);
    setMarkdown(nextMarkdown);
    setSkillName('');
    setSkillSlug('');
    setSkillDescription('');
    setSkillHomepage('');
    setCapabilityScope('general');
    setSkillFiles([{ path: 'SKILL.md', content: nextMarkdown, size: nextMarkdown.length, mime_type: 'text/markdown' }]);
    setSkillDirectories([]);
    setSelectedFilePath('SKILL.md');
    setSelectedFolderPath(null);
    setEditingSlug(null);
    setSelectedSlug(undefined);
    setQuery('');
    setRunResult(null);
    setLiveResult(null);
    setResultExpanded(false);
    setMarkdownPreviewOpen(false);
  }

  function editSkill(row: GeneralSkillRead) {
    setMarkdown(row.skill_markdown);
    setSkillName(row.name);
    setSkillSlug(row.slug);
    setSkillDescription(row.description || '');
    setSkillHomepage(row.homepage || '');
    setCapabilityScope(normalizeCapabilityScope(row.capability_scope));
    setSkillFiles(row.skill_files?.length ? row.skill_files : [{ path: 'SKILL.md', content: row.skill_markdown }]);
    setSkillDirectories(row.skill_directories || []);
    setSelectedFilePath((row.skill_files?.length ? row.skill_files : [{ path: 'SKILL.md' }])[0].path);
    setSelectedFolderPath(null);
    setSelectedSlug(row.slug);
    setEditingSlug(row.slug);
    setRunResult(null);
    setLiveResult(null);
    setResultExpanded(false);
    setMarkdownPreviewOpen(false);
  }

  function replaceRow(row: GeneralSkillRead) {
    setRows((current) => current.map((item) => (item.id === row.id ? row : item)));
    if (editingSlug === row.slug) {
      setSkillName(row.name);
      setSkillSlug(row.slug);
      setSkillDescription(row.description || '');
      setSkillHomepage(row.homepage || '');
      setCapabilityScope(normalizeCapabilityScope(row.capability_scope));
      setMarkdown(row.skill_markdown);
      setSkillFiles(row.skill_files?.length ? row.skill_files : [{ path: 'SKILL.md', content: row.skill_markdown }]);
      setSkillDirectories(row.skill_directories || []);
      setSelectedFilePath((row.skill_files?.length ? row.skill_files : [{ path: 'SKILL.md' }])[0].path);
      setSelectedFolderPath(null);
    }
  }

  async function setSkillPublished(row: GeneralSkillRead, published: boolean) {
    if (!canManageCurrentScope) {
      notify.error(copy.adminOnlyEdit);
      return;
    }
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return;
    editorPublishControllerRef.current?.abort();
    const controller = new AbortController();
    editorPublishControllerRef.current = controller;
    try {
      const agentSuffix = agentId ? `&agent_id=${encodeURIComponent(agentId)}` : '';
      const next = await tenantClient.post<GeneralSkillRead>(
        `/api/enterprise/general-skills/${row.slug}/${published ? 'publish' : 'archive'}?tenant_id=${tenantId}${agentSuffix}`,
        undefined,
        { signal: controller.signal },
      );
      if (!isCurrentTenantRequest(context, generation, controller)) return;
      replaceRow(next);
      notify.success(published ? copy.enabledSuccess : copy.archivedSuccess);
    } catch (error) {
      if (isCurrentTenantRequest(context, generation, controller)) {
        notify.error(generalSkillsPageErrorMessage(error, published ? copy.enableFailed : copy.archiveFailed, t));
      }
    } finally {
      if (editorPublishControllerRef.current === controller) editorPublishControllerRef.current = null;
    }
  }

  async function runDeleteSkill() {
    const row = deleteSkillTarget;
    if (!row) return;
    if (!canManageCurrentScope) {
      notify.error(copy.adminOnlyEdit);
      return;
    }
    const branchMode = !isOverallAgent;
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return;
    editorDeleteControllerRef.current?.abort();
    const controller = new AbortController();
    editorDeleteControllerRef.current = controller;
    try {
      const agentSuffix = agentId ? `&agent_id=${encodeURIComponent(agentId)}` : '';
      await tenantClient.delete(
        `/api/enterprise/general-skills/${row.slug}?tenant_id=${tenantId}${agentSuffix}`,
        undefined,
        { signal: controller.signal },
      );
      if (!isCurrentTenantRequest(context, generation, controller)) return;
      const nextRows = rows.filter((item) => item.id !== row.id);
      setRows(nextRows);
      if (selectedSlug === row.slug || editingSlug === row.slug) {
        const next = nextRows[0];
        if (next) {
          setSelectedSlug(next.slug);
          editSkill(next);
        } else {
          setSelectedSlug(undefined);
          newSkill();
        }
      }
      notify.success(branchMode ? copy.removedSuccess : copy.deletedSuccess);
    } catch (error) {
      if (isCurrentTenantRequest(context, generation, controller)) {
        notify.error(generalSkillsPageErrorMessage(error, branchMode ? copy.removeFailed : copy.deleteSkillFailed, t));
      }
    } finally {
      if (editorDeleteControllerRef.current === controller) editorDeleteControllerRef.current = null;
      if (isCurrentTenantRequest(context, generation, controller)) setDeleteSkillTarget(null);
    }
  }

  function startImportedDraft() {
    setEditingSlug(null);
    setSelectedSlug(undefined);
    setRunResult(null);
    setLiveResult(null);
    setResultExpanded(false);
    setMarkdownPreviewOpen(false);
  }

  async function withImportPreparation(importAction: () => void | Promise<void>) {
    if (!hasUnsavedEditingChanges()) {
      await importAction();
      return;
    }
    importPrepareActionRef.current = importAction;
    setImportPrepareOpen(true);
  }

  async function confirmImportPrepareSave() {
    const action = importPrepareActionRef.current;
    setImportPrepareOpen(false);
    const saved = await importSkill();
    if (saved && action) await action();
    importPrepareActionRef.current = null;
  }

  async function confirmImportPrepareSkip() {
    const action = importPrepareActionRef.current;
    setImportPrepareOpen(false);
    importPrepareActionRef.current = null;
    if (action) await action();
  }

  function requestImport(kind: 'file' | 'folder') {
    void withImportPreparation(() => {
      if (kind === 'folder') {
        folderInputRef.current?.click();
        return;
      }
      fileInputRef.current?.click();
    });
  }

  function requestClawHubImport() {
    void withImportPreparation(() => {
      clawhubAbortRef.current?.abort();
      clawhubAbortRef.current = null;
      setClawhubLoading(false);
      setClawhubSource('');
      setClawhubModalOpen(true);
    });
  }

  function cancelClawHubImport() {
    clawhubAbortRef.current?.abort();
    clawhubAbortRef.current = null;
    setClawhubLoading(false);
    setClawhubModalOpen(false);
  }

  function requestAgentImport(mode: GeneralSkillImportMode) {
    void withImportPreparation(async () => {
      const context = tenantContext;
      const generation = context?.generation;
      if (!context || generation === undefined) return;
      editorImportAgentsControllerRef.current?.abort();
      const controller = new AbortController();
      editorImportAgentsControllerRef.current = controller;
      try {
        const agents = await tenantClient.get<AgentProfileRead[]>(`/api/enterprise/agents?tenant_id=${tenantId}`, {
          signal: controller.signal,
        });
        if (!isCurrentTenantRequest(context, generation, controller)) return;
        const firstSource = mode === 'plaza'
          ? openGalleryAgentId(agents)
          : visibleEmployeeAgents(agents, currentUser, { activeOnly: true, excludeAgentId: agentId })[0]?.id || '';
        setAgentImportMode(mode);
        setAgentImportAgents(agents);
        setAgentImportSourceAgentId(firstSource);
        setAgentImportSelectedSkillIds([]);
        setAgentImportOpen(true);
        if (firstSource) {
          await loadAgentImportSourceSkills(firstSource);
          if (!isCurrentTenantRequest(context, generation, controller)) return;
        } else {
          setAgentImportSourceSkills([]);
        }
      } catch (error) {
        if (isCurrentTenantRequest(context, generation, controller)) {
          notify.error(generalSkillsPageErrorMessage(error, copy.loadAgentsFailed, t));
        }
      } finally {
        if (editorImportAgentsControllerRef.current === controller) editorImportAgentsControllerRef.current = null;
      }
    });
  }

  async function loadAgentImportSourceSkills(sourceAgentId: string) {
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return [];
    editorImportSourceControllerRef.current?.abort();
    const controller = new AbortController();
    editorImportSourceControllerRef.current = controller;
    setAgentImportSourceSkills([]);
    setAgentImportSelectedSkillIds([]);
    if (!sourceAgentId) {
      editorImportSourceControllerRef.current = null;
      return [];
    }
    try {
      const sourceRows = await tenantClient.get<GeneralSkillRead[]>(
        `/api/enterprise/general-skills?tenant_id=${tenantId}&agent_id=${encodeURIComponent(sourceAgentId)}`,
        { signal: controller.signal },
      );
      if (!isCurrentTenantRequest(context, generation, controller)) return [];
      const existingIds = new Set(rows.map((item) => item.id));
      const publishedRows = sourceRows.filter((item) => item.status === 'published' && !existingIds.has(item.id));
      setAgentImportSourceSkills(publishedRows);
      return publishedRows;
    } catch (error) {
      if (isCurrentTenantRequest(context, generation, controller)) {
        notify.error(generalSkillsPageErrorMessage(error, copy.loadSourceSkillsFailed, t));
      }
      return [];
    } finally {
      if (editorImportSourceControllerRef.current === controller) editorImportSourceControllerRef.current = null;
    }
  }

  async function submitAgentImportSkills() {
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return;
    if (!agentId) {
      notify.warning(copy.selectEmployeeFirst);
      return;
    }
    if (!agentImportSourceAgentId) {
      notify.warning(agentImportMode === 'plaza' ? copy.selectMarketplaceFirst : copy.selectSourceFirst);
      return;
    }
    if (!agentImportSelectedSkillIds.length) {
      notify.warning(copy.selectSkillsFirst);
      return;
    }
    editorImportSubmitControllerRef.current?.abort();
    const controller = new AbortController();
    editorImportSubmitControllerRef.current = controller;
    setAgentImportLoading(true);
    try {
      await tenantClient.post(`/api/enterprise/agents/${encodeURIComponent(agentId)}/resources/import`, {
        tenant_id: tenantId,
        source_agent_id: agentImportSourceAgentId,
        resource_type: 'general_skill',
        resource_ids: agentImportSelectedSkillIds,
      }, { signal: controller.signal });
      if (!isCurrentTenantRequest(context, generation, controller)) return;
      notify.success(interpolate(copy.copiedSkillsSuccess, { count: agentImportSelectedSkillIds.length }));
      setAgentImportOpen(false);
      await load();
    } catch (error) {
      if (isCurrentTenantRequest(context, generation, controller)) {
        notify.error(generalSkillsPageErrorMessage(error, copy.copySkillsFailed, t));
      }
    } finally {
      if (editorImportSubmitControllerRef.current === controller) editorImportSubmitControllerRef.current = null;
      if (isCurrentTenantRequest(context, generation, controller)) setAgentImportLoading(false);
    }
  }

  async function importClawHubSource() {
    if (!clawhubSource.trim()) {
      notify.warning(copy.enterOpenSourceUrl);
      return;
    }
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return;
    const controller = new AbortController();
    clawhubAbortRef.current?.abort();
    clawhubAbortRef.current = controller;
    setClawhubLoading(true);
    try {
      const row = await tenantClient.postWithSignal<GeneralSkillRead>('/api/enterprise/general-skills/import-skillhub', {
        tenant_id: tenantId,
        agent_id: !isOverallAgent && agentId ? agentId : undefined,
        source: clawhubSource.trim(),
        status: 'published',
      }, controller.signal);
      if (!isCurrentTenantRequest(context, generation, controller)) return;
      notify.success(interpolate(copy.importedOpenSourceSuccess, { name: row.name }));
      setRows((current) => [row, ...current.filter((item) => item.id !== row.id && item.slug !== row.slug)]);
      setSelectedSlug(row.slug);
      editSkill(row);
      setClawhubModalOpen(false);
      void load();
    } catch (error) {
      if (!isCurrentTenantRequest(context, generation, controller)) return;
      if (isAbortError(error)) {
        notify.info(copy.importCanceled);
        return;
      }
      notify.error(generalSkillsPageErrorMessage(error, copy.importOpenSourceFailed, t));
    } finally {
      if (clawhubAbortRef.current === controller) {
        clawhubAbortRef.current = null;
        if (isCurrentTenantRequest(context, generation, controller)) setClawhubLoading(false);
      }
    }
  }

  async function importSkillPackageFile(file: File) {
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return;
    const controller = new AbortController();
    clawhubAbortRef.current?.abort();
    clawhubAbortRef.current = controller;
    setClawhubLoading(true);
    try {
      const contentBase64 = await fileToBase64(file);
      if (!isCurrentTenantRequest(context, generation, controller)) return;
      const row = await tenantClient.postWithSignal<GeneralSkillRead>('/api/enterprise/general-skills/import-package', {
        tenant_id: tenantId,
        agent_id: !isOverallAgent && agentId ? agentId : undefined,
        filename: file.name,
        content_base64: contentBase64,
        status: 'published',
      }, controller.signal);
      if (!isCurrentTenantRequest(context, generation, controller)) return;
      notify.success(interpolate(copy.uploadPackageSuccess, { name: row.name }));
      setRows((current) => [row, ...current.filter((item) => item.id !== row.id && item.slug !== row.slug)]);
      setSelectedSlug(row.slug);
      editSkill(row);
      setClawhubModalOpen(false);
      void load();
    } catch (error) {
      if (!isCurrentTenantRequest(context, generation, controller)) return;
      if (isAbortError(error)) {
        notify.info(copy.importCanceled);
        return;
      }
      notify.error(generalSkillsPageErrorMessage(error, copy.uploadPackageFailed, t));
    } finally {
      if (clawhubAbortRef.current === controller) {
        clawhubAbortRef.current = null;
        if (isCurrentTenantRequest(context, generation, controller)) setClawhubLoading(false);
      }
    }
  }

  function updateSelectedFile(text: string) {
    if (!selectedFile) return;
    setSkillFiles((current) => current.map((file) => (
      file.path === selectedFile.path
        ? { ...file, content: text, size: text.length }
        : file
    )));
    if (selectedFile.path.split('/').pop()?.toLowerCase() === 'skill.md') {
      setMarkdown(text);
    }
  }

  function parentDirectory(path: string): string {
    const parts = normalizeSkillFilePath(path).split('/');
    parts.pop();
    return parts.join('/');
  }

  function nextAvailableEntryPath(parentPath: string, mode: 'file' | 'folder'): string {
    const baseName = mode === 'file' ? 'notes.md' : copy.createFolderBaseName;
    let candidateName = baseName;
    let index = 2;
    const occupied = new Set([...skillFiles.map((file) => file.path), ...folderPaths]);
    let candidate = parentPath ? `${parentPath}/${candidateName}` : candidateName;
    while (occupied.has(candidate)) {
      candidateName = mode === 'file' ? `notes-${index}.md` : interpolate(copy.createFolderIndexedName, { count: index });
      candidate = parentPath ? `${parentPath}/${candidateName}` : candidateName;
      index += 1;
    }
    return candidate;
  }

  function openCreateEntry(mode: 'file' | 'folder', parentPath?: string) {
    const resolvedParent = parentPath ?? selectedFolderPath ?? parentDirectory(selectedFilePath);
    setCreateEntryMode(mode);
    setCreateEntryValue(nextAvailableEntryPath(resolvedParent, mode));
  }

  function pathHasFileAncestor(path: string, ignoredFilePath?: string): boolean {
    const parts = path.split('/');
    return parts.slice(0, -1).some((_, index) => {
      const parent = parts.slice(0, index + 1).join('/');
      return parent !== ignoredFilePath && skillFiles.some((file) => file.path === parent);
    });
  }

  function runCreateEntry() {
    const mode = createEntryMode;
    if (!mode) return;
    const normalized = normalizeSkillFilePath(createEntryValue);
    if (!isValidSkillFilePath(normalized)) {
      notify.error(mode === 'file' ? copy.invalidFileName : copy.invalidFolderName);
      return;
    }
    if (pathHasFileAncestor(normalized)) {
      notify.error(copy.duplicateAncestorFile);
      return;
    }
    if (skillFiles.some((file) => file.path === normalized) || folderPaths.includes(normalized)) {
      notify.error(copy.duplicateFileOrFolder);
      return;
    }
    if (mode === 'folder') {
      setSkillDirectories((current) => [...current, normalized]);
      setSelectedFolderPath(normalized);
      setExpandedFolders((current) => new Set(current).add(normalized));
    } else {
      setSkillFiles((current) => [
        ...current,
        { path: normalized, content: '', size: 0, mime_type: mimeTypeFromSkillFilePath(normalized) },
      ]);
      setSelectedFilePath(normalized);
      setSelectedFolderPath(null);
    }
    setCreateEntryMode(null);
  }

  function deleteSelectedEntry() {
    if (selectedFolderPath) {
      deleteSkillFolder(selectedFolderPath);
      return;
    }
    if (selectedFile) deleteSkillFile(selectedFile);
  }

  function deleteSkillFile(target: GeneralSkillFile) {
    if (target.path.split('/').pop()?.toLowerCase() === 'skill.md') {
      notify.warning(copy.skillEntryProtectedDelete);
      return;
    }
    setDeleteFileTarget(target);
  }

  function runDeleteFile() {
    const target = deleteFileTarget;
    if (!target) return;
    setSkillFiles((current) => current.filter((file) => file.path !== target.path));
    setDeleteFileTarget(null);
  }

  function deleteSkillFolder(path: string) {
    const prefix = `${path}/`;
    if (skillFiles.some((file) => file.path.startsWith(prefix) && file.path.split('/').pop()?.toLowerCase() === 'skill.md')) {
      notify.warning(copy.protectedFolderDelete);
      return;
    }
    setDeleteFolderTarget(path);
  }

  function runDeleteFolder() {
    const target = deleteFolderTarget;
    if (!target) return;
    const prefix = `${target}/`;
    setSkillFiles((current) => current.filter((file) => !file.path.startsWith(prefix)));
    setSkillDirectories((current) => current.filter((path) => path !== target && !path.startsWith(prefix)));
    setExpandedFolders((current) => new Set(Array.from(current).filter((path) => path !== target && !path.startsWith(prefix))));
    setSelectedFolderPath(null);
    setDeleteFolderTarget(null);
  }

  function renameSkillFile(target: GeneralSkillFile) {
    if (target.path.split('/').pop()?.toLowerCase() === 'skill.md') {
      notify.warning(copy.skillEntryProtectedRename);
      return;
    }
    setRenameTarget(target);
    setRenameFolderTarget(null);
    setRenameValue(target.path);
  }

  function renameSkillFolder(path: string) {
    setRenameTarget(null);
    setRenameFolderTarget(path);
    setRenameValue(path);
  }

  function runRenameFile() {
    const target = renameTarget;
    if (!target) return;
    {
      const nextPath = renameValue;
      {
        const normalized = normalizeSkillFilePath(nextPath);
        if (!isValidSkillFilePath(normalized)) {
          notify.error(copy.invalidFileName);
          return;
        }
        if (normalized === target.path) {
          setRenameTarget(null);
          return;
        }
        if (skillFiles.some((file) => file.path === normalized) || folderPaths.includes(normalized)) {
          notify.error(copy.duplicateFileOrFolder);
          return;
        }
        if (pathHasFileAncestor(normalized, target.path)) {
          notify.error(copy.duplicateAncestorFile);
          return;
        }
        setSkillFiles((current) => current.map((file) => (
          file.path === target.path
            ? { ...file, path: normalized }
            : file
        )));
        if (selectedFilePath === target.path) {
          setSelectedFilePath(normalized);
        }
        setRenameTarget(null);
      }
    }
  }

  function runRenameFolder() {
    const target = renameFolderTarget;
    if (!target) return;
    const normalized = normalizeSkillFilePath(renameValue);
    if (!isValidSkillFilePath(normalized)) {
      notify.error(copy.invalidFolderName);
      return;
    }
    if (normalized === target) {
      setRenameFolderTarget(null);
      return;
    }
    if (normalized.startsWith(`${target}/`)) {
      notify.error(copy.folderInsideSelf);
      return;
    }
    if (
      skillFiles.some((file) => file.path === normalized)
      || folderPaths.some((path) => path === normalized && path !== target)
      || pathHasFileAncestor(normalized)
    ) {
      notify.error(copy.duplicateRenameTarget);
      return;
    }
    const prefix = `${target}/`;
    const replacePrefix = (path: string) => (
      path === target ? normalized : path.startsWith(prefix) ? `${normalized}/${path.slice(prefix.length)}` : path
    );
    setSkillFiles((current) => current.map((file) => ({ ...file, path: replacePrefix(file.path) })));
    setSkillDirectories((current) => Array.from(new Set([
      ...current.map(replacePrefix),
      normalized,
    ])));
    setExpandedFolders((current) => new Set(Array.from(current).map(replacePrefix)));
    if (selectedFilePath.startsWith(prefix)) setSelectedFilePath(replacePrefix(selectedFilePath));
    setSelectedFolderPath(normalized);
    setRenameFolderTarget(null);
  }

  async function runSkill() {
    const slug = selectedSkill?.slug;
    if (!slug) {
      notify.warning(copy.importFirst);
      return;
    }
    if (!query.trim()) {
      notify.warning(copy.enterTestQuery);
      return;
    }
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return;
    editorRunControllerRef.current?.abort();
    const controller = new AbortController();
    editorRunControllerRef.current = controller;
    const isCurrentGeneration = () => (
      !context.signal.aborted && context.isCurrentGeneration(generation)
    );
    const isCurrentRequest = () => isCurrentTenantRequest(context, generation, controller);
    setResultExpanded(true);
    setLoading(true);
    setRunResult(null);
    setLiveResult({
      skill_slug: slug,
      execution_trace: [],
      generated_code: '',
      stdout: '',
      stderr: '',
      structured_result: {},
      reply: '',
    });
    let timedOut = false;
    let debugSessionId = '';
    let debugTurnId = '';
    const receivedTrace: Record<string, unknown>[] = [];
    let timeoutId = 0;
    const resetIdleTimeout = () => {
      if (!isCurrentRequest()) return;
      window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(() => {
        if (!isCurrentGeneration()) return;
        timedOut = true;
        if (debugSessionId && debugTurnId) {
          void tenantClient.post(`/api/chat/sessions/${debugSessionId}/cancel`, {
            tenant_id: tenantId,
            turn_id: debugTurnId,
          }, { signal: controller.signal }).catch(() => undefined);
        }
        controller.abort();
      }, GENERAL_SKILL_RUN_IDLE_TIMEOUT_MS);
    };
    resetIdleTimeout();
    try {
      let completed = false;
      await streamTenantPost(
        context,
        `/api/enterprise/general-skills/${slug}/run/stream`,
        {
          tenant_id: tenantId,
          agent_id: agentId || undefined,
          user_id: userId,
          query,
          model_config_id: selectedRunModelId || undefined,
          max_attempts: 10,
        },
        (item) => {
          if (!isCurrentRequest()) return;
          resetIdleTimeout();
          if (item.event === 'stream_started') {
            debugSessionId = typeof item.data.session_id === 'string' ? item.data.session_id : '';
            debugTurnId = typeof item.data.client_turn_id === 'string' ? item.data.client_turn_id : '';
          }
          if (item.event === 'trace') {
            const traceItem = item.data;
            receivedTrace.push(traceItem);
            setLiveResult((current) => {
              const previous = current || { skill_slug: slug, execution_trace: [] };
              const executionTrace = [...(previous.execution_trace || []), traceItem];
              const nextCode = typeof traceItem.code === 'string' && traceItem.code.trim()
                ? traceItem.code
                : previous.generated_code || '';
              const nextStructured = typeof traceItem.structured_result === 'object' && traceItem.structured_result
                ? traceItem.structured_result as Record<string, unknown>
                : previous.structured_result || {};
              const chunk = typeof traceItem.text === 'string' ? traceItem.text : '';
              const phase = typeof traceItem.phase === 'string' ? traceItem.phase : '';
              return {
                ...previous,
                execution_trace: executionTrace,
                generated_code: nextCode,
                stdout: phase === 'stdout_chunk'
                  ? `${previous.stdout || ''}${chunk}`
                  : typeof traceItem.stdout_preview === 'string' ? traceItem.stdout_preview : previous.stdout || '',
                stderr: phase === 'stderr_chunk'
                  ? `${previous.stderr || ''}${chunk}`
                  : typeof traceItem.stderr_preview === 'string' ? traceItem.stderr_preview : previous.stderr || '',
                structured_result: nextStructured,
              };
            });
          }
          if (item.event === 'complete') {
            const result = item.data as unknown as GeneralSkillRunResponse;
            completed = true;
            setRunResult({
              ...result,
              execution_trace: result.execution_trace?.length
                ? result.execution_trace
                : receivedTrace,
            });
            setLiveResult(null);
            notify.success(copy.runComplete);
          }
          if (item.event === 'error') {
            const text = generalSkillsPageErrorMessage(item.data, copy.runFailed, t);
            completed = true;
            setLiveResult((current) => ({
              ...(current || { skill_slug: slug, execution_trace: [] }),
              stderr: text,
              structured_result: { success: false, error: text },
              reply: copy.runFailed,
            }));
            notify.error(text);
          }
        },
        controller.signal,
      );
      if (!completed && isCurrentRequest()) {
        notify.warning(copy.runStreamEnded);
      }
    } catch (error) {
      if (!isCurrentGeneration() || controller.signal.aborted) return;
      const text = timedOut
        ? copy.runTimedOut
        : generalSkillsPageErrorMessage(error, copy.runFailed, t);
      if (isCurrentRequest()) {
        setLiveResult((current) => ({
          ...(current || { skill_slug: slug, execution_trace: [] }),
          stderr: text,
          structured_result: { success: false, error: text },
          reply: copy.runFailed,
        }));
        notify.error(text);
      }
    } finally {
      window.clearTimeout(timeoutId);
      if (editorRunControllerRef.current === controller) {
        editorRunControllerRef.current = null;
        if (isCurrentGeneration()) setLoading(false);
      }
    }
  }

  async function importSingleFile(target: File) {
    const text = await target.text();
    const nextFile = { path: 'SKILL.md', content: text, size: target.size, mime_type: target.type || 'text/markdown' };
    startImportedDraft();
    setSkillFiles([nextFile]);
    setSkillDirectories([]);
    setSelectedFilePath('SKILL.md');
    setSelectedFolderPath(null);
    setMarkdown(text);
    setMarkdownPreviewOpen(false);
    applyMetadata(text, { setSkillName, setSkillSlug, setSkillDescription, setSkillHomepage });
    notify.success(interpolate(copy.importedSingleFile, { name: target.name }));
  }

  async function importSkillPackage(targets: DroppedSkillFile[]) {
    if (!targets.length) return;
    const nextFiles: GeneralSkillFile[] = [];
    let failedCount = 0;
    for (const { file, path } of targets) {
      try {
        const text = await file.text();
        nextFiles.push({
          path,
          content: text,
          size: file.size,
          mime_type: file.type || undefined,
        });
      } catch {
        failedCount += 1;
      }
    }
    if (!nextFiles.length) {
      notify.error(copy.importedNoFiles);
      return;
    }
    nextFiles.sort((a, b) => a.path.localeCompare(b.path));
    startImportedDraft();
    setSkillFiles(nextFiles);
    setSkillDirectories([]);
    setMarkdownPreviewOpen(false);
    const skillFile = nextFiles.find((item) => item.path.split('/').pop()?.toLowerCase() === 'skill.md');
    if (skillFile) {
      setMarkdown(skillFile.content);
      setSelectedFilePath(skillFile.path);
      setSelectedFolderPath(null);
      applyMetadata(skillFile.content, { setSkillName, setSkillSlug, setSkillDescription, setSkillHomepage });
      notify.success(interpolate(copy.importedFiles, {
        count: nextFiles.length,
        skipped: failedCount ? interpolate(copy.importedFilesSkipped, { count: failedCount }) : '',
      }));
    } else {
      setSelectedFilePath(nextFiles[0]?.path || 'SKILL.md');
      setSelectedFolderPath(null);
      notify.warning(copy.missingSkillFile);
    }
  }

  async function importFolderFiles(fileList: FileList | null) {
    await importSkillPackage(Array.from(fileList || []).map((file) => ({ file, path: packagePath(file) })));
  }

  async function handleFileInputChange(event: ChangeEvent<HTMLInputElement>) {
    const target = event.target.files?.[0];
    if (target) {
      if (isSkillPackageArchive(target)) {
        await importSkillPackageFile(target);
      } else {
        await importSingleFile(target);
      }
    }
    event.target.value = '';
  }

  async function handleFolderInputChange(event: ChangeEvent<HTMLInputElement>) {
    await importFolderFiles(event.target.files);
    event.target.value = '';
  }

  function acceptsFileDrop(event: DragEvent<HTMLElement>): boolean {
    return Array.from(event.dataTransfer.types || []).includes('Files');
  }

  function handleDragEnter(event: DragEvent<HTMLElement>) {
    if (!acceptsFileDrop(event)) return;
    event.preventDefault();
    setDragActive(true);
  }

  function handleDragOver(event: DragEvent<HTMLElement>) {
    if (!acceptsFileDrop(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDragActive(true);
  }

  function handleDragLeave(event: DragEvent<HTMLElement>) {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    setDragActive(false);
  }

  async function handleDrop(event: DragEvent<HTMLElement>) {
    if (!acceptsFileDrop(event)) return;
    event.preventDefault();
    setDragActive(false);
    const dropped = await droppedSkillFiles(event.dataTransfer);
    if (!dropped.length) return;
    await withImportPreparation(async () => {
      if (dropped.length === 1 && !dropped[0].path.includes('/')) {
        if (isSkillPackageArchive(dropped[0].file)) {
          await importSkillPackageFile(dropped[0].file);
        } else {
          await importSingleFile(dropped[0].file);
        }
        return;
      }
      await importSkillPackage(dropped);
    });
  }

  const isLiveRunning = loading && !runResult;

  const importMenu = canManageCurrentScope ? (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <UIButton variant="outline" className={RETURN_BUTTON_CLASS}>
          <UploadOutlined className="size-[14px]!" />
          {copy.importAction}
        </UIButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className={MENU_CONTENT_CLASS}>
        <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => requestImport('file')}>{copy.chooseFile}</DropdownMenuItem>
        <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => requestImport('folder')}>{copy.chooseFolder}</DropdownMenuItem>
        {!isOverallAgent && (
          <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => requestAgentImport('plaza')}>
            <UploadOutlined />
            {copy.copyFromMarketplace}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => requestClawHubImport()}>
          <GithubOutlined />
            {copy.importFromOpenSource}
        </DropdownMenuItem>
        {!isOverallAgent && (
          <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => requestAgentImport('employee')}>
            <TeamOutlined />
            {copy.copyFromEmployee}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null;

  return (
    <div
      className="min-h-full box-border px-[48px] pt-[32px] pb-[43px] max-[900px]:px-[16px]"
      aria-busy={loading || saving}
    >
      <AppHeader
        onLogout={onLogout}
        userName={currentUser?.username}
        title={pageTitle}
        description={pageDescription}
      />

      <div className="mt-[20px] mb-[16px] flex flex-wrap justify-end gap-[16px]">
        <UIButton variant="outline" className={RETURN_BUTTON_CLASS} onClick={() => navigate('/enterprise/general-skills')}>
          <IconArrowRight className="size-3.5 rotate-180" />
          {copy.backToSkills}
        </UIButton>
        {!isNew && canManageCurrentScope && (
          <UIButton variant="outline" className={RETURN_BUTTON_CLASS} onClick={() => navigate('/enterprise/general-skills/new')}>
            <PlusOutlined />
            {copy.create}
          </UIButton>
        )}
        {importMenu}
        {canManageCurrentScope && (
          <UIButton disabled={saving} className={PRIMARY_BUTTON_CLASS} onClick={() => void importSkill()}>
            {copy.saveAction}
          </UIButton>
        )}
      </div>

      <div className="grid grid-cols-1 gap-[20px] xl:grid-cols-2 xl:items-start">
          <SectionCard title={copy.basicInfo}>
            <div className="grid grid-cols-1 gap-[16px] md:grid-cols-2">
              <Field label={copy.skillNameLabel}>
                <Input
                  value={skillName}
                  onChange={(event) => setSkillName(event.target.value)}
                  disabled={!canManageCurrentScope}
                  placeholder={copy.skillNamePlaceholder}
                />
              </Field>
              <Field label={copy.slugLabel}>
                <Input
                  value={skillSlug}
                  onChange={(event) => {
                    if (editingSlug) return;
                    setSkillSlug(event.target.value);
                  }}
                  disabled={!canManageCurrentScope || Boolean(editingSlug)}
                  placeholder={editingSlug ? copy.slugPlaceholderLocked : copy.slugPlaceholderEditable}
                />
              </Field>
              <Field label={copy.descriptionLabel}>
                <Input
                  value={skillDescription}
                  onChange={(event) => setSkillDescription(event.target.value)}
                  disabled={!canManageCurrentScope}
                  placeholder={copy.descriptionPlaceholder}
                />
              </Field>
              <Field label={copy.homepageLabel}>
                <Input
                  value={skillHomepage}
                  onChange={(event) => setSkillHomepage(event.target.value)}
                  disabled={!canManageCurrentScope}
                  placeholder={copy.homepagePlaceholder}
                />
              </Field>
              <div className="md:col-span-2">
                <CapabilityScopeControl
                  value={capabilityScope}
                  onChange={setCapabilityScope}
                  disabled={!canManageCurrentScope}
                  resourceType="skill"
                />
              </div>
            </div>
          </SectionCard>

          <SectionCard
            className="xl:col-start-2 xl:row-start-1"
            title={copy.runTestTitle}
            extra={(
              <div className="flex flex-wrap items-center justify-end gap-[8px]">
                <ModelConfigDropdown
                  models={modelConfigs}
                  value={selectedRunModelId}
                  onChange={(modelId) => {
                    setSelectedRunModelId(modelId);
                    window.localStorage.setItem(
                      tenantUserStorageKey(tenantId, userId, GENERAL_SKILL_RUN_MODEL_STORAGE_KEY),
                      modelId,
                    );
                  }}
                />
                <UIButton disabled={loading || !selectedSkill?.slug} className={PRIMARY_BUTTON_CLASS} onClick={() => void runSkill()}>
                  <ExperimentOutlined />
                  {copy.runAction}
                </UIButton>
              </div>
            )}
          >
            <div className="flex flex-col gap-[12px]">
              <Field label={copy.selectSkillLabel}>
                <UISelect value={selectedSkill?.slug} onValueChange={setSelectedSlug}>
                  <SelectTrigger className={cn(SELECT_TRIGGER_CLASS, 'w-full')}>
                    <SelectValue placeholder={isNew && !selectedSkill ? copy.selectSkillPlaceholderSaved : copy.selectSkillPlaceholder} />
                  </SelectTrigger>
                  <SelectContent>
                    {rows.map((row) => (
                      <SelectItem key={row.slug} value={row.slug}>{`${row.name} / ${row.slug}`}</SelectItem>
                    ))}
                  </SelectContent>
                </UISelect>
              </Field>
              <Field label={copy.testQuestionLabel}>
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={copy.testQuestionPlaceholder}
                />
              </Field>
            </div>
          </SectionCard>

          <SectionCard
            className={cn(
              'order-4 flex min-h-0 flex-col xl:col-span-2 xl:row-start-3',
              dragActive && SKILL_EDITOR_DRAG_ACTIVE_CLASS,
            )}
            bodyClassName="relative flex min-h-0 flex-1 flex-col p-0"
            onDragEnter={handleDragEnter}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            title={(
              <span className="flex items-center gap-[8px]">
                <IconProfileFile className="size-[14px] shrink-0 text-[#757f9c]" />
                <span>{copy.filesTitle}</span>
              </span>
            )}
          >
            <input
              ref={fileInputRef}
              className={HIDDEN_FILE_INPUT_CLASS}
              type="file"
              accept=".zip,.md,.markdown,.txt"
              onChange={handleFileInputChange}
              hidden
              aria-hidden="true"
              tabIndex={-1}
            />
            <input
              ref={folderInputRef}
              className={HIDDEN_FILE_INPUT_CLASS}
              type="file"
              multiple
              {...FOLDER_INPUT_PROPS}
              onChange={handleFolderInputChange}
              hidden
              aria-hidden="true"
              tabIndex={-1}
            />
            {dragActive && (
              <div className={SKILL_DROP_HINT_CLASS}>
                <UploadOutlined />
                <span>{copy.dropHint}</span>
              </div>
            )}
            <div className={SKILL_FILE_EDITOR_CLASS}>
              <aside className={SKILL_FILE_TREE_CLASS}>
                <div className={SKILL_FILE_TREE_HEADER_CLASS}>
                  <IconFolder className="size-[14px] shrink-0 text-[#757f9c]" />
                  <span>{copy.fileSystemTitle}</span>
                </div>
                <div className={SKILL_FILE_TREE_LIST_CLASS} role="tree" aria-label={copy.fileSystemAria}>
                  {skillFileTree.map((node) => (
                    <SkillFileTreeEntry
                      key={`${node.kind}:${node.path}`}
                      node={node}
                      depth={0}
                      expandedFolders={expandedFolders}
                      selectedFilePath={selectedFilePath}
                      selectedFolderPath={selectedFolderPath}
                      onToggleFolder={(path) => {
                        setSelectedFolderPath(path);
                        setExpandedFolders((current) => {
                          const next = new Set(current);
                          if (next.has(path)) next.delete(path);
                          else next.add(path);
                          return next;
                        });
                      }}
                      onSelectFile={(path) => {
                        setSelectedFilePath(path);
                        setSelectedFolderPath(null);
                      }}
                      onCreateEntry={openCreateEntry}
                      onRenameFile={renameSkillFile}
                      onRenameFolder={renameSkillFolder}
                      onDeleteFile={deleteSkillFile}
                      onDeleteFolder={deleteSkillFolder}
                    />
                  ))}
                </div>
                <div className={SKILL_FILE_TREE_ACTIONS_CLASS}>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <UIButton variant="outline" className={RETURN_BUTTON_CLASS}>
                        <IconAdd className="size-[14px]" />
                        {copy.createEntry}
                        <IconChevronDown className="size-[12px]" />
                      </UIButton>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className={MENU_CONTENT_CLASS}>
                      <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => openCreateEntry('file')}>
                        <FilePlus2 />
                        {copy.createFile}
                      </DropdownMenuItem>
                      <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => openCreateEntry('folder')}>
                        <FolderPlus />
                        {copy.createFolder}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <UIButton
                    variant="outline"
                    onClick={deleteSelectedEntry}
                    className={DELETE_BUTTON_CLASS}
                  >
                    <IconTrash className="size-[14px]" />
                    {copy.deleteFileAction}
                  </UIButton>
                </div>
              </aside>
              <section className={SKILL_FILE_PANE_CLASS}>
                <div className={SKILL_FILE_TAB_CLASS}>
                  <IconProfileFile className="size-[14px] shrink-0 text-[#757f9c]" />
                  <span className="min-w-0 truncate text-[#18181a]">{selectedFile?.path || copy.noSelectedFile}</span>
                  <div className="ml-auto flex items-center gap-1">
                    {selectedFileCanPreview && (
                      <button
                        type="button"
                        className={SKILL_FILE_TAB_ACTION_BUTTON_CLASS}
                        aria-label={markdownPreviewOpen ? copy.switchToEdit : copy.switchToPreview}
                        aria-pressed={markdownPreviewOpen}
                        title={markdownPreviewOpen ? copy.editMode : copy.previewMode}
                        onClick={() => setMarkdownPreviewOpen((current) => !current)}
                      >
                        {markdownPreviewOpen ? <EyeOff className="size-[14px]" /> : <Eye className="size-[14px]" />}
                        <span>{markdownPreviewOpen ? copy.editMode : copy.previewMode}</span>
                      </button>
                    )}
                  </div>
                </div>
                {selectedFileCanPreview && markdownPreviewOpen ? (
                  <div className={SKILL_MARKDOWN_PREVIEW_CLASS}>
                    <div className={SKILL_MARKDOWN_PREVIEW_BODY_CLASS}>
                      {renderMarkdownBlocks(selectedFile?.content || copy.noContent)}
                    </div>
                  </div>
                ) : (
                  <div className={SKILL_CODE_EDITOR_CLASS} data-language={selectedFileLanguage}>
                    <pre className={SKILL_CODE_HIGHLIGHT_CLASS} aria-hidden="true">
                      <code
                        className={SKILL_CODE_HIGHLIGHT_CODE_CLASS}
                        style={{
                          transform: `translate(${-editorScroll.left}px, ${-editorScroll.top}px)`,
                        }}
                      >
                        {renderCodeTokens(selectedFile?.content || '\u200b', selectedFileLanguage)}
                      </code>
                    </pre>
                    <textarea
                      className={SKILL_CODE_INPUT_CLASS}
                      value={selectedFile?.content || ''}
                      onChange={(event) => updateSelectedFile(event.target.value)}
                      onScroll={(event) => setEditorScroll({
                        top: event.currentTarget.scrollTop,
                        left: event.currentTarget.scrollLeft,
                      })}
                      spellCheck={false}
                    />
                  </div>
                )}
              </section>
            </div>
          </SectionCard>

          <SectionCard
            className="order-3 min-h-0 xl:col-span-2 xl:row-start-2"
            bodyClassName={cn('min-h-0 overflow-auto p-[18px]', !resultExpanded && 'hidden')}
            title={(
              <span className="flex items-center gap-[8px]">
                <IconPlay className="size-[14px] shrink-0 text-[#757f9c]" />
                <span>{copy.resultTitle}</span>
                {activeResult && (
                  isLiveRunning
                    ? <span className="inline-flex items-center gap-[4px] rounded-full bg-[#e6f4ff] px-[8px] py-px text-[12px] font-bold text-[#0958d9]">{copy.resultRunning}</span>
                    : resultSucceeded(activeResult)
                    ? <span className="inline-flex items-center gap-[4px] rounded-full bg-[#eafbf0] px-[8px] py-px text-[12px] font-bold text-[#018434]"><CheckCircleOutlined />{copy.resultSuccess}</span>
                    : <span className="inline-flex items-center gap-[4px] rounded-full bg-[#fce7e7] px-[8px] py-px text-[12px] font-bold text-[#d20b0b]"><CloseCircleOutlined />{copy.resultFailed}</span>
                )}
              </span>
            )}
            extra={(
              <button
                type="button"
                className="inline-flex size-[32px] items-center justify-center rounded-[6px] text-[#757f9c] transition-colors hover:bg-[#f2f3f7] hover:text-[#18181a]"
                aria-label={resultExpanded ? copy.collapseResults : copy.expandResults}
                aria-expanded={resultExpanded}
                onClick={() => setResultExpanded((current) => !current)}
              >
                <IconChevronDown
                  className={cn('size-[14px] transition-transform', resultExpanded && 'rotate-180')}
                />
              </button>
            )}
          >
            {activeResult ? (
              <div className={SKILL_RESULT_LAYOUT_CLASS}>
                {(() => {
                  const traceItems = activeResult.execution_trace || [];
                  const latestCodeIndex = traceItems.reduce(
                    (latest, traceItem, traceIndex) => (traceItemCode(traceItem) ? traceIndex : latest),
                    -1,
                  );
                  return (
                    <>
                <section className={SKILL_REPLY_PANEL_CLASS}>
                  <div className={SKILL_SECTION_LABEL_CLASS}>{copy.finalReply}</div>
                  <p className={SKILL_REPLY_TEXT_CLASS}>
                    {activeResult.reply || (loading ? copy.replyRunning : copy.replyEmpty)}
                  </p>
                </section>

                <section>
                  <div className={SKILL_SECTION_LABEL_CLASS}>{copy.executionTrace}</div>
                  <div className={SKILL_TRACE_LIST_CLASS}>
                    {traceItems.map((item, index) => {
                      const phase = typeof item.phase === 'string' ? item.phase : '';
                      const detail = traceDetail(item);
                      const code = traceItemCode(item);
                      const codeTitle = typeof item.attempt === 'number'
                        ? interpolate(copy.runnerAttempt, { count: item.attempt })
                        : copy.runnerTitle;
                      return (
                        <div className={SKILL_TRACE_ITEM_CLASS} key={`${phase || 'phase'}-${index}`}>
                          <div className={SKILL_TRACE_DOT_CLASS} />
                          <div className={SKILL_TRACE_ITEM_BODY_CLASS}>
                            <div className={SKILL_TRACE_TITLE_CLASS}>{generalSkillPhaseLabel(phase, t, copy.phaseFallback)}</div>
                            <div className={SKILL_TRACE_MESSAGE_CLASS}>{String(item.message || '')}</div>
                            {detail && (
                              <RunCodePanel
                                className="mt-2"
                                title={phase === 'code_finished' ? copy.traceViewResult : phase === 'stdout_chunk' ? copy.traceViewOutput : copy.traceViewDetail}
                                code={detail}
                                language={codeLanguage(detail)}
                                defaultOpen={phase === 'code_finished' || phase === 'code_timeout'}
                              />
                            )}
                            {code && (
                              <details className={cn(SKILL_TRACE_CODE_DETAILS_CLASS, 'mt-[10px]')} open={index === latestCodeIndex}>
                                <summary className={SKILL_TRACE_CODE_SUMMARY_CLASS}>
                                  {codeTitle}
                                  <TraceDisclosureLabel />
                                </summary>
                                <CodeBlock className={SKILL_CODE_BLOCK_CLASS} code={code} language="python" />
                              </details>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>

                <section>
                  <div className={SKILL_SECTION_LABEL_CLASS}>{copy.outputTitle}</div>
                  <div className={SKILL_OUTPUT_STACK_CLASS}>
                    <RunCodePanel
                      title={copy.structuredResult}
                      code={formatJson(activeResult.structured_result) || copy.noStructuredResult}
                      language="json"
                      defaultOpen
                    />
                    <RunCodePanel
                      title={copy.stdoutTitle}
                      code={formatJson(activeResult.stdout) || copy.noStdout}
                      language={codeLanguage(formatJson(activeResult.stdout), 'text')}
                    />
                    <RunCodePanel
                      title={copy.stderrTitle}
                      code={formatJson(activeResult.stderr) || copy.noStderr}
                      language={codeLanguage(formatJson(activeResult.stderr), 'text')}
                    />
                  </div>
                </section>
                    </>
                  );
                })()}
              </div>
            ) : (
              <div className="flex min-h-[120px] flex-col items-center justify-center gap-[8px] text-center text-[13px] text-muted-foreground">
                {copy.resultEmptyHint}
              </div>
            )}
          </SectionCard>
      </div>
      <ClawHubDialog
        open={clawhubModalOpen}
        loading={clawhubLoading}
        source={clawhubSource}
        onSourceChange={setClawhubSource}
        onClose={cancelClawHubImport}
        onSubmit={() => void importClawHubSource()}
      />
      <ResourceImportDialog
        open={agentImportOpen}
        loading={agentImportLoading}
        icon={<IconSkill className="size-[14px] shrink-0" />}
        title={agentImportMode === 'plaza' ? copy.importMarketplaceTitle : copy.importEmployeeTitle}
        sourcePlaceholder={agentImportMode === 'plaza' ? copy.importMarketplacePlaceholder : copy.importEmployeePlaceholder}
        sources={agentImportMode === 'plaza'
          ? openGalleryImportSourceOptions(agentImportAgents, copy.importMarketplacePlaceholder)
          : visibleEmployeeAgents(agentImportAgents, currentUser, { activeOnly: true, excludeAgentId: agentId })
            .map((item) => ({ value: item.id, label: item.name }))}
        sourceId={agentImportSourceAgentId}
        itemsLabel={copy.importItemsLabel}
        items={agentImportSourceSkills.map((item) => ({
          id: item.id,
          label: (
            <>
              {item.name}
              <span className="text-[#858b9c]"> · {item.slug}</span>
            </>
          ),
        }))}
        selectedIds={agentImportSelectedSkillIds}
        emptyText={copy.importEmpty}
        note={agentImportMode === 'plaza'
          ? copy.importMarketplaceNote
          : copy.importEmployeeNote}
        onSourceChange={(value) => {
          setAgentImportSourceAgentId(value);
          void loadAgentImportSourceSkills(value);
        }}
        onSelectedChange={setAgentImportSelectedSkillIds}
        onClose={() => setAgentImportOpen(false)}
        onSubmit={() => void submitAgentImportSkills()}
      />

      <ConfirmDialog
        open={Boolean(deleteSkillTarget)}
        onOpenChange={(open) => !open && setDeleteSkillTarget(null)}
        title={deleteSkillTarget
          ? interpolate(copy.deleteTitle, {
            action: isOverallAgent ? copy.actionDelete : copy.actionRemove,
            name: deleteSkillTarget.name,
          })
          : ''}
        description={isOverallAgent
          ? copy.deleteDescriptionOverall
          : copy.deleteDescriptionScoped}
        confirmText={isOverallAgent ? copy.actionDelete : copy.actionRemove}
        cancelText={copy.cancelAction}
        onConfirm={() => void runDeleteSkill()}
      />

      <ConfirmDialog
        open={Boolean(deleteFileTarget)}
        onOpenChange={(open) => !open && setDeleteFileTarget(null)}
        title={deleteFileTarget ? interpolate(copy.fileDeleteTitle, { name: deleteFileTarget.path }) : ''}
        description={copy.fileDeleteDescription}
        confirmText={copy.deleteFileAction}
        cancelText={copy.cancelAction}
        onConfirm={runDeleteFile}
      />

      <ConfirmDialog
        open={Boolean(deleteFolderTarget)}
        onOpenChange={(open) => !open && setDeleteFolderTarget(null)}
        title={deleteFolderTarget ? interpolate(copy.folderDeleteTitle, { name: deleteFolderTarget }) : ''}
        description={copy.folderDeleteDescription}
        confirmText={copy.deleteFileAction}
        cancelText={copy.cancelAction}
        onConfirm={runDeleteFolder}
      />

      <Dialog open={Boolean(createEntryMode)} onOpenChange={(open) => { if (!open) setCreateEntryMode(null); }}>
        <DialogContent aria-describedby={undefined} className="flex w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden rounded-[16px] p-0 sm:max-w-[420px]">
          <DialogTitle className="border-b border-border px-[24px] py-[16px] text-[16px] font-semibold text-foreground">
            {createEntryMode === 'folder' ? copy.createFolderTitle : copy.createFileTitle}
          </DialogTitle>
          <div className="px-[24px] py-[16px]">
            <Input
              autoFocus
              value={createEntryValue}
              placeholder={createEntryMode === 'folder' ? copy.createFolderPlaceholder : copy.createFilePlaceholder}
              onChange={(event) => setCreateEntryValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  runCreateEntry();
                }
              }}
            />
          </div>
          <div className="flex items-center justify-end gap-[8px] bg-background px-[24px] py-[12px]">
            <UIButton
              variant="outline"
              onClick={() => setCreateEntryMode(null)}
              className="h-[32px] w-[80px] rounded-[10px] border-[#e3e7f1] bg-white px-[12px] text-[14px] font-normal text-[#464c5e] hover:border-[#e3e7f1] hover:bg-[#f6f6f6] hover:text-[#18181a]"
            >
              {copy.cancelAction}
            </UIButton>
            <UIButton
              onClick={runCreateEntry}
              className="h-[32px] w-[80px] rounded-[10px] bg-[#18181a] px-[12px] text-[14px] font-normal text-white hover:bg-[#303030]"
            >
              {copy.createEntry}
            </UIButton>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={importPrepareOpen}
        onOpenChange={(open) => { if (!open) { setImportPrepareOpen(false); importPrepareActionRef.current = null; } }}
      >
        <DialogContent aria-describedby={undefined} className="flex w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden rounded-[16px] p-0 sm:max-w-[460px]">
          <DialogTitle className="border-b border-border px-[24px] py-[16px] text-[16px] font-semibold text-foreground">
            {copy.importPrepareTitle}
          </DialogTitle>
          <p className="px-[24px] py-[16px] text-[13px] leading-[20px] text-[#4f5669]">
            {copy.importPrepareDescription}
          </p>
          <div className="flex items-center justify-end gap-[8px] bg-background px-[24px] py-[12px]">
            <UIButton
              variant="outline"
              onClick={() => { setImportPrepareOpen(false); importPrepareActionRef.current = null; }}
              className="h-[32px] rounded-[10px] border-[#e3e7f1] bg-white px-[14px] text-[14px] font-normal text-[#464c5e] hover:border-[#e3e7f1] hover:bg-[#f6f6f6] hover:text-[#18181a]"
            >
              {copy.cancelAction}
            </UIButton>
            <UIButton
              variant="outline"
              onClick={() => void confirmImportPrepareSkip()}
              className="h-[32px] rounded-[10px] border-[#e3e7f1] bg-white px-[14px] text-[14px] font-normal text-[#464c5e] hover:border-[#e3e7f1] hover:bg-[#f6f6f6] hover:text-[#18181a]"
            >
              {copy.importPrepareSkip}
            </UIButton>
            <UIButton
              onClick={() => void confirmImportPrepareSave()}
              className="h-[32px] rounded-[10px] bg-[#18181a] px-[14px] text-[14px] font-normal text-white hover:bg-[#303030]"
            >
              {copy.importPrepareSave}
            </UIButton>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(renameTarget || renameFolderTarget)}
        onOpenChange={(open) => {
          if (!open) {
            setRenameTarget(null);
            setRenameFolderTarget(null);
          }
        }}
      >
        <DialogContent aria-describedby={undefined} className="flex w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden rounded-[16px] p-0 sm:max-w-[420px]">
          <DialogTitle className="border-b border-border px-[24px] py-[16px] text-[16px] font-semibold text-foreground">
            {renameFolderTarget ? copy.renameFolderTitle : copy.renameFileTitle}
          </DialogTitle>
          <div className="px-[24px] py-[16px]">
            <Input
              autoFocus
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  if (renameFolderTarget) runRenameFolder();
                  else runRenameFile();
                }
              }}
            />
          </div>
          <div className="flex items-center justify-end gap-[8px] bg-background px-[24px] py-[12px]">
            <UIButton
              variant="outline"
              onClick={() => {
                setRenameTarget(null);
                setRenameFolderTarget(null);
              }}
              className="h-[32px] w-[80px] rounded-[10px] border-[#e3e7f1] bg-white px-[12px] text-[14px] font-normal text-[#464c5e] hover:border-[#e3e7f1] hover:bg-[#f6f6f6] hover:text-[#18181a]"
            >
              {copy.cancelAction}
            </UIButton>
            <UIButton
              onClick={renameFolderTarget ? runRenameFolder : runRenameFile}
              className="h-[32px] w-[80px] rounded-[10px] bg-[#18181a] px-[12px] text-[14px] font-normal text-white hover:bg-[#303030]"
            >
              {copy.renameAction}
            </UIButton>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
