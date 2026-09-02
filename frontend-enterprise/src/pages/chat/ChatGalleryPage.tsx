import { type CSSProperties, useMemo } from 'react';

import { createTenantClient } from '@/api/tenant-client';
import AppSidebar from '@/components/AppSidebar';
import { notify } from '@/components/ui/app-toast';
import { SidebarProvider } from '@/components/ui/sidebar';
import { isEnterpriseAdmin } from '@/auth';
import { useTenantSession } from '@/contexts/TenantSessionContext';
import { useAppIntl } from '@/i18n/useAppIntl';
import type { AgentProfileRead } from '@/types';

import EmployeeGalleryPage from '../EmployeeGalleryPage';
import { sessionHasUnreadReply } from './chatHelpers';
import { useChatSession } from './useChatSession';
import ChatDialogs from './components/ChatDialogs';

/** 渲染聊天入口的员工广场，并让启动失败遵循统一错误消息契约。 */
export default function ChatGalleryPage() {
  const chat = useChatSession();
  const { t } = useAppIntl();
  const tenantContext = useTenantSession();
  const tenantClient = useMemo(() => createTenantClient(tenantContext), [tenantContext]);
  const auth = chat.auth;
  const isAdmin = isEnterpriseAdmin(auth?.user);

  /** 启动员工草稿会话；服务端异常只记录诊断信息并显示稳定的本地化错误。 */
  async function startGalleryChat(agent: AgentProfileRead) {
    if (!tenantContext) return;
    try {
      await tenantClient.post<AgentProfileRead>(`/api/chat/agents/${agent.id}/use`, {});
      await chat.refreshAgents(agent.id);
      chat.setSessionAgentFilter(agent.id);
      chat.openDraftForAgent(agent.id);
    } catch (error) {
      console.error('[chat-gallery] start chat failed', error);
      notify.error(t('chat.error.agentAccess'));
    }
  }

  return (
    <SidebarProvider
      open={!chat.sidebarCollapsed}
      onOpenChange={(open) => {
        if (open === chat.sidebarCollapsed) chat.toggleSidebar();
      }}
      style={
        {
          '--sidebar-width': '240px',
          '--sidebar-width-icon': '72px',
        } as CSSProperties
      }
      className="h-screen min-h-0 bg-[#fcfcfc] text-[#18181a]"
    >
      <AppSidebar
        variant="chat"
        sessions={chat.visibleSidebarSessions}
        sessionsLoading={chat.sessionsLoading}
        agents={chat.agents}
        scopeTeams={chat.teams}
        activeSessionId={chat.sessionId}
        sessionFilter={chat.sessionAgentFilter}
        onSessionFilterChange={chat.setSessionAgentFilter}
        sessionFilterOptions={chat.sessionFilterOptions}
        isSessionUnread={(session) => sessionHasUnreadReply(session, chat.sessionReadTimes, chat.sessionId)}
        onOpenSession={chat.openSession}
        onOpenGallery={chat.openGallery}
        galleryActive
        handoffCount={chat.handoffs.length}
        onOpenHandoffs={chat.openHandoffInbox}
        onRenameSession={chat.openRename}
        onDeleteSession={chat.requestDelete}
        onOpenAdmin={chat.openAdmin}
      />
      <main className="min-h-0 flex-1 overflow-y-auto">
        <EmployeeGalleryPage
          currentUser={auth?.user}
          isAdmin={isAdmin}
          onStartChat={startGalleryChat}
          onLogout={chat.logout}
        />
      </main>
      <ChatDialogs chat={chat} />
    </SidebarProvider>
  );
}
