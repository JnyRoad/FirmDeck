/**
 * 专用知识库转换向导：读取员工分支版本与可选团队，提交原子转换，并清楚展示来源保护边界。
 */

import { useContext, useEffect, useMemo, useRef, useState } from 'react';

import { createTenantClient } from '@/api/tenant-client';
import { useTenantSession } from '@/contexts/TenantSessionContext';
import {
  Checkbox,
  Dialog,
  DialogContent,
  DialogTitle,
  Input,
  Textarea,
} from '@/components/ui';
import { notify } from '@/components/ui/app-toast';
import { Button } from '@/components/ui/button';
import { createAppTranslator, getStoredLocale } from '@/i18n';
import { RawContent, RawIdentifier } from '@/i18n/RawContent';
import { AppIntlContext } from '@/i18n/provider';
import { apiErrorMessage } from '@/lib/apiErrorMessages';
import type {
  KnowledgeBaseConversionRead,
  KnowledgeBaseRead,
  KnowledgeBaseVersionRead,
  TeamRead,
} from '@/types';

type SharedKnowledgeConversionDialogProps = {
  open: boolean;
  knowledgeBase: KnowledgeBaseRead | null;
  agentId: string;
  onClose: () => void;
  onConverted: (result: KnowledgeBaseConversionRead) => void | Promise<void>;
};

/** 为共享知识转换对话框提供稳定翻译入口；无 Provider 时回退当前持久化 locale。 */
function useSharedKnowledgeConversionIntl() {
  const context = useContext(AppIntlContext);
  return useMemo(() => context ?? createAppTranslator(getStoredLocale()), [context]);
}

export function SharedKnowledgeConversionDialog({
  open,
  knowledgeBase,
  agentId,
  onClose,
  onConverted,
}: SharedKnowledgeConversionDialogProps) {
  /** 管理一次员工专用分支到新共享谱系的预览、配置和提交。 */
  const { t } = useSharedKnowledgeConversionIntl();
  const tenantContext = useTenantSession();
  const tenantClient = useMemo(() => createTenantClient(tenantContext), [tenantContext]);
  const tenantId = tenantContext?.tenantId || '';
  const requestControllerRef = useRef<AbortController | null>(null);
  const [versions, setVersions] = useState<KnowledgeBaseVersionRead[]>([]);
  const [teams, setTeams] = useState<TeamRead[]>([]);
  const [sourceVersionId, setSourceVersionId] = useState('');
  const [sharedName, setSharedName] = useState('');
  const [sharedDescription, setSharedDescription] = useState('');
  const [changeReason, setChangeReason] = useState('');
  const [selectedTeamIds, setSelectedTeamIds] = useState<string[]>([]);
  const [defaultTeamId, setDefaultTeamId] = useState('');
  const [contextLoading, setContextLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [conversionResult, setConversionResult] = useState<KnowledgeBaseConversionRead | null>(null);

  const selectedVersion = useMemo(
    () => versions.find((version) => version.id === sourceVersionId) || null,
    [sourceVersionId, versions],
  );
  const selectedTeams = useMemo(
    () => teams.filter((team) => selectedTeamIds.includes(team.id)),
    [selectedTeamIds, teams],
  );
  const canSubmit = Boolean(
    knowledgeBase
    && agentId
    && sourceVersionId
    && sharedName.trim()
    && changeReason.trim()
    && !contextLoading
    && !submitting
    && !conversionResult,
  );

  useEffect(() => {
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    return () => {
      controller.abort();
      if (requestControllerRef.current === controller) requestControllerRef.current = null;
    };
  }, [open, knowledgeBase?.id, agentId, tenantContext]);

  useEffect(() => {
    if (!open || !knowledgeBase || !tenantContext) return;
    setVersions([]);
    setTeams([]);
    setSourceVersionId('');
    setSharedName(`${knowledgeBase.name}${t('sharedKnowledgeConversion.field.defaultNameSuffix')}`);
    setSharedDescription(knowledgeBase.description || '');
    setChangeReason('');
    setSelectedTeamIds([]);
    setDefaultTeamId('');
    setErrorMessage('');
    setConversionResult(null);
    void loadConversionContext();
  }, [open, knowledgeBase?.id, agentId, tenantClient, tenantContext, tenantId]);

  async function loadConversionContext() {
    /** 读取可转换版本和同租户活动团队；只更新向导本地状态，不改动知识数据。 */
    if (!knowledgeBase || !agentId || !tenantContext) return;
    const context = tenantContext;
    const generation = context.generation;
    const controller = requestControllerRef.current;
    if (!controller) return;
    setContextLoading(true);
    setErrorMessage('');
    try {
      // 版本和团队彼此独立，并行加载后再共同决定默认选项。
      const [versionRows, teamRows] = await Promise.all([
        tenantClient.get<KnowledgeBaseVersionRead[]>(
          `/api/enterprise/knowledge-bases/${knowledgeBase.id}/versions?tenant_id=${tenantId}&agent_id=${encodeURIComponent(agentId)}`,
          { signal: controller.signal },
        ),
        tenantClient.get<TeamRead[]>(`/api/enterprise/teams?tenant_id=${tenantId}`, {
          signal: controller.signal,
        }),
      ]);
      const defaultVersion = versionRows.find((version) => version.is_head)
        || versionRows.find((version) => version.version === knowledgeBase.branch_head_version)
        || versionRows[0];
      if (controller.signal.aborted || !context.isCurrentGeneration(generation)) return;
      setVersions(versionRows);
      setTeams(teamRows.filter((team) => team.status === 'active'));
      setSourceVersionId(defaultVersion?.id || '');
      if (!defaultVersion) {
        setErrorMessage(t('sharedKnowledgeConversion.error.noVersion'));
      }
    } catch (error) {
      if (controller.signal.aborted || !context.isCurrentGeneration(generation)) return;
      const message = apiErrorMessage(error, 'sharedKnowledgeConversion.error.contextLoad', { t });
      setErrorMessage(t('sharedKnowledgeConversion.error.contextLoadBoundary', { message }));
      notify.error(message);
    } finally {
      if (!controller.signal.aborted && context.isCurrentGeneration(generation)) setContextLoading(false);
    }
  }

  function toggleTeam(teamId: string, checked: boolean) {
    /** 增删初始团队绑定；移除默认团队时同步清空默认写入目标。 */
    setSelectedTeamIds((current) => (
      checked
        ? [...current, teamId]
        : current.filter((currentTeamId) => currentTeamId !== teamId)
    ));
    if (!checked && defaultTeamId === teamId) setDefaultTeamId('');
  }

  async function submitConversion() {
    /** 提交原子转换；仅 API 明确成功后才通知页面替换来源实例。 */
    if (!knowledgeBase || !canSubmit || !tenantContext) return;
    const context = tenantContext;
    const generation = context.generation;
    const controller = requestControllerRef.current;
    if (!controller) return;
    setSubmitting(true);
    setErrorMessage('');

    let result: KnowledgeBaseConversionRead;
    try {
      // 服务端先复制与校验，成功响应代表新共享正式版可见且来源实例已归档。
      result = await tenantClient.post<KnowledgeBaseConversionRead>(
        `/api/enterprise/knowledge-bases/${knowledgeBase.id}/convert-to-shared`,
        {
          tenant_id: tenantId,
          agent_id: agentId,
          source_version_id: sourceVersionId,
          name: sharedName.trim(),
          description: sharedDescription.trim() || null,
          change_reason: changeReason.trim(),
          team_bindings: selectedTeamIds,
          default_for_team_id: defaultTeamId || null,
        },
        { signal: controller.signal },
      );
    } catch (error) {
      if (controller.signal.aborted || !context.isCurrentGeneration(generation)) return;
      const message = apiErrorMessage(error, 'sharedKnowledgeConversion.error.failed', { t });
      setErrorMessage(t('sharedKnowledgeConversion.error.failedBoundary', { message }));
      notify.error(message);
      setSubmitting(false);
      return;
    }

    if (controller.signal.aborted || !context.isCurrentGeneration(generation)) return;
    // 页面回调只负责定位新共享库；即使刷新失败，也不能把已完成的转换误报为失败。
    setConversionResult(result);
    notify.successText(t('sharedKnowledgeConversion.toast.created', { name: result.new_knowledge_base.name }));
    try {
      await onConverted(result);
    } catch {
      if (controller.signal.aborted || !context.isCurrentGeneration(generation)) return;
      notify.warning(t('sharedKnowledgeConversion.toast.refreshFailed'));
    } finally {
      if (!controller.signal.aborted && context.isCurrentGeneration(generation)) setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !submitting) onClose();
      }}
    >
      <DialogContent className="max-h-[88vh] max-w-[780px] overflow-y-auto p-0">
        <div className="border-b border-[#eef0f4] px-6 py-5">
          <DialogTitle>{t('sharedKnowledgeConversion.dialog.title', { name: knowledgeBase?.name || '' })}</DialogTitle>
          <p className="mt-2 mb-0 text-sm leading-6 text-[#757f9c]">
            {t('sharedKnowledgeConversion.dialog.description')}
          </p>
        </div>

        <div className="flex flex-col gap-5 px-6 pb-6">
          <section aria-label={t('sharedKnowledgeConversion.preview.label')} className="rounded-xl border border-[#e7eaf1] bg-[#fafbfc] p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="m-0 text-xs font-medium tracking-wide text-[#858b9c]">{t('sharedKnowledgeConversion.preview.source')}</p>
                <strong className="mt-1 block text-sm text-[#18181a]"><RawContent value={knowledgeBase?.name || '-'} /></strong>
              </div>
              <span className="rounded-full bg-[#eef1fb] px-3 py-1 text-xs font-medium text-[#5f73b7]">
                {t('sharedKnowledgeConversion.preview.branchLabel')}<RawIdentifier value={agentId || '-'} />
              </span>
            </div>
            <div className="mt-4 grid grid-cols-3 gap-2">
              <div className="rounded-lg bg-white p-3 ring-1 ring-[#eef0f4]">
                <strong className="block text-base text-[#18181a]">{knowledgeBase?.document_count || 0}</strong>
                <span className="text-xs text-[#858b9c]">{t('sharedKnowledgeConversion.preview.documents')}</span>
              </div>
              <div className="rounded-lg bg-white p-3 ring-1 ring-[#eef0f4]">
                <strong className="block text-base text-[#18181a]">{knowledgeBase?.bucket_count || 0}</strong>
                <span className="text-xs text-[#858b9c]">{t('sharedKnowledgeConversion.preview.nodes')}</span>
              </div>
              <div className="rounded-lg bg-white p-3 ring-1 ring-[#eef0f4]">
                <strong className="block text-base text-[#18181a]">{knowledgeBase?.chunk_count || 0}</strong>
                <span className="text-xs text-[#858b9c]">{t('sharedKnowledgeConversion.preview.citations')}</span>
              </div>
            </div>
            <p className="mt-4 mb-0 text-xs leading-5 text-[#5d6475]">
              {t('sharedKnowledgeConversion.preview.boundary')}
            </p>
          </section>

          <div className="grid gap-4 md:grid-cols-2">
            <label className="flex flex-col gap-2 text-sm font-medium text-[#464c5e]">
              {t('sharedKnowledgeConversion.field.sourceVersion')}
              <select
                aria-label={t('sharedKnowledgeConversion.field.sourceVersion')}
                className="h-10 rounded-lg border border-[#dfe3ec] bg-white px-3 text-sm outline-none focus:border-[#879ee0]"
                value={sourceVersionId}
                disabled={contextLoading || submitting}
                onChange={(event) => setSourceVersionId(event.target.value)}
              >
                {versions.map((version) => (
                  <option key={version.id} value={version.id}>
                    {t('sharedKnowledgeConversion.field.versionOption', {
                      version: version.version,
                      suffix: version.is_head ? ` · ${t('sharedKnowledgeConversion.field.currentHead')}` : '',
                    })}
                  </option>
                ))}
              </select>
              {selectedVersion ? (
                <span className="text-xs font-normal text-[#858b9c]">
                  {t('sharedKnowledgeConversion.field.updatedAt', { date: selectedVersion.updated_at.slice(0, 10) })}
                </span>
              ) : null}
            </label>
            <label className="flex flex-col gap-2 text-sm font-medium text-[#464c5e]">
              {t('sharedKnowledgeConversion.field.name')}
              <Input
                aria-label={t('sharedKnowledgeConversion.field.name')}
                value={sharedName}
                disabled={submitting}
                onChange={(event) => setSharedName(event.target.value)}
              />
            </label>
          </div>

          <label className="flex flex-col gap-2 text-sm font-medium text-[#464c5e]">
            {t('sharedKnowledgeConversion.field.description')}
            <Textarea
              aria-label={t('sharedKnowledgeConversion.field.description')}
              value={sharedDescription}
              disabled={submitting}
              onChange={(event) => setSharedDescription(event.target.value)}
              placeholder={t('sharedKnowledgeConversion.field.descriptionPlaceholder')}
            />
          </label>

          <label className="flex flex-col gap-2 text-sm font-medium text-[#464c5e]">
            {t('sharedKnowledgeConversion.field.reason')}
            <Textarea
              aria-label={t('sharedKnowledgeConversion.field.reason')}
              value={changeReason}
              disabled={submitting}
              onChange={(event) => setChangeReason(event.target.value)}
              placeholder={t('sharedKnowledgeConversion.field.reasonPlaceholder')}
            />
          </label>

          <section aria-label={t('sharedKnowledgeConversion.binding.label')} className="rounded-xl border border-[#e7eaf1] p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="m-0 text-sm font-medium text-[#18181a]">{t('sharedKnowledgeConversion.binding.title')}</h3>
                <p className="mt-1 mb-0 text-xs text-[#858b9c]">{t('sharedKnowledgeConversion.binding.description')}</p>
              </div>
              <span className="text-xs text-[#858b9c]">{t('sharedKnowledgeConversion.binding.count', { count: selectedTeamIds.length })}</span>
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {teams.map((team) => (
                <label
                  key={team.id}
                  className="flex cursor-pointer items-center gap-3 rounded-lg border border-[#eef0f4] px-3 py-2.5 text-sm text-[#464c5e] hover:bg-[#fafbfc]"
                >
                  <Checkbox
                    aria-label={t('sharedKnowledgeConversion.binding.teamAria', { name: team.name })}
                    checked={selectedTeamIds.includes(team.id)}
                    disabled={submitting}
                    onCheckedChange={(checked) => toggleTeam(team.id, checked === true)}
                  />
                  <span><RawContent value={team.name} /></span>
                </label>
              ))}
              {!contextLoading && teams.length === 0 ? (
                <p className="col-span-full m-0 text-sm text-[#858b9c]">{t('sharedKnowledgeConversion.binding.empty')}</p>
              ) : null}
            </div>
            <label className="mt-4 flex flex-col gap-2 text-sm font-medium text-[#464c5e]">
              {t('sharedKnowledgeConversion.binding.defaultTeam')}
              <select
                aria-label={t('sharedKnowledgeConversion.binding.defaultTeam')}
                className="h-10 rounded-lg border border-[#dfe3ec] bg-white px-3 text-sm outline-none focus:border-[#879ee0]"
                value={defaultTeamId}
                disabled={selectedTeams.length === 0 || submitting}
                onChange={(event) => setDefaultTeamId(event.target.value)}
              >
                <option value="">{t('sharedKnowledgeConversion.binding.defaultUnset')}</option>
                {selectedTeams.map((team) => (
                  <option key={team.id} value={team.id}>{team.name}</option>
                ))}
              </select>
            </label>
          </section>

          {contextLoading ? (
            <p role="status" className="m-0 text-sm text-[#757f9c]">{t('sharedKnowledgeConversion.status.loading')}</p>
          ) : null}
          {submitting ? (
            <p role="status" className="m-0 rounded-lg bg-[#f4f6fb] px-3 py-2 text-sm text-[#5f6d91]">
              {t('sharedKnowledgeConversion.status.submitting')}
            </p>
          ) : null}
          {errorMessage ? (
            <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm leading-6 text-red-700">
              {errorMessage}
            </div>
          ) : null}
          {conversionResult ? (
            <div role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm leading-6 text-emerald-800">
              {t('sharedKnowledgeConversion.status.success', {
                name: conversionResult.new_knowledge_base.name,
                version: conversionResult.released_version.version,
              })}
            </div>
          ) : null}

          <div className="flex justify-end gap-2 border-t border-[#eef0f4] pt-4">
            <Button variant="outline" disabled={submitting} onClick={onClose}>{t('common.action.cancel')}</Button>
            <Button disabled={!canSubmit} onClick={() => void submitConversion()}>
              {submitting ? t('sharedKnowledgeConversion.actions.converting') : t('sharedKnowledgeConversion.actions.confirm')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
