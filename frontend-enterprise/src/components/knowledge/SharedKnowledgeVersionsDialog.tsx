/**
 * 共享知识库历史面板：管理全局版本生命周期，并按来源与权限变化复盘只追加审计事件。
 */

import { useContext, useEffect, useMemo, useRef, useState } from 'react';

import { createTenantClient } from '@/api/tenant-client';
import { useTenantSession } from '@/contexts/TenantSessionContext';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  Input,
} from '@/components/ui';
import { Button } from '@/components/ui/button';
import { notify } from '@/components/ui/app-toast';
import { createAppTranslator, getStoredLocale } from '@/i18n';
import { RawContent, RawIdentifier } from '@/i18n/RawContent';
import { AppIntlContext } from '@/i18n/provider';
import { apiErrorCode, apiErrorMessage } from '@/lib/apiErrorMessages';
import type {
  KnowledgeBaseAuditEventRead,
  KnowledgeBaseAuditPageRead,
  KnowledgeBaseRead,
  KnowledgeBaseVersionRead,
} from '@/types';

type TeamOption = {
  id: string;
  name: string;
};

type SharedKnowledgeVersionsDialogProps = {
  open: boolean;
  knowledgeBase: KnowledgeBaseRead | null;
  teamOptions: TeamOption[];
  onClose: () => void;
  onChanged?: () => void | Promise<void>;
};

type HistoryView = 'versions' | 'audit';

type AuditFilters = {
  teamId: string;
  action: string;
  actorType: string;
  actorId: string;
  versionId: string;
};

const EMPTY_AUDIT_FILTERS: AuditFilters = {
  teamId: '',
  action: '',
  actorType: '',
  actorId: '',
  versionId: '',
};

const EMPTY_AUDIT_PAGE: KnowledgeBaseAuditPageRead = {
  items: [],
  total: 0,
  offset: 0,
  limit: 20,
  has_more: false,
};

/** 为共享知识版本对话框提供稳定翻译入口；无 Provider 时回退当前持久化 locale。 */
function useSharedKnowledgeVersionsIntl() {
  const context = useContext(AppIntlContext);
  return useMemo(() => context ?? createAppTranslator(getStoredLocale()), [context]);
}

function publicationState(version: KnowledgeBaseVersionRead) {
  /** 旧版历史缺省视为正式版本，仅供专用兼容数据安全展示。 */
  return version.publication_state || 'released';
}

function auditActionLabel(
  action: string,
  t: ReturnType<typeof useSharedKnowledgeVersionsIntl>['t'],
) {
  /** 将稳定审计动作码映射为可读业务动作，未知码保留原值便于诊断。 */
  const messageIds: Record<string, Parameters<typeof t>[0]> = {
    shared_created: 'sharedKnowledgeVersions.auditAction.sharedCreated',
    binding_created: 'sharedKnowledgeVersions.auditAction.bindingCreated',
    binding_revoked: 'sharedKnowledgeVersions.auditAction.bindingRevoked',
    default_changed: 'sharedKnowledgeVersions.auditAction.defaultChanged',
    grant_created: 'sharedKnowledgeVersions.auditAction.grantCreated',
    grant_changed: 'sharedKnowledgeVersions.auditAction.grantChanged',
    grant_revoked: 'sharedKnowledgeVersions.auditAction.grantRevoked',
    draft_created: 'sharedKnowledgeVersions.auditAction.draftCreated',
    draft_updated: 'sharedKnowledgeVersions.auditAction.draftUpdated',
    version_published: 'sharedKnowledgeVersions.auditAction.versionPublished',
    draft_rejected: 'sharedKnowledgeVersions.auditAction.draftRejected',
    version_rolled_back: 'sharedKnowledgeVersions.auditAction.versionRolledBack',
    dedicated_converted: 'sharedKnowledgeVersions.auditAction.dedicatedConverted',
    conversion_failed: 'sharedKnowledgeVersions.auditAction.conversionFailed',
  };
  return messageIds[action] ? t(messageIds[action]) : action;
}

function auditDetail(event: KnowledgeBaseAuditEventRead, key: string) {
  /** 安全读取审计详情中的标量来源字段；对象值不会直接渲染到页面。 */
  const value = event.details?.[key];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function permissionLabel(
  permission: string,
  t: ReturnType<typeof useSharedKnowledgeVersionsIntl>['t'],
) {
  const messageIds: Record<string, Parameters<typeof t>[0]> = {
    none: 'sharedKnowledgeVersions.permission.none',
    reader: 'sharedKnowledgeVersions.permission.reader',
    editor: 'sharedKnowledgeVersions.permission.editor',
    publisher: 'sharedKnowledgeVersions.permission.publisher',
  };
  return messageIds[permission] ? t(messageIds[permission]) : permission;
}

function actorTypeLabel(
  actorType: string,
  t: ReturnType<typeof useSharedKnowledgeVersionsIntl>['t'],
) {
  const messageIds: Record<string, Parameters<typeof t>[0]> = {
    user: 'sharedKnowledgeVersions.actor.user',
    agent: 'sharedKnowledgeVersions.actor.agent',
    system: 'sharedKnowledgeVersions.actor.system',
  };
  return messageIds[actorType] ? t(messageIds[actorType]) : actorType;
}

function permissionTransition(
  event: KnowledgeBaseAuditEventRead,
  t: ReturnType<typeof useSharedKnowledgeVersionsIntl>['t'],
) {
  /** 将权限变更前后状态投影为产品定义的四档权限文案。 */
  const previous = auditDetail(event, 'previous_permission') || 'none';
  const current = auditDetail(event, 'current_permission') || auditDetail(event, 'permission');
  if (!current) return '';
  return t('sharedKnowledgeVersions.audit.permissionTransition', {
    previous: permissionLabel(previous, t),
    current: permissionLabel(current, t),
  });
}

function versionTransition(
  event: KnowledgeBaseAuditEventRead,
  t: ReturnType<typeof useSharedKnowledgeVersionsIntl>['t'],
  versionLabels: Map<string, string>,
) {
  /** 从事件详情和受影响版本拼出发布或回滚指针变化。 */
  const previousId = auditDetail(event, 'previous_version_id');
  const targetId = auditDetail(event, 'target_version_id')
    || auditDetail(event, 'published_version_id')
    || event.knowledge_base_version_id
    || '';
  if (!previousId || !targetId) return '';
  const previous = versionLabels.get(previousId) || previousId;
  const target = versionLabels.get(targetId) || event.knowledge_base_version || targetId;
  return t('sharedKnowledgeVersions.audit.versionTransition', {
    previous: `v${previous}`,
    target: `v${target}`,
  });
}

function formatAuditTime(
  value: string,
  locale: ReturnType<typeof useSharedKnowledgeVersionsIntl>['locale'],
) {
  /** 以本地短日期时间展示事件时间；无效值原样返回避免丢失证据。 */
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function buildAuditQuery(offset: number, filters: AuditFilters) {
  /** 只发送已填写的审计筛选，并固定每页二十条。 */
  const params = new URLSearchParams({
    offset: String(offset),
    limit: '20',
  });
  if (filters.teamId) params.set('team_id', filters.teamId);
  if (filters.action) params.set('action', filters.action);
  if (filters.actorType) params.set('actor_type', filters.actorType);
  if (filters.actorId.trim()) params.set('actor_id', filters.actorId.trim());
  if (filters.versionId) params.set('version_id', filters.versionId);
  return params.toString();
}

export function SharedKnowledgeVersionsDialog({
  open,
  knowledgeBase,
  teamOptions,
  onClose,
  onChanged,
}: SharedKnowledgeVersionsDialogProps) {
  /** 管理一个共享库的全局草稿、发布、驳回与回滚生命周期。 */
  const { locale, t } = useSharedKnowledgeVersionsIntl();
  const tenantContext = useTenantSession();
  const tenantClient = useMemo(() => createTenantClient(tenantContext), [tenantContext]);
  const tenantId = tenantContext?.tenantId || '';
  const requestControllerRef = useRef<AbortController | null>(null);
  const [versions, setVersions] = useState<KnowledgeBaseVersionRead[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState('');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [activeView, setActiveView] = useState<HistoryView>('versions');
  const [auditPage, setAuditPage] = useState<KnowledgeBaseAuditPageRead>(EMPTY_AUDIT_PAGE);
  const [auditFilters, setAuditFilters] = useState<AuditFilters>(EMPTY_AUDIT_FILTERS);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditErrorMessage, setAuditErrorMessage] = useState('');

  const publishedHead = useMemo(
    () => versions.find((version) => version.is_published_head),
    [versions],
  );
  const versionLabels = useMemo(
    () => new Map(versions.map((version) => [version.id, version.version])),
    [versions],
  );
  const auditTeamOptions = useMemo(() => {
    const options = new Map(teamOptions.map((team) => [team.id, team.name]));
    auditPage.items.forEach((event) => {
      if (event.team_id) options.set(event.team_id, event.team_name || event.team_id);
    });
    return Array.from(options, ([id, name]) => ({ id, name }));
  }, [auditPage.items, teamOptions]);
  const auditActionOptions = useMemo(() => {
    const actions = new Set([
      'shared_created',
      'binding_created',
      'binding_revoked',
      'default_changed',
      'grant_created',
      'grant_changed',
      'grant_revoked',
      'draft_created',
      'draft_updated',
      'version_published',
      'draft_rejected',
      'version_rolled_back',
      'dedicated_converted',
      'conversion_failed',
    ]);
    auditPage.items.forEach((event) => actions.add(event.action));
    return Array.from(actions);
  }, [auditPage.items]);

  useEffect(() => {
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    return () => {
      controller.abort();
      if (requestControllerRef.current === controller) requestControllerRef.current = null;
    };
  }, [open, knowledgeBase?.id, tenantContext]);

  useEffect(() => {
    if (!open || !knowledgeBase || !tenantContext) return;
    setSelectedTeamId((current) => (
      teamOptions.some((team) => team.id === current) ? current : teamOptions[0]?.id || ''
    ));
    setReason('');
    setErrorMessage('');
    setActiveView('versions');
    setAuditPage(EMPTY_AUDIT_PAGE);
    setAuditFilters(EMPTY_AUDIT_FILTERS);
    setAuditErrorMessage('');
    void loadVersions();
  }, [open, knowledgeBase?.id, teamOptions.map((team) => team.id).join('|'), tenantClient, tenantContext, tenantId]);

  useEffect(() => {
    if (!open || !knowledgeBase || activeView !== 'audit' || !tenantContext) return;
    void loadAuditEvents(0, auditFilters, false);
  }, [
    open,
    knowledgeBase?.id,
    activeView,
    auditFilters.teamId,
    auditFilters.action,
    auditFilters.actorType,
    auditFilters.actorId,
    auditFilters.versionId,
    tenantClient,
    tenantContext,
    tenantId,
  ]);

  async function loadVersions() {
    /** 重新读取服务端正式指针和历史，避免继续使用冲突前的本地状态。 */
    if (!knowledgeBase || !tenantContext) return;
    const context = tenantContext;
    const generation = context.generation;
    const controller = requestControllerRef.current;
    if (!controller) return;
    setLoading(true);
    try {
      const rows = await tenantClient.get<KnowledgeBaseVersionRead[]>(
        `/api/enterprise/knowledge-bases/${knowledgeBase.id}/versions?tenant_id=${tenantId}`,
        { signal: controller.signal },
      );
      if (controller.signal.aborted || !context.isCurrentGeneration(generation)) return;
      setVersions(rows);
    } catch (error) {
      if (controller.signal.aborted || !context.isCurrentGeneration(generation)) return;
      const message = apiErrorMessage(error, 'sharedKnowledgeVersions.error.loadVersions', { t });
      setErrorMessage(message);
      notify.error(message);
    } finally {
      if (!controller.signal.aborted && context.isCurrentGeneration(generation)) setLoading(false);
    }
  }

  async function loadAuditEvents(
    offset: number,
    filters: AuditFilters,
    append: boolean,
  ) {
    /** 按当前筛选读取审计页；追加模式用于加载更多且保留既有证据顺序。 */
    if (!knowledgeBase || !tenantContext) return;
    const context = tenantContext;
    const generation = context.generation;
    const controller = requestControllerRef.current;
    if (!controller) return;
    setAuditLoading(true);
    setAuditErrorMessage('');
    try {
      const page = await tenantClient.get<KnowledgeBaseAuditPageRead>(
        `/api/enterprise/knowledge-bases/${knowledgeBase.id}/audit-events?${buildAuditQuery(offset, filters)}`,
        { signal: controller.signal },
      );
      if (controller.signal.aborted || !context.isCurrentGeneration(generation)) return;
      setAuditPage((current) => (
        append
          ? { ...page, items: [...current.items, ...page.items] }
          : page
      ));
    } catch (error) {
      if (controller.signal.aborted || !context.isCurrentGeneration(generation)) return;
      const message = apiErrorMessage(error, 'sharedKnowledgeVersions.error.loadAudit', { t });
      setAuditErrorMessage(message);
      notify.error(message);
    } finally {
      if (!controller.signal.aborted && context.isCurrentGeneration(generation)) setAuditLoading(false);
    }
  }

  function updateAuditFilter(key: keyof AuditFilters, value: string) {
    /** 更新一个筛选维度；筛选 effect 会从第一页重新读取服务端结果。 */
    setAuditFilters((current) => ({ ...current, [key]: value }));
  }

  function loadMoreAuditEvents() {
    /** 从当前已展示数量继续读取下一页，不重复首屏事件。 */
    if (auditLoading || !auditPage.has_more) return;
    void loadAuditEvents(auditPage.items.length, auditFilters, true);
  }

  async function runMutation(
    action: () => Promise<unknown>,
    successMessage: string,
  ) {
    /** 串行执行生命周期动作；冲突时强制刷新正式指针后再让用户确认。 */
    if (!knowledgeBase || !selectedTeamId || !reason.trim() || !tenantContext) return;
    const context = tenantContext;
    const generation = context.generation;
    const controller = requestControllerRef.current;
    if (!controller) return;
    setActing(true);
    setErrorMessage('');
    try {
      await action();
      if (controller.signal.aborted || !context.isCurrentGeneration(generation)) return;
      notify.successText(successMessage);
      setReason('');
      await loadVersions();
      await onChanged?.();
    } catch (error) {
      if (controller.signal.aborted || !context.isCurrentGeneration(generation)) return;
      const message = apiErrorMessage(error, 'sharedKnowledgeVersions.error.mutation', { t });
      setErrorMessage(message);
      notify.error(message);
      if (apiErrorCode(error) === 'KNOWLEDGE_PUBLISH_CONFLICT') {
        await loadVersions();
      }
    } finally {
      if (!controller.signal.aborted && context.isCurrentGeneration(generation)) setActing(false);
    }
  }

  function createDraft() {
    /** 从当前全局正式版本创建团队来源明确的新草稿。 */
    if (!knowledgeBase) return;
    const expectedHead = publishedHead?.id || knowledgeBase.published_version_id;
    void runMutation(
      () => tenantClient.post(`/api/enterprise/knowledge-bases/${knowledgeBase.id}/drafts`, {
        tenant_id: tenantId,
        team_id: selectedTeamId,
        change_reason: reason.trim(),
        expected_published_version_id: expectedHead,
      }),
      t('sharedKnowledgeVersions.toast.createdDraft'),
    );
  }

  function publishDraft(version: KnowledgeBaseVersionRead) {
    /** 以当前正式指针作为 CAS 预期值发布所选草稿。 */
    if (!knowledgeBase || !publishedHead) return;
    void runMutation(
      () => tenantClient.post(
        `/api/enterprise/knowledge-bases/${knowledgeBase.id}/versions/${version.id}/publish`,
        {
          tenant_id: tenantId,
          team_id: selectedTeamId,
          expected_published_version_id: publishedHead.id,
          change_reason: reason.trim(),
        },
      ),
      t('sharedKnowledgeVersions.toast.published', { version: version.version }),
    );
  }

  function rejectDraft(version: KnowledgeBaseVersionRead) {
    /** 驳回草稿并保留历史快照。 */
    if (!knowledgeBase) return;
    void runMutation(
      () => tenantClient.post(
        `/api/enterprise/knowledge-bases/${knowledgeBase.id}/versions/${version.id}/reject`,
        {
          tenant_id: tenantId,
          team_id: selectedTeamId,
          change_reason: reason.trim(),
        },
      ),
      t('sharedKnowledgeVersions.toast.rejected', { version: version.version }),
    );
  }

  function rollbackTo(version: KnowledgeBaseVersionRead) {
    /** 只移动正式指针到历史发布快照，不删除任何后来版本。 */
    if (!knowledgeBase || !publishedHead) return;
    void runMutation(
      () => tenantClient.post(`/api/enterprise/knowledge-bases/${knowledgeBase.id}/rollback`, {
        tenant_id: tenantId,
        team_id: selectedTeamId,
        target_version_id: version.id,
        expected_published_version_id: publishedHead.id,
        change_reason: reason.trim(),
      }),
      t('sharedKnowledgeVersions.toast.rolledBack', { version: version.version }),
    );
  }

  const canMutate = Boolean(selectedTeamId && reason.trim() && !acting);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[86vh] max-w-[920px] overflow-y-auto">
        <DialogTitle>{t('sharedKnowledgeVersions.dialog.title', { name: knowledgeBase?.name || '' })}</DialogTitle>
        <div className="flex flex-col gap-4">
          <p className="m-0 text-sm leading-6 text-muted-foreground">
            {t('sharedKnowledgeVersions.dialog.description')}
          </p>

          <div role="tablist" aria-label={t('sharedKnowledgeVersions.tabs.label')} className="flex gap-1 rounded-lg bg-muted p-1">
            <Button
              role="tab"
              aria-selected={activeView === 'versions'}
              variant={activeView === 'versions' ? 'default' : 'ghost'}
              className="flex-1"
              onClick={() => setActiveView('versions')}
            >
              {t('sharedKnowledgeVersions.tabs.versions')}
            </Button>
            <Button
              role="tab"
              aria-selected={activeView === 'audit'}
              variant={activeView === 'audit' ? 'default' : 'ghost'}
              className="flex-1"
              onClick={() => setActiveView('audit')}
            >
              {t('sharedKnowledgeVersions.tabs.audit')}
            </Button>
          </div>

          {activeView === 'versions' ? (
            <>
              <div className="grid gap-3 rounded-xl border bg-muted/25 p-4 md:grid-cols-[220px_minmax(0,1fr)_auto]">
            <label className="flex flex-col gap-2 text-sm font-medium">
              {t('sharedKnowledgeVersions.field.team')}
              <select
                aria-label={t('sharedKnowledgeVersions.field.team')}
                className="h-9 rounded-md border bg-background px-3 text-sm"
                value={selectedTeamId}
                onChange={(event) => setSelectedTeamId(event.target.value)}
              >
                {teamOptions.map((team) => (
                  <option key={team.id} value={team.id}>{team.name}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-2 text-sm font-medium">
              {t('sharedKnowledgeVersions.field.reason')}
              <Input
                aria-label={t('sharedKnowledgeVersions.field.reason')}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder={t('sharedKnowledgeVersions.field.reasonPlaceholder')}
              />
            </label>
            <Button className="self-end" disabled={!canMutate} onClick={createDraft}>
              {t('sharedKnowledgeVersions.actions.createDraft')}
            </Button>
              </div>

              {teamOptions.length === 0 ? (
                <div role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
                  {t('sharedKnowledgeVersions.status.noManagedTeams')}
                </div>
              ) : null}
              {errorMessage ? (
                <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                  {errorMessage}
                </div>
              ) : null}

              <div aria-label={t('sharedKnowledgeVersions.status.versionHistory')} className="flex flex-col gap-2">
            {loading ? <p className="text-sm text-muted-foreground">{t('sharedKnowledgeVersions.status.loadingVersions')}</p> : null}
            {!loading && versions.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('sharedKnowledgeVersions.status.emptyVersions')}</p>
            ) : null}
            {versions.map((version) => (
              <article
                key={version.id}
                className="grid gap-3 rounded-xl border p-4 md:grid-cols-[minmax(0,1fr)_auto]"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <strong className="text-sm">v{version.version}</strong>
                    <span className="rounded-full bg-muted px-2 py-1 text-xs">
                      {publicationState(version) === 'released'
                        ? t('sharedKnowledgeVersions.state.released')
                        : publicationState(version) === 'draft'
                          ? t('sharedKnowledgeVersions.state.draft')
                          : t('sharedKnowledgeVersions.state.rejected')}
                    </span>
                    {version.is_published_head ? (
                      <span className="rounded-full bg-emerald-100 px-2 py-1 text-xs text-emerald-700">
                        {t('sharedKnowledgeVersions.state.current')}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-2 mb-0 text-sm text-muted-foreground">
                    {version.change_reason || t('sharedKnowledgeVersions.field.reasonMissing')}
                  </p>
                  <small className="mt-1 block text-xs text-muted-foreground">
                    {t('sharedKnowledgeVersions.field.sourceTeam')}
                    <RawContent value={teamOptions.find((team) => team.id === version.source_team_id)?.name || version.source_team_id || '-'} />
                  </small>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {publicationState(version) === 'draft' ? (
                    <>
                      <Button
                        size="sm"
                        disabled={!canMutate || !publishedHead}
                        onClick={() => publishDraft(version)}
                        aria-label={t('sharedKnowledgeVersions.actions.publishAria', { version: version.version })}
                      >
                        {t('sharedKnowledgeVersions.actions.publish')}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!canMutate}
                        onClick={() => rejectDraft(version)}
                        aria-label={t('sharedKnowledgeVersions.actions.rejectAria', { version: version.version })}
                      >
                        {t('sharedKnowledgeVersions.actions.reject')}
                      </Button>
                    </>
                  ) : null}
                  {publicationState(version) === 'released' && !version.is_published_head ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!canMutate || !publishedHead}
                      onClick={() => rollbackTo(version)}
                      aria-label={t('sharedKnowledgeVersions.actions.rollbackAria', { version: version.version })}
                    >
                      {t('sharedKnowledgeVersions.actions.rollback')}
                    </Button>
                  ) : null}
                </div>
              </article>
            ))}
              </div>
            </>
          ) : (
            <div aria-label={t('sharedKnowledgeVersions.audit.label')} className="flex flex-col gap-4">
              <div className="grid gap-3 rounded-xl border bg-muted/25 p-4 md:grid-cols-3">
                <label className="flex flex-col gap-2 text-sm font-medium">
                  {t('sharedKnowledgeVersions.audit.action')}
                  <select
                    aria-label={t('sharedKnowledgeVersions.audit.action')}
                    className="h-9 rounded-md border bg-background px-3 text-sm"
                    value={auditFilters.action}
                    onChange={(event) => updateAuditFilter('action', event.target.value)}
                  >
                    <option value="">{t('sharedKnowledgeVersions.audit.allActions')}</option>
                    {auditActionOptions.map((action) => (
                      <option key={action} value={action}>{auditActionLabel(action, t)}</option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-2 text-sm font-medium">
                  {t('sharedKnowledgeVersions.audit.actorType')}
                  <select
                    aria-label={t('sharedKnowledgeVersions.audit.actorType')}
                    className="h-9 rounded-md border bg-background px-3 text-sm"
                    value={auditFilters.actorType}
                    onChange={(event) => updateAuditFilter('actorType', event.target.value)}
                  >
                    <option value="">{t('sharedKnowledgeVersions.audit.allTypes')}</option>
                    <option value="user">{t('sharedKnowledgeVersions.actor.user')}</option>
                    <option value="agent">{t('sharedKnowledgeVersions.actor.agent')}</option>
                    <option value="system">{t('sharedKnowledgeVersions.actor.system')}</option>
                  </select>
                </label>
                <label className="flex flex-col gap-2 text-sm font-medium">
                  {t('sharedKnowledgeVersions.audit.team')}
                  <select
                    aria-label={t('sharedKnowledgeVersions.audit.team')}
                    className="h-9 rounded-md border bg-background px-3 text-sm"
                    value={auditFilters.teamId}
                    onChange={(event) => updateAuditFilter('teamId', event.target.value)}
                  >
                    <option value="">{t('sharedKnowledgeVersions.audit.allTeams')}</option>
                    {auditTeamOptions.map((team) => (
                      <option key={team.id} value={team.id}>{team.name}</option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-2 text-sm font-medium">
                  {t('sharedKnowledgeVersions.audit.version')}
                  <select
                    aria-label={t('sharedKnowledgeVersions.audit.version')}
                    className="h-9 rounded-md border bg-background px-3 text-sm"
                    value={auditFilters.versionId}
                    onChange={(event) => updateAuditFilter('versionId', event.target.value)}
                  >
                    <option value="">{t('sharedKnowledgeVersions.audit.allVersions')}</option>
                    {versions.map((version) => (
                      <option key={version.id} value={version.id}>v{version.version}</option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-2 text-sm font-medium md:col-span-2">
                  {t('sharedKnowledgeVersions.audit.actorId')}
                  <Input
                    aria-label={t('sharedKnowledgeVersions.audit.actorId')}
                    value={auditFilters.actorId}
                    onChange={(event) => updateAuditFilter('actorId', event.target.value)}
                    placeholder={t('sharedKnowledgeVersions.audit.actorIdPlaceholder')}
                  />
                </label>
              </div>

              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{t('sharedKnowledgeVersions.audit.total', { count: auditPage.total })}</span>
                <span>{t('sharedKnowledgeVersions.audit.appendOnly')}</span>
              </div>
              {auditErrorMessage ? (
                <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                  {auditErrorMessage}
                </div>
              ) : null}
              {auditLoading && auditPage.items.length === 0 ? (
                <p role="status" className="text-sm text-muted-foreground">{t('sharedKnowledgeVersions.status.loadingAudit')}</p>
              ) : null}
              {!auditLoading && auditPage.items.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('sharedKnowledgeVersions.status.emptyAudit')}</p>
              ) : null}

              <div className="flex flex-col gap-2">
                {auditPage.items.map((event) => {
                  const pointerTransition = versionTransition(event, t, versionLabels);
                  const grantTransition = event.action.startsWith('grant_')
                    ? permissionTransition(event, t)
                    : '';
                  const sourceTaskId = auditDetail(event, 'source_task_id');
                  const sourceConversationId = auditDetail(event, 'source_conversation_id')
                    || auditDetail(event, 'conversation_id');
                  return (
                    <article key={event.id} className="rounded-xl border p-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <strong className="text-sm text-foreground">
                            {auditActionLabel(event.action, t)}
                          </strong>
                          <p className="mt-1 mb-0 text-sm text-muted-foreground">
                            {event.reason || t('sharedKnowledgeVersions.field.reasonMissing')}
                          </p>
                        </div>
                        <time className="text-xs text-muted-foreground" dateTime={event.created_at}>
                          {formatAuditTime(event.created_at, locale)}
                        </time>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
                        <span className="rounded-full bg-muted px-2 py-1">
                          <RawContent value={event.actor_name} /> · {actorTypeLabel(event.actor_type, t)}
                        </span>
                        {event.team_id ? (
                          <span className="rounded-full bg-muted px-2 py-1">
                            <RawContent value={event.team_name || event.team_id} />
                          </span>
                        ) : null}
                        {event.knowledge_base_version ? (
                          <span className="rounded-full bg-muted px-2 py-1">
                            v{event.knowledge_base_version}
                          </span>
                        ) : null}
                      </div>
                      {pointerTransition ? (
                        <p className="mt-3 mb-0 text-sm font-medium text-foreground">{pointerTransition}</p>
                      ) : null}
                      {grantTransition ? (
                        <p className="mt-3 mb-0 text-sm font-medium text-foreground">{grantTransition}</p>
                      ) : null}
                      {sourceTaskId ? (
                        <small className="mt-2 block text-xs text-muted-foreground">
                          {t('sharedKnowledgeVersions.audit.sourceTask')}
                          <RawIdentifier value={sourceTaskId} />
                        </small>
                      ) : null}
                      {sourceConversationId ? (
                        <small className="mt-1 block text-xs text-muted-foreground">
                          {t('sharedKnowledgeVersions.audit.sourceConversation')}
                          <RawIdentifier value={sourceConversationId} />
                        </small>
                      ) : null}
                    </article>
                  );
                })}
              </div>
              {auditPage.has_more ? (
                <Button
                  variant="outline"
                  disabled={auditLoading}
                  onClick={loadMoreAuditEvents}
                >
                  {auditLoading ? t('sharedKnowledgeVersions.actions.loadingMore') : t('sharedKnowledgeVersions.actions.loadMoreAudit')}
                </Button>
              ) : null}
            </div>
          )}

          <div className="flex justify-end">
            <Button variant="outline" onClick={onClose}>{t('common.action.cancel')}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
