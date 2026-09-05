import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { createTenantClient } from "./api/tenant-client";
import {
  clearEnterpriseAuthSession,
  getEnterpriseAuthSession,
  isEnterpriseAdmin,
  isGalleryEmployee,
  type EnterpriseAuthSession,
} from "./auth";
import {
  TenantSessionProvider,
  useTenantSession,
  useTenantSessionVerification,
} from "./contexts/TenantSessionContext";
import AppSidebar from "./components/AppSidebar";
import OnboardingGuide, { ONBOARDING_SEEN_KEY } from "./components/OnboardingGuide";
import QuickStartGuide, {
  QUICK_START_COMPLETED_EVENT,
  QUICK_START_SEEN_KEY,
} from "./components/QuickStartGuide";
import UpdateReminder from "./components/UpdateReminder";
import StaffdeckIcon from "./components/StaffdeckIcon";
import { SidebarProvider } from "@/components/ui/sidebar";
import { EnterpriseRoute } from "./enums/routes";
import {
  employeeBlankMetadata,
  canAccessEmployeeAgent,
  canManageEmployeeAgent,
  canSelectCurrentEmployeeAgent,
  employeeDisplayName,
  employeeDisplayNameWithCreator,
  employeeProfile,
  preferredEmployeeAgent,
} from "./employee";
import AccountsPage from "./pages/AccountsPage";
import AgentsPage from "./pages/AgentsPage";
import ChannelsPage from "./pages/ChannelsPage";
import ChatPage from "./pages/chat/ChatPage";
import ChatGalleryPage from "./pages/chat/ChatGalleryPage";
import ChangePasswordPage, { type PasswordPolicy } from "./pages/ChangePasswordPage";
import DashboardPage from "./pages/dashboard/DashboardPage";
import EmptyEmployeeState from "./components/EmptyEmployeeState";
import DistillPage from "./pages/DistillPage";
import GeneralSkillsPage, {
  GeneralSkillEditPage,
  GeneralSkillNewPage,
} from "./pages/GeneralSkillsPage";
import KnowledgeManagePage, { KnowledgeAddPage } from "./pages/KnowledgePage";
import KnowledgeAdminListPage from "./pages/knowledge-admin/KnowledgeAdminListPage";
import KnowledgeAdminDetailPage from "./pages/knowledge-admin/KnowledgeAdminDetailPage";
import LoginPage from "./pages/LoginPage";
import ModelsPage from "./pages/ModelsPage";
import RuntimeSettingsPage from "./pages/RuntimeSettingsPage";
import OpenPlatformPage from "./pages/OpenPlatformPage";
import PersonaPage from "./pages/PersonaPage";
import SkillsPage from "./pages/SkillsPage";
import SystemApp from "./SystemApp";
import TeamChatPage from "./pages/TeamChatPage";
import TeamDetailPage from "./pages/TeamDetailPage";
import TeamsPage from "./pages/TeamsPage";
import {
  ScheduledTaskEditPage,
  ScheduledTaskNewPage,
} from "./pages/dashboard/ScheduledTasksTab";
import ToolsPage, {
  McpServerEditPage,
  McpServerNewPage,
  ToolEditPage,
  ToolNewPage,
  ToolTestPage,
} from "./pages/ToolsPage";
import { useIsMobile } from "./hooks/use-mobile";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  Input,
  Select as UISelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@/components/ui";
import { Button as UIButton } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { notify } from "@/components/ui/app-toast";
import {
  emitAgentScopeChange,
  isTeamScope,
  persistSharedAgentScope,
  teamIdFromScope,
  toTeamScope,
} from "@/lib/agent-scope-storage";
import { tenantUserStorageKey } from "@/lib/tenant-storage";
import { cn } from "@/lib/utils";
import {
  SELECT_TRIGGER_CLASS,
  DIALOG_CANCEL_BUTTON_CLASS,
  DIALOG_FOOTER_CLASS,
  DIALOG_PRIMARY_BUTTON_CLASS,
} from "@/lib/enterprise-ui";
import type { AgentProfileRead, ModelConfigRead, TeamRead } from "./types";
import { useAppIntl } from "./i18n/useAppIntl";

const ENTERPRISE_SIDEBAR_STORAGE_KEY = "ultrarag_enterprise_sidebar_expanded";
const MODEL_CONFIGS_UPDATED_EVENT = "ultrarag-enterprise-model-configs-updated";

/**
 * Path-segment-aware prefix match.
 *
 * A plain `pathname.startsWith(prefix)` treats `/enterprise/knowledge-admin` as living
 * under `/enterprise/knowledge`, which made the admin console (a) inherit the
 * employee-scoped empty state (`EMPLOYEE_SCOPED_PREFIXES` below) and disappear whenever
 * the tenant had no employees, and (b) highlight the "knowledge base" sidebar entry
 * instead of its own. Matching only on a full segment boundary fixes both at the source.
 */
function matchesRoutePrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** 读取当前 tenant/user 的完整员工或团队作用域，不读取旧的全局存储键。 */
function readStoredAgentScope(tenantId: string, userId: string): string {
  if (!tenantId || !userId) return "";
  try {
    return window.localStorage.getItem(
      tenantUserStorageKey(tenantId, userId, "selected-agent"),
    ) || "";
  } catch {
    return "";
  }
}
type AgentCreateMode = "copy" | "blank";

type AgentCreateFormState = {
  name: string;
  description: string;
  roleName: string;
  sourceMode: AgentCreateMode;
  copyFromAgentId: string;
};

const EMPTY_AGENT_FORM: AgentCreateFormState = {
  name: "",
  description: "",
  roleName: "",
  sourceMode: "copy",
  copyFromAgentId: "",
};

/** 组合认证后的应用壳、导航和共享创建流程，并直接消费语义消息运行时。 */
function Shell({
  auth,
  onLogout,
  guidesCompleted,
}: {
  auth: EnterpriseAuthSession;
  onLogout: () => void;
  guidesCompleted: boolean;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useAppIntl();
  const tenantContext = useTenantSession();
  const tenantApi = useMemo(() => createTenantClient(tenantContext), [tenantContext]);
  const tenantId = tenantContext?.tenantId || auth.tenant.id;
  const userId = tenantContext?.userId || auth.user.id;
  const [agents, setAgents] = useState<AgentProfileRead[]>([]);
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  const [scopeTeams, setScopeTeams] = useState<TeamRead[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState(
    () => readStoredAgentScope(tenantId, userId),
  );
  const [sidebarExpanded, setSidebarExpanded] = useState(() => {
    const stored = window.localStorage.getItem(ENTERPRISE_SIDEBAR_STORAGE_KEY);
    return stored == null ? true : stored === "1";
  });
  const [agentCreateOpen, setAgentCreateOpen] = useState(false);
  const [agentForm, setAgentForm] =
    useState<AgentCreateFormState>(EMPTY_AGENT_FORM);
  const [modelConfigs, setModelConfigs] = useState<ModelConfigRead[]>([]);
  const [modelConfigsLoaded, setModelConfigsLoaded] = useState(false);
  const isMobile = useIsMobile();
  const isAdmin = isEnterpriseAdmin(auth.user);
  const accountRoleLabel = isAdmin ? t("shell.account.roleAdmin") : "";
  const isDistillRoute = location.pathname === "/enterprise/skills/distill";
  // Ordered longest-prefix-first, and segment-anchored: `/enterprise/knowledge-admin`
  // must resolve to its own sidebar entry, never to `/enterprise/knowledge`.
  const selected =
    location.pathname === "/enterprise"
      ? "/enterprise/dashboard"
      : matchesRoutePrefix(location.pathname, EnterpriseRoute.Platform)
        ? EnterpriseRoute.Platform
        : matchesRoutePrefix(location.pathname, EnterpriseRoute.KnowledgeAdmin)
          ? EnterpriseRoute.KnowledgeAdmin
          : matchesRoutePrefix(location.pathname, EnterpriseRoute.Knowledge)
            ? EnterpriseRoute.Knowledge
            : matchesRoutePrefix(location.pathname, EnterpriseRoute.GeneralSkills)
              ? EnterpriseRoute.GeneralSkills
              : matchesRoutePrefix(location.pathname, EnterpriseRoute.Tools)
                ? EnterpriseRoute.Tools
                : matchesRoutePrefix(location.pathname, EnterpriseRoute.Teams)
                  ? EnterpriseRoute.Teams
                  : matchesRoutePrefix(location.pathname, EnterpriseRoute.ScheduledTasks)
                    ? EnterpriseRoute.ScheduledTasks
                    : isDistillRoute
                      ? EnterpriseRoute.Skills
                      : location.pathname;
  const isAgentRosterRoute = location.pathname.startsWith("/enterprise/agents");
  const [lastDistillSearch, setLastDistillSearch] = useState(() =>
    isDistillRoute ? location.search : "",
  );
  const distillSearch = isDistillRoute ? location.search : lastDistillSearch;
  const distillSearchParams = useMemo(
    () => new URLSearchParams(distillSearch),
    [distillSearch],
  );

  useEffect(() => {
    if (isDistillRoute) {
      setLastDistillSearch(location.search);
    }
  }, [isDistillRoute, location.search]);

  useEffect(() => {
    loadAgents();
    loadTeams();
  }, []);

  const loadModelConfigs = useCallback(() => {
    return tenantApi
      .get<ModelConfigRead[]>("/api/enterprise/model-configs")
      .then((items) => {
        setModelConfigs(items);
        setModelConfigsLoaded(true);
      })
      .catch(() => {
        setModelConfigs([]);
        setModelConfigsLoaded(false);
      });
  }, [tenantApi]);

  useEffect(() => {
    void loadModelConfigs();
  }, [loadModelConfigs]);

  useEffect(() => {
    const onModelConfigsUpdated = (event: Event) => {
      const rows = (event as CustomEvent<{ models?: ModelConfigRead[] }>).detail?.models;
      if (rows) {
        setModelConfigs(rows);
        setModelConfigsLoaded(true);
      } else {
        void loadModelConfigs();
      }
    };
    window.addEventListener(MODEL_CONFIGS_UPDATED_EVENT, onModelConfigsUpdated);
    return () => window.removeEventListener(MODEL_CONFIGS_UPDATED_EVENT, onModelConfigsUpdated);
  }, [loadModelConfigs]);

  // Auto-collapse the sidebar on small screens; restore the saved preference on desktop.
  useEffect(() => {
    if (isMobile) {
      setSidebarExpanded(false);
    } else {
      const stored = window.localStorage.getItem(
        ENTERPRISE_SIDEBAR_STORAGE_KEY,
      );
      setSidebarExpanded(stored == null ? true : stored === "1");
    }
  }, [isMobile]);

  useEffect(() => {
    const onAgentRefresh = () => {
      void loadAgents();
    };
    window.addEventListener(
      "ultrarag-enterprise-agent-scope-refresh",
      onAgentRefresh,
    );
    return () =>
      window.removeEventListener(
        "ultrarag-enterprise-agent-scope-refresh",
        onAgentRefresh,
      );
  }, []);

  useEffect(() => {
    const onScopeChange = (event: Event) => {
      const nextAgentId =
        (event as CustomEvent<{ agentId?: string }>).detail?.agentId ||
        readStoredAgentScope(tenantId, userId) ||
        "";
      if (nextAgentId && !isTeamScope(nextAgentId)) {
        persistSharedAgentScope(nextAgentId, tenantId, userId);
        const knownSelectableAgent = agents.some(
          (item) => item.id === nextAgentId && canUseAgentScope(item),
        );
        if (!knownSelectableAgent) void loadAgents(nextAgentId);
      }
      setSelectedAgentId(nextAgentId);
    };
    window.addEventListener(
      "ultrarag-enterprise-agent-scope-change",
      onScopeChange,
    );
    return () =>
      window.removeEventListener(
        "ultrarag-enterprise-agent-scope-change",
        onScopeChange,
      );
  }, [agents, tenantId, userId]);

  useEffect(() => {
    const onCreateAgent = () => openCreateAgentModal();
    window.addEventListener("ultrarag-enterprise-agent-create", onCreateAgent);
    return () =>
      window.removeEventListener(
        "ultrarag-enterprise-agent-create",
        onCreateAgent,
      );
  }, []);

  function loadTeams() {
    return tenantApi
      .get<TeamRead[]>("/api/enterprise/teams")
      .then((rows) => setScopeTeams(rows))
      .catch(() => setScopeTeams([]));
  }

  function loadAgents(preferredAgentId = "") {
    return tenantApi
      .get<AgentProfileRead[]>("/api/enterprise/agents")
      .then((rows) => {
        setAgents(rows);
        const selectableRows = rows.filter((item) => canUseAgentScope(item));
        setSelectedAgentId((current) => {
          // A team scope is not part of the employee roster; keep it untouched.
          if (isTeamScope(current)) return current;
          const requestedAgentId = preferredAgentId || current;
          if (
            requestedAgentId &&
            selectableRows.some((item) => item.id === requestedAgentId)
          ) {
            persistSharedAgentScope(requestedAgentId, tenantId, userId);
            return requestedAgentId;
          }
          const manageableRows = selectableRows.filter((item) =>
            canManageEmployeeAgent(item, auth.user),
          );
          const next = isAdmin
            ? preferredEmployeeAgent(selectableRows)?.id || ""
            : preferredEmployeeAgent(manageableRows)?.id ||
              preferredEmployeeAgent(selectableRows)?.id ||
              "";
          if (next) {
            persistSharedAgentScope(next, tenantId, userId);
            if (next !== current) {
              emitAgentScopeChange(next);
            }
          }
          return next;
        });
      })
      .catch(() => setAgents([]))
      .finally(() => setAgentsLoaded(true));
  }

  function canUseAgentScope(agent: AgentProfileRead): boolean {
    return canSelectCurrentEmployeeAgent(agent, auth.user, { activeOnly: true });
  }

  function changeAgentScope(agentId: string) {
    setSelectedAgentId(agentId);
    persistSharedAgentScope(agentId, tenantId, userId);
    emitAgentScopeChange(agentId);
  }

  /** 创建团队会话并切换到团队作用域；服务端原始错误优先直出。 */
  async function selectTeamScope(teamId: string) {
    const scope = toTeamScope(teamId);
    try {
      const result = await tenantApi.post<{ session_id: string }>(
        `/api/enterprise/teams/${teamId}/tl/session`,
        {},
      );
      if (!result.session_id) throw new Error(t("shell.teamChat.startFailure"));
      setSelectedAgentId(scope);
      persistSharedAgentScope(scope, tenantId, userId);
      emitAgentScopeChange(scope);
      navigate(`/workspace/chat/${result.session_id}`);
    } catch (error) {
      notify.error(error instanceof Error ? error.message : t("shell.teamChat.startFailure"));
    }
  }

  function handleSidebarOpenChange(open: boolean) {
    setSidebarExpanded(open);
    window.localStorage.setItem(
      ENTERPRISE_SIDEBAR_STORAGE_KEY,
      open ? "1" : "0",
    );
  }

  const scopeAgents = agents.filter(canUseAgentScope);
  const hasUsableModelConfig = modelConfigs.some((item) => item.enabled);
  const showModelSetupNotice = guidesCompleted && modelConfigsLoaded && !hasUsableModelConfig;
  const modelSetupNoticeText = isAdmin
    ? t("shell.modelSetup.adminNotice")
    : t("shell.modelSetup.memberNotice");
  const selectedAgent = scopeAgents.find((item) => item.id === selectedAgentId);
  const sidebarAgent = selectedAgent;
  // Routes that operate on a specific employee; show the empty guide when none exist.
  const EMPLOYEE_SCOPED_PREFIXES = [
    "/enterprise/dashboard",
    "/enterprise/scheduled-tasks",
    "/enterprise/memories",
    "/enterprise/feedback",
    "/enterprise/knowledge",
    "/enterprise/general-skills",
    "/enterprise/skills",
    "/enterprise/tools",
  ];
  const hasEmployees = scopeAgents.some((item) => !item.is_overall);
  // Segment-anchored so that `/enterprise/knowledge-admin` (an admin console that is not
  // scoped to any single employee) is not swallowed by the `/enterprise/knowledge` prefix.
  const isEmployeeScopedRoute = EMPLOYEE_SCOPED_PREFIXES.some((prefix) =>
    matchesRoutePrefix(location.pathname, prefix),
  );
  const showEmployeeEmptyState =
    agentsLoaded && !hasEmployees && isEmployeeScopedRoute;
  const sourceAgents = agents.filter((item) =>
    canAccessEmployeeAgent(item, auth.user, {
      activeOnly: true,
      includeOverall: isAdmin,
    }),
  );
  const selectedAgentName = selectedAgent
    ? employeeDisplayName(selectedAgent)
    : t("sidebar.notSelected");
  const selectedAgentCaption = selectedAgent
    ? selectedAgent.is_overall
      ? t("sidebar.marketplaceShort")
      : employeeProfile(selectedAgent).roleName
    : "-";
  /** 使用当前可复制员工初始化创建表单，不翻译员工名称或已有员工档案字段。 */
  function openCreateAgentModal() {
    setAgentForm({
      ...EMPTY_AGENT_FORM,
      copyFromAgentId: (isTeamScope(selectedAgentId) ? "" : selectedAgentId) || sourceAgents[0]?.id || "",
    });
    setAgentCreateOpen(true);
  }

  /** 校验并创建数字员工；用户输入和复制的员工元数据保持原始值。 */
  async function saveAgentCreateModal() {
    const name = agentForm.name.trim();
    if (!name) {
      notify.error(t("shell.agentCreate.nameRequired"));
      return;
    }
    const isBlankOnboarding = agentForm.sourceMode === "blank";
    const sourceAgent = agentForm.copyFromAgentId
      ? sourceAgents.find((item) => item.id === agentForm.copyFromAgentId)
      : undefined;
    const sourceMetadata =
      !isBlankOnboarding && sourceAgent?.metadata ? sourceAgent.metadata : {};
    const sourceRoleName =
      sourceAgent && !sourceAgent.is_overall
        ? employeeProfile(sourceAgent).roleName
        : "";
    const roleName =
      agentForm.roleName.trim() ||
      (!isBlankOnboarding ? sourceRoleName : "") ||
      t("shell.agentCreate.roleFallback");
    const description =
      agentForm.description.trim() ||
      (!isBlankOnboarding
        ? sourceAgent?.description ||
          String(sourceMetadata.system_prompt_summary || "")
        : "") ||
      "";
    const baseMetadata = {
      ...sourceMetadata,
      system_prompt_summary: description,
      owner_user_id: auth.user.id,
      owner_username: auth.user.username,
      owner_display_name: auth.user.display_name || auth.user.username,
      created_by_user_id: auth.user.id,
      created_by_username: auth.user.username,
      created_by: auth.user.username,
      created_by_display_name: auth.user.display_name || auth.user.username,
      creator_name: auth.user.username,
      role_key: "",
      role_name: roleName,
      onboarded_at: new Date().toISOString().slice(0, 10),
      blank_onboarding: isBlankOnboarding,
    };
    try {
      const created = await tenantApi.post<AgentProfileRead>(
        "/api/enterprise/agents",
        {
          name,
          description,
          source_mode: agentForm.sourceMode,
          copy_from_agent_id:
            agentForm.sourceMode === "copy"
              ? agentForm.copyFromAgentId || undefined
              : undefined,
          metadata: isBlankOnboarding
            ? employeeBlankMetadata(baseMetadata)
            : baseMetadata,
        },
      );
      await loadAgents();
      changeAgentScope(created.id);
      setAgentCreateOpen(false);
      notify.successText(t("shell.agentCreate.success"));
    } catch (error) {
      notify.error(error instanceof Error ? error.message : t("shell.agentCreate.failure"));
    }
  }

  return (
    <SidebarProvider
      open={sidebarExpanded}
      onOpenChange={handleSidebarOpenChange}
      style={
        {
          "--sidebar-width": "240px",
          "--sidebar-width-icon": "72px",
        } as CSSProperties
      }
      className={`app-shell ${sidebarExpanded ? "sidebar-expanded" : "sidebar-collapsed"} ${isAgentRosterRoute ? "is-agent-roster" : ""}`}
    >
      <AppSidebar
        selected={selected}
        onNavigate={navigate}
        isAdmin={isAdmin}
        sidebarAgent={sidebarAgent}
        scopeAgents={scopeAgents}
        scopeTeams={scopeTeams}
        selectedAgentId={selectedAgentId}
        onSelectAgent={(agentId) => {
          const teamId = teamIdFromScope(agentId);
          if (teamId) {
            void selectTeamScope(teamId);
            return;
          }
          if (agentId !== selectedAgentId) changeAgentScope(agentId);
          navigate(EnterpriseRoute.Dashboard);
        }}
        onOpenChat={() => {
          navigate(EnterpriseRoute.Gallery);
        }}
        modelSetupAttention={isAdmin && showModelSetupNotice}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div
          className={`content flex-1 ${isDistillRoute ? "flex min-h-0 flex-col overflow-hidden p-0!" : ""} ${selected === "/enterprise/dashboard" ? "sd1-dashboard-content" : ""} ${selected !== "/enterprise/dashboard" && !isDistillRoute ? "sd1-management-content" : ""}`}
        >
          {showModelSetupNotice && (
            <div className="mx-[24px] mt-[18px] mb-[10px] flex shrink-0 flex-col items-start justify-between gap-[12px] rounded-[12px] border border-[#f3d28b] bg-[#fff8e8] px-[18px] py-[12px] text-[#6f4500] shadow-[0_8px_24px_rgba(92,62,0,0.08)] sm:flex-row sm:items-center">
              <div className="flex min-w-0 items-center gap-[10px]">
                <span className="flex size-[28px] shrink-0 items-center justify-center rounded-[8px] bg-[#ffe7ad] text-[#8a4b00]">
                  <StaffdeckIcon name="model" className="size-[15px]" />
                </span>
                <span className="min-w-0 text-[13px] leading-[20px]">{modelSetupNoticeText}</span>
              </div>
              {isAdmin && (
                <UIButton
                  type="button"
                  size="sm"
                  onClick={() => navigate(EnterpriseRoute.Models)}
                  className="h-[32px] shrink-0 rounded-[8px] bg-[#1a71ff] px-[12px] text-[12px] text-white hover:bg-[#0f5ed7]"
                >
                  {t("shell.modelSetup.configure")}
                </UIButton>
              )}
            </div>
          )}
          <div
            className={
              isDistillRoute
                ? "persistent-distill active flex min-h-0 flex-1 flex-col"
                : "persistent-distill hidden"
            }
          >
            <DistillPage
              active={isDistillRoute}
              searchParamsOverride={distillSearchParams}
              currentUser={auth.user}
              onLogout={onLogout}
            />
          </div>
          {!isDistillRoute && showEmployeeEmptyState && (
            <EmptyEmployeeState
              isAdmin={isAdmin}
              onCreate={openCreateAgentModal}
              onBrowsePlatform={() => navigate(EnterpriseRoute.Platform)}
            />
          )}
          {!isDistillRoute && !showEmployeeEmptyState && (
            <Routes>
              <Route
                path="/enterprise"
                element={<Navigate to="/enterprise/dashboard" replace />}
              />
              <Route
                path="/enterprise/platform"
                element={
                  <OpenPlatformPage
                    currentUser={auth.user}
                    isAdmin={isAdmin}
                    onLogout={onLogout}
                  />
                }
              />
              <Route
                path="/enterprise/platform/:kind"
                element={
                  <OpenPlatformPage
                    currentUser={auth.user}
                    isAdmin={isAdmin}
                    onLogout={onLogout}
                  />
                }
              />
              <Route
                path="/enterprise/dashboard"
                element={
                  <DashboardPage
                    currentUser={auth.user}
                    isAdmin={isAdmin}
                    onLogout={onLogout}
                  />
                }
              />
              <Route
                path="/enterprise/agents"
                element={
                  <AgentsPage
                    currentUser={auth.user}
                    isAdmin={isAdmin}
                    onCreateAgent={openCreateAgentModal}
                    onLogout={onLogout}
                  />
                }
              />
              <Route
                path="/enterprise/teams"
                element={
                  <TeamsPage
                    currentUser={auth.user}
                    isAdmin={isAdmin}
                    onLogout={onLogout}
                  />
                }
              />
              <Route
                path="/enterprise/teams/:teamId/chat"
                element={<TeamChatPage />}
              />
              <Route
                path="/enterprise/teams/:teamId"
                element={
                  <TeamDetailPage
                    currentUser={auth.user}
                    isAdmin={isAdmin}
                    onLogout={onLogout}
                  />
                }
              />
              <Route
                path="/enterprise/memories"
                element={
                  <DashboardPage
                    currentUser={auth.user}
                    isAdmin={isAdmin}
                    profileTab="memories"
                    onLogout={onLogout}
                  />
                }
              />
              <Route
                path="/enterprise/knowledge"
                element={
                  <KnowledgeManagePage
                    currentUser={auth.user}
                    onLogout={onLogout}
                  />
                }
              />
              <Route
                path="/enterprise/knowledge/new"
                element={
                  <KnowledgeAddPage
                    currentUser={auth.user}
                    onLogout={onLogout}
                  />
                }
              />
              <Route
                path="/enterprise/feedback"
                element={
                  <DashboardPage
                    currentUser={auth.user}
                    isAdmin={isAdmin}
                    profileTab="logs"
                    onLogout={onLogout}
                  />
                }
              />
              <Route
                path="/enterprise/channels"
                element={
                  <ChannelsPage currentUser={auth.user} onLogout={onLogout} />
                }
              />
              <Route
                path="/enterprise/scheduled-tasks"
                element={
                  <DashboardPage
                    currentUser={auth.user}
                    isAdmin={isAdmin}
                    profileTab="scheduled"
                    onLogout={onLogout}
                  />
                }
              />
              <Route
                path="/enterprise/scheduled-tasks/new"
                element={
                  <ScheduledTaskNewPage
                    currentUser={auth.user}
                    onLogout={onLogout}
                  />
                }
              />
              <Route
                path="/enterprise/scheduled-tasks/:taskId/edit"
                element={
                  <ScheduledTaskEditPage
                    currentUser={auth.user}
                    onLogout={onLogout}
                  />
                }
              />
              <Route
                path="/enterprise/skills"
                element={
                  <SkillsPage currentUser={auth.user} onLogout={onLogout} />
                }
              />
              <Route
                path="/enterprise/general-skills"
                element={
                  <GeneralSkillsPage
                    currentUser={auth.user}
                    onLogout={onLogout}
                  />
                }
              />
              <Route
                path="/enterprise/general-skills/new"
                element={
                  <GeneralSkillNewPage
                    currentUser={auth.user}
                    onLogout={onLogout}
                  />
                }
              />
              <Route
                path="/enterprise/general-skills/:slug/edit"
                element={
                  <GeneralSkillEditPage
                    currentUser={auth.user}
                    onLogout={onLogout}
                  />
                }
              />
              <Route
                path="/enterprise/accounts"
                element={
                  isAdmin ? (
                    <AccountsPage currentUser={auth.user} onLogout={onLogout} />
                  ) : (
                    <Navigate to={EnterpriseRoute.Gallery} replace />
                  )
                }
              />
              <Route
                path={EnterpriseRoute.KnowledgeAdmin}
                element={
                  isAdmin ? (
                    <KnowledgeAdminListPage currentUser={auth.user} onLogout={onLogout} />
                  ) : (
                    <Navigate to={EnterpriseRoute.Gallery} replace />
                  )
                }
              />
              <Route
                path={`${EnterpriseRoute.KnowledgeAdmin}/:kbId`}
                element={
                  isAdmin ? (
                    <KnowledgeAdminDetailPage currentUser={auth.user} onLogout={onLogout} />
                  ) : (
                    <Navigate to={EnterpriseRoute.Gallery} replace />
                  )
                }
              />
              <Route
                path="/enterprise/models"
                element={
                  isAdmin ? (
                    <ModelsPage currentUser={auth.user} onLogout={onLogout} />
                  ) : (
                    <Navigate to={EnterpriseRoute.Gallery} replace />
                  )
                }
              />
              <Route
                path="/enterprise/runtime-settings"
                element={
                  isAdmin ? (
                    <RuntimeSettingsPage currentUser={auth.user} />
                  ) : (
                    <Navigate to={EnterpriseRoute.Gallery} replace />
                  )
                }
              />
              <Route
                path="/enterprise/tools"
                element={
                  <ToolsPage currentUser={auth.user} onLogout={onLogout} />
                }
              />
              <Route
                path="/enterprise/tools/new"
                element={
                  <ToolNewPage currentUser={auth.user} onLogout={onLogout} />
                }
              />
              <Route
                path="/enterprise/tools/mcp/new"
                element={
                  <McpServerNewPage
                    currentUser={auth.user}
                    onLogout={onLogout}
                  />
                }
              />
              <Route
                path="/enterprise/tools/mcp/:serverId/edit"
                element={
                  <McpServerEditPage
                    currentUser={auth.user}
                    onLogout={onLogout}
                  />
                }
              />
              <Route
                path="/enterprise/tools/:toolId/edit"
                element={
                  <ToolEditPage currentUser={auth.user} onLogout={onLogout} />
                }
              />
              <Route
                path="/enterprise/tools/:toolId/test"
                element={
                  <ToolTestPage currentUser={auth.user} onLogout={onLogout} />
                }
              />
              <Route
                path="/enterprise/persona"
                element={<PersonaPage />}
              />
              <Route
                path="*"
                element={<Navigate to="/enterprise/dashboard" replace />}
              />
            </Routes>
          )}
        </div>
      </div>
      <Dialog open={agentCreateOpen} onOpenChange={setAgentCreateOpen}>
        <DialogContent className="flex max-h-[calc(100dvh-32px)] w-[calc(100%-32px)] flex-col gap-0 overflow-hidden rounded-[16px] p-0 sm:max-w-[520px]">
          <DialogTitle className="shrink-0 px-[24px] py-[16px] text-[16px] font-semibold text-foreground">
            {t("shell.agentCreate.title")}
          </DialogTitle>
          <div className="agent-editor-form min-h-0 flex-1 overflow-y-auto px-[24px] pb-[16px]">
            <label>
              {t("shell.agentCreate.method")}
              <div className="inline-flex w-fit gap-[4px] rounded-[10px] border border-border p-[2px]">
                {[
                  { label: t("shell.agentCreate.copyMarketplace"), value: "copy" as const },
                  { label: t("shell.agentCreate.startBlank"), value: "blank" as const },
                ].map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={cn(
                      "rounded-[8px] px-[14px] py-[5px] text-[13px] font-medium transition-colors",
                      agentForm.sourceMode === option.value
                        ? "bg-[#18181a] text-white"
                        : "text-[#5b6273] hover:text-foreground",
                    )}
                    onClick={() =>
                      setAgentForm((prev) => ({
                        ...prev,
                        sourceMode: option.value,
                        copyFromAgentId:
                          option.value === "blank" ? "" : prev.copyFromAgentId,
                      }))
                    }
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </label>
            <label>
              {t("shell.agentCreate.role")}
              <Input
                value={agentForm.roleName}
                onChange={(event) =>
                  setAgentForm((prev) => ({
                    ...prev,
                    roleName: event.target.value,
                  }))
                }
                placeholder={t("shell.agentCreate.rolePlaceholder")}
              />
            </label>
            <div className="grid content-start gap-[6px]">
            {agentForm.sourceMode === "copy" && (
              <label>
                {t("shell.agentCreate.copySource")}
                <UISelect
                  value={agentForm.copyFromAgentId || undefined}
                  onValueChange={(value) =>
                    setAgentForm((prev) => {
                      const nextSource = sourceAgents.find(
                        (item) => item.id === value,
                      );
                      return {
                        ...prev,
                        copyFromAgentId: value,
                        roleName:
                          prev.roleName ||
                          (nextSource && !nextSource.is_overall
                            ? employeeProfile(nextSource).roleName
                            : ""),
                      };
                    })
                  }
                >
                  <SelectTrigger className={cn(SELECT_TRIGGER_CLASS, "w-full")}>
                    <SelectValue placeholder={t("shell.agentCreate.copySourcePlaceholder")} />
                  </SelectTrigger>
                  <SelectContent>
                    {sourceAgents.map((agent) => (
                      <SelectItem key={agent.id} value={agent.id}>
                        {agent.is_overall
                          ? t("shell.agentCreate.marketplace")
                          : `${employeeDisplayNameWithCreator(agent)} · ${employeeProfile(agent).roleName}${isGalleryEmployee(agent) ? ` · ${t("shell.agentCreate.marketplaceSuffix")}` : ""}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </UISelect>
              </label>
            )}
            {agentForm.sourceMode === "blank" && (
              <div className="agent-definition-note">
                {t("shell.agentCreate.blankHint")}
              </div>
            )}
            </div>
            <label>
              {t("shell.agentCreate.name")}
              <Input
                value={agentForm.name}
                onChange={(event) =>
                  setAgentForm((prev) => ({
                    ...prev,
                    name: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              {t("shell.agentCreate.description")}
              <Textarea
                rows={3}
                value={agentForm.description}
                onChange={(event) =>
                  setAgentForm((prev) => ({
                    ...prev,
                    description: event.target.value,
                  }))
                }
                placeholder={t("shell.agentCreate.descriptionPlaceholder")}
              />
            </label>
          </div>
          <div className={cn(DIALOG_FOOTER_CLASS, "shrink-0 border-t border-border")}>
            <UIButton
              variant="outline"
              className={DIALOG_CANCEL_BUTTON_CLASS}
              onClick={() => setAgentCreateOpen(false)}
            >
              {t("common.action.cancel")}
            </UIButton>
            <UIButton
              className={DIALOG_PRIMARY_BUTTON_CLASS}
              onClick={() => void saveAgentCreateModal()}
            >
              {t("common.action.create")}
            </UIButton>
          </div>
        </DialogContent>
      </Dialog>
    </SidebarProvider>
  );
}

function AuthedApp({
  auth,
  onLogout,
  onSessionChange,
  guidesCompleted,
}: {
  auth: EnterpriseAuthSession;
  onLogout: () => void;
  onSessionChange: (session: EnterpriseAuthSession) => void;
  guidesCompleted: boolean;
}) {
  const location = useLocation();
  if (auth.user.must_change_password && location.pathname !== "/change-password") {
    return <Navigate to="/change-password" replace />;
  }
  if (location.pathname === "/change-password") {
    if (!auth.user.must_change_password) {
      return <Navigate to={EnterpriseRoute.Gallery} replace />;
    }
    return (
      <TenantChangePasswordRoute
        session={auth}
        onComplete={onSessionChange}
        onCancel={onLogout}
      />
    );
  }
  if (location.pathname === "/") {
    return <Navigate to={EnterpriseRoute.Gallery} replace />;
  }
  if (location.pathname === "/chat" || location.pathname === "/chat/") {
    return <Navigate to={EnterpriseRoute.Gallery} replace />;
  }
  if (location.pathname.startsWith("/chat/draft/")) {
    const nextPath = location.pathname.replace(/^\/chat/, EnterpriseRoute.Chat);
    return <Navigate to={`${nextPath}${location.search}`} replace />;
  }
  if (location.pathname.startsWith("/chat/session_")) {
    const nextPath = location.pathname.replace(/^\/chat/, EnterpriseRoute.Chat);
    return <Navigate to={`${nextPath}${location.search}`} replace />;
  }
  if (location.pathname === "/enterprise/chat" || location.pathname === "/enterprise/chat/") {
    return <Navigate to={EnterpriseRoute.Gallery} replace />;
  }
  if (location.pathname.startsWith("/enterprise/chat/draft/")) {
    const nextPath = location.pathname.replace(/^\/enterprise\/chat/, EnterpriseRoute.Chat);
    return <Navigate to={`${nextPath}${location.search}`} replace />;
  }
  if (location.pathname.startsWith("/enterprise/chat/session_")) {
    const nextPath = location.pathname.replace(/^\/enterprise\/chat/, EnterpriseRoute.Chat);
    return <Navigate to={`${nextPath}${location.search}`} replace />;
  }
  if (location.pathname.startsWith(EnterpriseRoute.Workspace)) {
    return (
      <Routes>
        <Route
          path="/workspace"
          element={<Navigate to="/workspace/gallery" replace />}
        />
        <Route path="/workspace/gallery" element={<ChatGalleryPage />} />
        <Route path="/workspace/chat" element={<ChatPage />} />
        <Route
          path="/workspace/chat/draft/:draftAgentId"
          element={<ChatPage />}
        />
        <Route path="/workspace/chat/:sessionId" element={<ChatPage />} />
      </Routes>
    );
  }
  return <Shell auth={auth} onLogout={onLogout} guidesCompleted={guidesCompleted} />;
}

function TenantChangePasswordRoute({
  session,
  onComplete,
  onCancel,
}: {
  session: EnterpriseAuthSession;
  onComplete: (session: EnterpriseAuthSession) => void;
  onCancel: () => void;
}) {
  const tenantContext = useTenantSession();
  const tenantApi = useMemo(() => createTenantClient(tenantContext), [tenantContext]);
  return (
    <ChangePasswordPage
      session={session}
      client={{
        getPasswordPolicy: () => tenantApi.get<PasswordPolicy>("/api/auth/password-policy"),
        changePassword: (input) => tenantApi.post<EnterpriseAuthSession>(
          "/api/auth/change-password",
          input,
        ),
      }}
      onComplete={onComplete}
      onCancel={onCancel}
    />
  );
}

function VerifiedTenantApp({
  onLogout,
  onSessionChange,
  guidesCompleted,
}: {
  onLogout: () => void;
  onSessionChange: (session: EnterpriseAuthSession) => void;
  guidesCompleted: boolean;
}) {
  const { t } = useAppIntl();
  const tenantContext = useTenantSession();
  const verification = useTenantSessionVerification();
  if (!tenantContext) {
    if (verification.status !== 'error') return null;
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#f7f9fc] px-5">
        <section className="w-full max-w-md rounded-[18px] border border-[#e3e8f1] bg-white p-8 text-center shadow-[0_18px_55px_rgba(35,61,102,0.08)]">
          <p role="alert" className="text-[14px] text-[#464c5e]">
            {t('auth.sessionVerification.failure')}
          </p>
          <UIButton className="mt-5" onClick={verification.retry}>
            {t('auth.sessionVerification.retry')}
          </UIButton>
        </section>
      </main>
    );
  }
  const auth = tenantContext.session;

  return (
    <>
      <Routes>
        <Route
          path="/*"
          element={
            <AuthedApp
              auth={auth}
              onLogout={onLogout}
              onSessionChange={onSessionChange}
              guidesCompleted={guidesCompleted}
            />
          }
        />
      </Routes>
      {auth.user.must_change_password ? null : <OnboardingGuide />}
      {auth.user.must_change_password ? null : <QuickStartGuide isAdmin={isEnterpriseAdmin(auth.user)} />}
      {auth.user.must_change_password ? null : <UpdateReminder enabled={guidesCompleted} />}
    </>
  );
}

/** Tenant workspace route tree; mounted only outside the `/system/**` domain. */
function TenantApp() {
  const [auth, setAuth] = useState<EnterpriseAuthSession | null>(() =>
    getEnterpriseAuthSession(),
  );
  const [guidesCompleted, setGuidesCompleted] = useState(() => Boolean(
    window.localStorage.getItem(ONBOARDING_SEEN_KEY)
    && window.localStorage.getItem(QUICK_START_SEEN_KEY),
  ));

  useEffect(() => {
    const onQuickStartCompleted = () => setGuidesCompleted(true);
    window.addEventListener(QUICK_START_COMPLETED_EVENT, onQuickStartCompleted);
    return () => window.removeEventListener(QUICK_START_COMPLETED_EVENT, onQuickStartCompleted);
  }, []);

  function logout() {
    clearEnterpriseAuthSession();
    setAuth(null);
  }

  if (!auth) {
    return (
      <Routes>
        <Route path="/*" element={<LoginPage onLogin={setAuth} />} />
      </Routes>
    );
  }

  return (
    <TenantSessionProvider
      session={auth}
      onInvalidSession={() => {
        clearEnterpriseAuthSession();
        setAuth(null);
      }}
    >
      <VerifiedTenantApp
        onLogout={logout}
        onSessionChange={setAuth}
        guidesCompleted={guidesCompleted}
      />
    </TenantSessionProvider>
  );
}

/** Select the security domain before mounting any tenant auth/effects/guides. */
function AppDomainBoundary() {
  const location = useLocation();
  const isSystemPath = location.pathname === "/system"
    || location.pathname.startsWith("/system/");
  return isSystemPath ? <SystemApp /> : <TenantApp />;
}

/** Render one router with a strict URL-domain boundary and semantic document title. */
export default function App() {
  const { locale, t } = useAppIntl();

  useEffect(() => {
    document.title = t("app.document.title");
  }, [locale, t]);

  return (
    <TooltipProvider>
      <BrowserRouter>
        <AppDomainBoundary />
      </BrowserRouter>
      <Toaster richColors closeButton position="top-center" />
    </TooltipProvider>
  );
}
