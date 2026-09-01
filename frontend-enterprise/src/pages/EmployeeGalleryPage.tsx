import { UnderlineTabs, type UnderlineTabItem } from '@/components/ui';
import { notify } from '@/components/ui/app-toast';
import { RawContent } from '@/i18n/RawContent';
import { useAppIntl } from '@/i18n/useAppIntl';
import { apiErrorMessage } from '@/lib/apiErrorMessages';

import IconSearch from '../assets/icons/search.svg?react';

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { createTenantClient } from '../api/tenant-client';
import { isGalleryEmployee, type EnterpriseAuthUser } from '../auth';
import { useTenantSession } from '../contexts/TenantSessionContext';

import AppHeader from '../components/AppHeader';
import { ConfirmDialog } from '../components/ConfirmDialog';
import EmployeeAvatarEditor from '../components/EmployeeAvatarEditor';
import EmployeeCard from '../components/EmployeeCard';
import EmployeeProfileEditor from '../components/EmployeeProfileEditor';
import TeamCard, { teamLeader } from '../components/TeamCard';
import {
  canManageEmployeeAgent,
  employeeDisplayName,
  employeeDisplayNameWithCreator,
  employeeProfile,
  isMyEmployeeAgent,
  visibleEmployeeAgents,
} from '../employee';
import { clearSharedAgentScope, persistSharedAgentScope, readEmployeeScope } from '../lib/agent-scope-storage';
import type { AgentProfileRead, TeamRead } from '../types';

type GalleryScope = 'all' | 'mine' | 'teams' | 'gallery';

/** 统一把未知异常折叠为安全语义文案，避免把 Error.message 直接暴露到最终 UI。 */
function galleryErrorMessage(error: unknown, fallback: string): string {
  const message = apiErrorMessage(error, 'common.error.generic');
  return message === '发生错误，请稍后重试' || message === 'Something went wrong. Please try again later.'
    ? fallback
    : message;
}

export default function EmployeeGalleryPage({
  currentUser,
  isAdmin = false,
  onStartChat,
  onLogout,
}: {
  currentUser?: EnterpriseAuthUser;
  isAdmin?: boolean;
  onStartChat?: (agent: AgentProfileRead) => void | Promise<void>;
  onLogout?: () => void;
}) {
  const { t } = useAppIntl();
  const tenantContext = useTenantSession();
  const tenantApi = useMemo(() => createTenantClient(tenantContext), [tenantContext]);
  const [agents, setAgents] = useState<AgentProfileRead[]>([]);
  const [teams, setTeams] = useState<TeamRead[]>([]);
  const [teamsLoadFailed, setTeamsLoadFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [avatarAgent, setAvatarAgent] = useState<AgentProfileRead | null>(null);
  const [profileAgent, setProfileAgent] = useState<AgentProfileRead | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AgentProfileRead | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [startingAgentId, setStartingAgentId] = useState<string | null>(null);
  const [startingTeamId, setStartingTeamId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [scope, setScope] = useState<GalleryScope>('all');
  const navigate = useNavigate();

  async function load() {
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return;
    setLoading(true);
    try {
      const rows = await tenantApi.get<AgentProfileRead[]>('/api/enterprise/agents');
      if (!context.isCurrentGeneration(generation)) return;
      setAgents(rows);
    } catch (error) {
      if (!context.isCurrentGeneration(generation)) return;
      notify.error(galleryErrorMessage(error, t('employeeGalleryPage.toast.loadEmployeesFailed')));
    } finally {
      if (context.isCurrentGeneration(generation)) setLoading(false);
    }
  }

  async function loadTeams() {
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return;
    try {
      const rows = await tenantApi.get<TeamRead[]>('/api/enterprise/teams');
      if (!context.isCurrentGeneration(generation)) return;
      setTeams(rows);
      setTeamsLoadFailed(false);
    } catch (error) {
      if (!context.isCurrentGeneration(generation)) return;
      setTeamsLoadFailed(true);
      notify.error(galleryErrorMessage(error, t('employeeGalleryPage.toast.loadTeamsFailed')));
    }
  }

  useEffect(() => {
    void load();
    void loadTeams();
  }, [tenantApi]);

  useEffect(() => {
    setDeleting(false);
    setStartingAgentId(null);
    setStartingTeamId(null);
  }, [tenantContext?.generation]);

  // Clear tenant-A records and editor state while the replacement tenant is
  // still being verified by TenantSessionProvider.
  useEffect(() => {
    if (tenantContext) return;
    setAgents([]);
    setTeams([]);
    setTeamsLoadFailed(false);
    setAvatarAgent(null);
    setProfileAgent(null);
    setDeleteTarget(null);
    setLoading(false);
  }, [tenantContext]);

  // Keep these tabs aligned with the rest of the app:
  // - 所有员工: employees the current user can access and chat with
  // - 我的数字员工: employees the current user can manage/edit
  // - 团队对话: teams the backend has authorized for the current tenant
  // - 数字员工广场: public employees not already listed as mine
  const availableAgents = useMemo(
    () => visibleEmployeeAgents(agents, currentUser, { activeOnly: true }),
    [agents, currentUser],
  );
  const myEmployees = useMemo(
    () => availableAgents.filter((item) => isMyEmployeeAgent(item, currentUser)),
    [availableAgents, currentUser],
  );
  const galleryEmployees = useMemo(() => {
    const myIds = new Set(myEmployees.map((item) => item.id));
    return availableAgents.filter((item) => isGalleryEmployee(item) && !myIds.has(item.id));
  }, [availableAgents, myEmployees]);

  const scopedEmployees = scope === 'mine'
    ? myEmployees
    : scope === 'gallery'
      ? galleryEmployees
      : availableAgents;

  const filteredEmployees = scopedEmployees.filter((item) => {
    const profile = employeeProfile(item);
    const keyword = searchTerm.trim().toLowerCase();
    if (!keyword) return true;
    return [
      employeeDisplayName(item),
      employeeDisplayNameWithCreator(item),
      profile.roleName,
      item.description || '',
      profile.workStyles.join(' '),
      profile.expertiseTags.join(' '),
    ].some((value) => value.toLowerCase().includes(keyword));
  });

  const filteredTeams = teams.filter((team) => {
    const keyword = searchTerm.trim().toLowerCase();
    if (!keyword) return true;
    return [
      team.name,
      team.description || '',
      teamLeader(team)?.agent_name || '',
    ].some((value) => value.toLowerCase().includes(keyword));
  });

  async function startEmployeeChat(row: AgentProfileRead) {
    if (startingAgentId) return;
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return;
    setStartingAgentId(row.id);
    try {
      if (onStartChat) {
        await onStartChat(row);
        if (!context.isCurrentGeneration(generation)) return;
        return;
      }
      if (!context.isCurrentGeneration(generation)) return;
      navigate(`/workspace/chat/draft/${row.id}`);
    } catch (error) {
      if (!context.isCurrentGeneration(generation)) return;
      notify.error(galleryErrorMessage(error, t('employeeGalleryPage.toast.startChatFailed')));
    } finally {
      if (context.isCurrentGeneration(generation)) setStartingAgentId(null);
    }
  }

  async function startTeamChat(team: TeamRead) {
    if (startingTeamId) return;
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return;
    setStartingTeamId(team.id);
    try {
      const result = await tenantApi.post<{ session_id: string }>(
        `/api/enterprise/teams/${team.id}/tl/session`,
      );
      if (!context.isCurrentGeneration(generation)) return;
      if (!result.session_id) throw new Error(t('employeeGalleryPage.error.missingTeamSession'));
      navigate(`/workspace/chat/${result.session_id}`);
    } catch (error) {
      if (!context.isCurrentGeneration(generation)) return;
      notify.error(galleryErrorMessage(error, t('employeeGalleryPage.toast.startTeamChatFailed')));
    } finally {
      if (context.isCurrentGeneration(generation)) setStartingTeamId(null);
    }
  }

  async function updateStatus(row: AgentProfileRead, status: 'active' | 'archived') {
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return;
    try {
      await tenantApi.put<AgentProfileRead>(`/api/enterprise/agents/${row.id}`, {
        status,
        metadata: row.metadata || {},
      });
      if (!context.isCurrentGeneration(generation)) return;
      notify.success(
        status === 'active'
          ? t('employeeGalleryPage.toast.published')
          : t('employeeGalleryPage.toast.archived'),
      );
      await load();
      window.dispatchEvent(new Event('ultrarag-enterprise-agent-scope-refresh'));
    } catch (error) {
      if (!context.isCurrentGeneration(generation)) return;
      notify.error(galleryErrorMessage(error, t('employeeGalleryPage.toast.updateStatusFailed')));
    }
  }

  async function updateGalleryState(row: AgentProfileRead, published: boolean) {
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return;
    try {
      const metadata: Record<string, unknown> = {
        ...(row.metadata || {}),
        published_to_gallery: published,
        gallery_published_at: published ? new Date().toISOString() : undefined,
        gallery_published_by: published ? currentUser?.username : undefined,
      };
      if (published) {
        delete metadata.gallery_unpublished_at;
        delete metadata.gallery_unpublished_by;
      }
      await tenantApi.put<AgentProfileRead>(`/api/enterprise/agents/${row.id}`, {
        metadata,
      });
      if (!context.isCurrentGeneration(generation)) return;
      notify.success(
        published
          ? t('employeeGalleryPage.toast.marketplacePublished')
          : t('employeeGalleryPage.toast.marketplaceUnpublished'),
      );
      await load();
      window.dispatchEvent(new Event('ultrarag-enterprise-agent-scope-refresh'));
    } catch (error) {
      if (!context.isCurrentGeneration(generation)) return;
      notify.error(galleryErrorMessage(error, t('employeeGalleryPage.toast.updateGalleryFailed')));
    }
  }

  async function confirmDelete() {
    const row = deleteTarget;
    if (!row) return;
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return;
    setDeleting(true);
    try {
      await tenantApi.delete(`/api/enterprise/agents/${row.id}`);
      if (!context.isCurrentGeneration(generation)) return;
      if (readEmployeeScope(context.tenantId, context.userId) === row.id) {
        const nextAgent = availableAgents.find((item) => item.id !== row.id && item.status === 'active')
          || availableAgents.find((item) => item.id !== row.id);
        if (nextAgent) {
          persistSharedAgentScope(nextAgent.id, context.tenantId, context.userId);
          window.dispatchEvent(new CustomEvent('ultrarag-enterprise-agent-scope-change', { detail: { agentId: nextAgent.id } }));
        } else {
          clearSharedAgentScope(context.tenantId, context.userId);
          window.dispatchEvent(new CustomEvent('ultrarag-enterprise-agent-scope-change', { detail: { agentId: '' } }));
        }
      }
      notify.success(t('employeeGalleryPage.toast.deleted'));
      setDeleteTarget(null);
      await load();
      window.dispatchEvent(new Event('ultrarag-enterprise-agent-scope-refresh'));
    } catch (error) {
      if (!context.isCurrentGeneration(generation)) return;
      notify.error(galleryErrorMessage(error, t('employeeGalleryPage.toast.deleteFailed')));
    } finally {
      if (context.isCurrentGeneration(generation)) setDeleting(false);
    }
  }

  function updateAgentInList(row: AgentProfileRead) {
    setAgents((current) => current.map((item) => (item.id === row.id ? row : item)));
  }

  const galleryTabs: UnderlineTabItem<GalleryScope>[] = [
    { value: 'all', label: t('employeeGalleryPage.tabs.all') },
    { value: 'mine', label: t('employeeGalleryPage.tabs.mine') },
    { value: 'teams', label: t('employeeGalleryPage.tabs.teams') },
    { value: 'gallery', label: t('employeeGalleryPage.tabs.gallery') },
  ];

  function changeScope(nextScope: GalleryScope) {
    setScope(nextScope);
    if (nextScope === 'teams' && teamsLoadFailed) {
      void loadTeams();
    }
  }

  const hasSearchTerm = Boolean(searchTerm.trim());
  const emptyText = hasSearchTerm
    ? t('employeeGalleryPage.empty.filtered.title')
    : t('employeeGalleryPage.empty.default.title');
  const emptyDescription = hasSearchTerm
    ? t('employeeGalleryPage.empty.filtered.description')
    : t('employeeGalleryPage.empty.default.description');
  const teamsEmptyText = hasSearchTerm
    ? t('employeeGalleryPage.empty.teamsFiltered.title')
    : t('employeeGalleryPage.empty.teams.title');
  const teamsEmptyDescription = hasSearchTerm
    ? t('employeeGalleryPage.empty.teamsFiltered.description')
    : t('employeeGalleryPage.empty.teams.description');

  return (
    <div className="min-h-full box-border px-[48px] pt-[32px] pb-[43px] max-[900px]:px-[16px]" aria-busy={loading}>
      <AppHeader
        onLogout={onLogout}
        userName={currentUser?.username}
        left={(
          <div className="flex h-[50px] w-full items-center gap-[6px] rounded-[20px] bg-white px-[20px] text-[#757F9C] shadow-[0_0_6px_rgba(0,0,0,0.05)]">
            <IconSearch className="size-[20px] shrink-0" />
            <input
              autoComplete="off"
              data-1p-ignore="true"
              data-lpignore="true"
              data-bwignore="true"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder={t('employeeGalleryPage.search.placeholder')}
              aria-label={t('employeeGalleryPage.search.label')}
              className="min-w-0 flex-1 border-0 bg-transparent text-[14px] text-[#18181A] outline-none placeholder:text-[#757F9C]"
            />
          </div>
        )}
      />

      <UnderlineTabs
        className="mt-[36px] mb-[16px] w-full max-w-[680px]"
        aria-label={t('employeeGalleryPage.tabs.ariaLabel')}
        value={scope}
        onChange={changeScope}
        items={galleryTabs}
        tabClassName="min-w-max flex-1 px-[12px] max-[560px]:px-[8px] max-[560px]:text-[12px]"
      />

      {scope === 'teams' ? (
        <section aria-label={t('employeeGalleryPage.teams.sectionLabel')}>
          <div className="grid grid-cols-1 content-start gap-[32px] sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 max-[900px]:gap-[18px]">
            {filteredTeams.map((team) => (
              <TeamCard
                key={team.id}
                team={team}
                agents={agents}
                busy={startingTeamId === team.id}
                onOpen={() => void startTeamChat(team)}
              />
            ))}
            {!filteredTeams.length && (
              <EmployeeGalleryEmptyState title={teamsEmptyText} description={teamsEmptyDescription} />
            )}
          </div>
        </section>
      ) : (
        <div className="grid auto-rows-[minmax(262px,auto)] grid-cols-1 content-start gap-[32px] sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 max-[900px]:gap-[18px]">
          {filteredEmployees.map((employee) => (
            <EmployeeCard
              key={employee.id}
              employee={employee}
              busy={startingAgentId === employee.id}
              canManage={canManageEmployeeAgent(employee, currentUser)}
              showMenu={false}
              onOpen={() => void startEmployeeChat(employee)}
              onStatus={(status) => void updateStatus(employee, status)}
              onGallery={(published) => void updateGalleryState(employee, published)}
              onDelete={() => setDeleteTarget(employee)}
              onAvatar={() => setAvatarAgent(employee)}
              onEdit={() => setProfileAgent(employee)}
              onChat={() => void startEmployeeChat(employee)}
            />
          ))}
          {!filteredEmployees.length && (
            <EmployeeGalleryEmptyState title={emptyText} description={emptyDescription} />
          )}
        </div>
      )}

      <EmployeeAvatarEditor
        agent={avatarAgent}
        open={Boolean(avatarAgent)}
        onClose={() => setAvatarAgent(null)}
        onSaved={updateAgentInList}
      />
      <EmployeeProfileEditor
        agent={profileAgent}
        open={Boolean(profileAgent)}
        currentUser={currentUser}
        onClose={() => setProfileAgent(null)}
        onSaved={updateAgentInList}
      />
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        loading={deleting}
        title={deleteTarget ? (
          <>
            {t('employeeGalleryPage.dialog.delete.titlePrefix')}
            <RawContent value={employeeDisplayName(deleteTarget)} />
            {t('employeeGalleryPage.dialog.delete.titleSuffix')}
          </>
        ) : ''}
        description={t('employeeGalleryPage.dialog.delete.description')}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}

function EmployeeGalleryEmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="flex h-[262px] w-full items-center justify-center rounded-[20px] border border-dashed border-[#e4e9f2] bg-[#fbfcfe] px-[24px] text-center">
      <div className="flex max-w-[210px] flex-col items-center">
        <span className="grid size-[34px] place-items-center rounded-[12px] bg-white text-[#98a2b3] shadow-[0_1px_8px_rgba(70,76,94,0.06)] ring-1 ring-[#edf1f6]">
          <IconSearch className="size-[16px] shrink-0" />
        </span>
        <p className="mt-[12px] text-[14px] font-medium leading-[20px] text-[#7f879a]">
          {title}
        </p>
        <p className="mt-[4px] text-[11px] leading-[17px] text-[#a7adbb]">
          {description}
        </p>
      </div>
    </div>
  );
}
