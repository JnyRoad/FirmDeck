/**
 * 知识库管理 · 详情页「群组与权限」Tab（US4，FR-060–FR-062）：展示已绑定该共享库的
 * 群组卡片（成员数、默认写入徽章、设为默认写入、解绑二次确认并说明会撤销授权）；
 * 每个群组复用 `TeamKnowledgePermissionMatrix` 渲染成员权限矩阵（含批量设置：全部
 * 只读 / 全部可编辑 / 全部撤销），保存携带 `expected_revision` 乐观锁，修订冲突时
 * 提示刷新并重新加载；底部提供绑定新群组（候选来自
 * `listBindableTeams(exclude_bound_to)`，绑定后成员默认未授权，后端绑定时不预置
 * 任何授权行）。
 *
 * 「已绑定群组」集合的取得方式：contracts A6 只提供"可绑定候选"（排除对本库已有活跃
 * 绑定的群组），没有反向的"本库当前绑定了哪些群组"端点。这里用
 * `listBindableTeams({})`（全部活跃群组）与 `listBindableTeams({excludeBoundTo: kb.id})`
 * （未绑定候选）做差集得到已绑定群组 id 集合，再用既有的 `listTeamBindings(teamId)`
 * 逐个取该群组在本库的完整绑定记录（修订号、当前授权矩阵）。群组成员名册（矩阵展示
 * 未授权成员必需，`grants[]` 只含已生效授权行，不含未设置权限的成员）复用团队详情页
 * 同款 `GET /teams/{team_id}` 端点——不在 `api/knowledgeAdmin.ts` 的六个契约函数范围
 * 内，因此直接用 `createTenantClient`（与 `TeamDetailPage.tsx` 读取团队详情的方式一致）。
 */
import { useEffect, useMemo, useState } from 'react';

import { createTenantClient } from '@/api/tenant-client';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import TeamKnowledgePermissionMatrix from '@/components/knowledge/TeamKnowledgePermissionMatrix';
import { Button } from '@/components/ui/button';
import { useTenantSession } from '@/contexts/TenantSessionContext';
import { useAppIntl } from '@/i18n';
import { createMessageDescriptor } from '@/i18n/descriptors';
import { RawIdentifier } from '@/i18n/RawContent';
import { apiErrorCode } from '@/lib/apiErrorMessages';
import type { KnowledgeAdminApi } from '@/api/knowledgeAdmin';
import type {
  KnowledgeBaseRead,
  TeamKnowledgeBindingRead,
  TeamKnowledgeGrantInput,
  TeamMemberRead,
  TeamRead,
} from '@/types';
import type { KnowledgeAdminTeamOption } from '@/types/knowledgeAdmin';

import { useKnowledgeAdminToast } from './errorMessage';
import { useGuardedLoad } from './useGuardedLoad';

export type GrantsTabProps = {
  api: KnowledgeAdminApi;
  kb: KnowledgeBaseRead;
};

/** 一张已绑定群组卡片需要的全部数据：候选项里的基础信息、本库绑定记录、当前成员名册。 */
type BoundTeamRow = {
  team: KnowledgeAdminTeamOption;
  binding: TeamKnowledgeBindingRead;
  members: TeamMemberRead[];
};

export function GrantsTab({ api, kb }: GrantsTabProps) {
  const { t } = useAppIntl();
  // 统一 toast 出口（I12）：把错误值本身交给 `toast.error(error, fallbackId)`，让已注册的
  // 后端错误码先经 `backendErrorMessageDescriptor` 命中契约文案；之前这里直接用
  // `createToastNotifier` + 裸 `catch {}`，错误对象被整个丢掉，所有失败都退化成同一句
  // 泛化提示——正是 `shared/errorMessage.ts` 要消除的那种降级。
  const toast = useKnowledgeAdminToast();
  // 过期响应护栏（I1）：绑定卡片加载的请求序号 + 租户代际。
  const listLoad = useGuardedLoad();
  const tenantContext = useTenantSession();
  const tenantClient = useMemo(() => createTenantClient(tenantContext), [tenantContext]);

  const [loading, setLoading] = useState(false);
  const [boundRows, setBoundRows] = useState<BoundTeamRow[]>([]);
  const [candidateTeams, setCandidateTeams] = useState<KnowledgeAdminTeamOption[]>([]);
  const [busyTeamIds, setBusyTeamIds] = useState<Set<string>>(new Set());

  const [selectedTeamId, setSelectedTeamId] = useState('');
  const [bindInProgress, setBindInProgress] = useState(false);

  const [unbindTarget, setUnbindTarget] = useState<{
    team: KnowledgeAdminTeamOption;
    binding: TeamKnowledgeBindingRead;
  } | null>(null);
  const [unbinding, setUnbinding] = useState(false);

  /** 拉取一个已绑定群组在本库的完整绑定记录与当前成员名册；本库没有活跃绑定时返回 null。 */
  async function loadBoundTeamRow(team: KnowledgeAdminTeamOption): Promise<BoundTeamRow | null> {
    const [bindings, teamDetail] = await Promise.all([
      api.listTeamBindings(team.id),
      tenantClient.get<TeamRead>(`/api/enterprise/teams/${team.id}`),
    ]);
    const binding = bindings.find((row) => row.knowledge_base_id === kb.id && row.status === 'active');
    if (!binding) return null;
    return { team, binding, members: teamDetail.members };
  }

  /** 重新加载已绑定群组卡片与可绑定候选；已绑定集合见文件头注释的差集算法。 */
  async function load() {
    const token = listLoad.begin();
    setLoading(true);
    try {
      const [allTeams, candidates] = await Promise.all([
        api.listBindableTeams({}),
        api.listBindableTeams({ excludeBoundTo: kb.id }),
      ]);
      const candidateIds = new Set(candidates.map((team) => team.id));
      const boundTeamOptions = allTeams.filter((team) => !candidateIds.has(team.id));
      // `allSettled` 而不是 `all`：单个群组的绑定/名册查询失败（成员接口 500、群组刚被
      // 删掉）不该把整个「群组与权限」页打成加载失败——其余群组的权限矩阵照常可用。
      // 失败的那些只是不出现在列表里，并统一提示一次。
      const settled = await Promise.allSettled(boundTeamOptions.map((team) => loadBoundTeamRow(team)));
      // 过期响应（重复刷新交错、租户代际已变）整个丢弃，见 useGuardedLoad（I1）。
      if (!listLoad.isCurrent(token)) return;
      setBoundRows(settled.flatMap((result) => (
        result.status === 'fulfilled' && result.value !== null ? [result.value] : []
      )));
      setCandidateTeams(candidates);
      if (settled.some((result) => result.status === 'rejected')) {
        toast.errorDescriptor(createMessageDescriptor('knowledgeAdmin.grants.toast.partialLoadFailed'));
      }
    } catch (error) {
      if (!listLoad.isCurrent(token)) return;
      toast.error(error, 'knowledgeAdmin.grants.toast.loadFailed');
    } finally {
      if (listLoad.isCurrent(token)) setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // 只在 api 实例（租户上下文）或知识库切换时重新加载。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, kb.id]);

  /** 在一个群组的忙碌集合里包裹一次异步操作，操作期间该群组卡片按钮禁用。 */
  async function withTeamBusy<T>(teamId: string, run: () => Promise<T>): Promise<T> {
    setBusyTeamIds((current) => new Set(current).add(teamId));
    try {
      return await run();
    } finally {
      setBusyTeamIds((current) => {
        const next = new Set(current);
        next.delete(teamId);
        return next;
      });
    }
  }

  /** 修订冲突时的统一处理：提示管理员刷新后重试，并重新加载最新绑定状态。 */
  async function handleRevisionConflict() {
    // 修订冲突有专属措辞（比契约默认文案更贴合"刷新后重试"的操作指引），走 errorDescriptor。
    toast.errorDescriptor(createMessageDescriptor('knowledgeAdmin.grants.toast.revisionConflict'));
    await load();
  }

  /** 保存一个群组在本库的成员权限矩阵；批量设置只改本地状态，这里才是真正落库的动作。 */
  async function saveGrants(
    team: KnowledgeAdminTeamOption,
    binding: TeamKnowledgeBindingRead,
    grants: TeamKnowledgeGrantInput[],
  ) {
    try {
      await withTeamBusy(team.id, () => api.saveGrants(team.id, kb.id, {
        expectedRevision: binding.revision,
        grants,
      }));
      toast.success(createMessageDescriptor('knowledgeAdmin.grants.toast.saveSuccess'));
      await load();
    } catch (error) {
      if (apiErrorCode(error) === 'KNOWLEDGE_BINDING_REVISION_CONFLICT') {
        await handleRevisionConflict();
      } else {
        toast.error(error, 'knowledgeAdmin.grants.toast.saveFailed');
      }
    }
  }

  /** 把一个群组设为本库的默认写入目标。 */
  async function setDefault(team: KnowledgeAdminTeamOption, binding: TeamKnowledgeBindingRead) {
    try {
      await withTeamBusy(team.id, () => api.setDefaultBinding(team.id, kb.id, {
        expectedRevision: binding.revision,
      }));
      toast.success(createMessageDescriptor('knowledgeAdmin.grants.toast.setDefaultSuccess'));
      await load();
    } catch (error) {
      if (apiErrorCode(error) === 'KNOWLEDGE_BINDING_REVISION_CONFLICT') {
        await handleRevisionConflict();
      } else {
        toast.error(error, 'knowledgeAdmin.grants.toast.setDefaultFailed');
      }
    }
  }

  /** 确认解绑：撤销该群组在本库的全部授权，并清除指向本库的默认写入指针（后端事务保证）。 */
  async function confirmUnbind() {
    if (!unbindTarget) return;
    const { team, binding } = unbindTarget;
    setUnbinding(true);
    try {
      await api.unbindTeam(team.id, kb.id, { expectedRevision: binding.revision });
      toast.success(createMessageDescriptor('knowledgeAdmin.grants.toast.unbindSuccess'));
      setUnbindTarget(null);
      await load();
    } catch (error) {
      if (apiErrorCode(error) === 'KNOWLEDGE_BINDING_REVISION_CONFLICT') {
        setUnbindTarget(null);
        await handleRevisionConflict();
      } else {
        toast.error(error, 'knowledgeAdmin.grants.toast.unbindFailed');
      }
    } finally {
      setUnbinding(false);
    }
  }

  /** 绑定一个候选群组；成员默认未授权——后端创建绑定时不预置任何授权行。 */
  async function bindTeam() {
    if (!selectedTeamId) return;
    setBindInProgress(true);
    try {
      await api.bindTeam(selectedTeamId, { existingKnowledgeBaseId: kb.id });
      toast.success(createMessageDescriptor('knowledgeAdmin.grants.toast.bindSuccess'));
      setSelectedTeamId('');
      await load();
    } catch (error) {
      toast.error(error, 'knowledgeAdmin.grants.toast.bindFailed');
    } finally {
      setBindInProgress(false);
    }
  }

  return (
    <div className="flex flex-col gap-[20px]">
      <section aria-label={t('knowledgeAdmin.grants.boundSection.title')}>
        <h2 className="text-[14px] font-semibold text-[#18181a]">{t('knowledgeAdmin.grants.boundSection.title')}</h2>
        {loading ? (
          <p className="mt-[12px] text-[12px] text-[#858b9c]">{t('knowledgeAdmin.grants.loading')}</p>
        ) : boundRows.length === 0 ? (
          <p className="mt-[12px] rounded-[12px] bg-[#fafbfd] py-[18px] text-center text-[12px] text-[#a7adbb]">
            {t('knowledgeAdmin.grants.boundSection.empty')}
          </p>
        ) : (
          <div className="mt-[12px] flex flex-col gap-[14px]">
            {boundRows.map((row) => (
              <section
                key={row.team.id}
                aria-label={t('knowledgeAdmin.grants.boundTeam.cardLabel', { teamName: row.team.name })}
                className="flex flex-col gap-[8px]"
              >
                <div className="flex items-center justify-between gap-[8px]">
                  <h3 className="text-[13px] font-medium text-[#18181a]"><RawIdentifier value={row.team.name} /></h3>
                  <span className="text-[12px] text-[#858b9c]">
                    {t('knowledgeAdmin.grants.memberCount', { count: row.members.length })}
                  </span>
                </div>
                <TeamKnowledgePermissionMatrix
                  binding={row.binding}
                  members={row.members}
                  busy={busyTeamIds.has(row.team.id)}
                  showBulkActions
                  onSave={(binding, grants) => saveGrants(row.team, binding, grants)}
                  onSetDefault={(binding) => setDefault(row.team, binding)}
                  onRemove={async (binding) => setUnbindTarget({ team: row.team, binding })}
                />
              </section>
            ))}
          </div>
        )}
      </section>

      <section
        aria-label={t('knowledgeAdmin.grants.bindSection.title')}
        className="rounded-[14px] border-[0.5px] border-[#e3e7f1] bg-white p-[16px]"
      >
        <h2 className="text-[14px] font-semibold text-[#18181a]">{t('knowledgeAdmin.grants.bindSection.title')}</h2>
        <div className="mt-[10px] flex flex-wrap items-center gap-[8px]">
          <select
            aria-label={t('knowledgeAdmin.grants.bindSection.selectLabel')}
            value={selectedTeamId}
            disabled={bindInProgress || candidateTeams.length === 0}
            onChange={(event) => setSelectedTeamId(event.target.value)}
            className="h-[34px] min-w-[200px] rounded-[9px] border border-[#dfe4ed] bg-white px-[9px] text-[12px] text-[#464c5e]"
          >
            <option value="">{t('knowledgeAdmin.grants.bindSection.selectPlaceholder')}</option>
            {candidateTeams.map((team) => (
              // 群组名是自由文本：`<option>` 里不能嵌 `RawIdentifier`（会破坏原生下拉），
              // 改在元素本身上标 `translate="no"`，与其它位置的 raw 包裹口径一致（I9）。
              <option key={team.id} value={team.id} translate="no">{team.name}</option>
            ))}
          </select>
          <Button
            type="button"
            disabled={!selectedTeamId || bindInProgress}
            onClick={() => void bindTeam()}
            className="h-[34px] rounded-[9px] bg-[#18181a] px-[14px] text-[12px] text-white"
          >
            {bindInProgress
              ? t('knowledgeAdmin.grants.bindSection.binding')
              : t('knowledgeAdmin.grants.bindSection.bindButton')}
          </Button>
        </div>
        {!loading && candidateTeams.length === 0 && (
          <p className="mt-[8px] text-[12px] text-[#a7adbb]">{t('knowledgeAdmin.grants.bindSection.empty')}</p>
        )}
      </section>

      <ConfirmDialog
        open={Boolean(unbindTarget)}
        onOpenChange={(open) => { if (!open && !unbinding) setUnbindTarget(null); }}
        title={unbindTarget
          ? t('knowledgeAdmin.grants.unbindDialog.title', { teamName: unbindTarget.team.name })
          : ''}
        description={t('knowledgeAdmin.grants.unbindDialog.description')}
        confirmText={t('knowledgeAdmin.grants.unbindDialog.confirm')}
        cancelText={t('knowledgeAdmin.grants.unbindDialog.cancel')}
        destructive
        loading={unbinding}
        onConfirm={() => void confirmUnbind()}
      />
    </div>
  );
}
