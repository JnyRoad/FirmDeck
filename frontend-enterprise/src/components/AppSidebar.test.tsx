// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppIntlProvider } from '@/i18n/provider';
import type { AppLocale } from '@/i18n/locales';
import { I18nProvider } from '@/i18n';
import { SidebarProvider } from '@/components/ui/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { AgentProfileRead, TeamRead } from '@/types';

import AppSidebar from './AppSidebar';

const agent: AgentProfileRead = {
  id: 'agent-1',
  tenant_id: 'tenant_demo',
  name: '小艾',
  is_overall: false,
  status: 'active',
  metadata: {},
  resources: [],
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
};

const team: TeamRead = {
  id: 'team-1',
  tenant_id: 'tenant_demo',
  name: '增长团队',
  description: '',
  owner_user_id: 'user-1',
  config: {},
  status: 'active',
  members: [],
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
};

const semanticSidebarCopy = {
  'zh-CN': {
    marketplace: '开放广场平台',
    profile: '员工档案',
    knowledge: '知识库',
    accounts: '账号管理',
    models: '模型配置',
    collapse: '收起边栏',
    employeeSwitcher: '切换当前员工',
    chatSwitcher: '切换到对话端',
  },
  'en-US': {
    marketplace: 'Open Marketplace',
    profile: 'Employee Profile',
    knowledge: 'Knowledge Base',
    accounts: 'Account Management',
    models: 'Model settings',
    collapse: 'Collapse Sidebar',
    employeeSwitcher: 'Switch current employee',
    chatSwitcher: 'Switch to Chat',
  },
} as const satisfies Record<AppLocale, Record<string, string>>;

function stubRadixPointerApis() {
  if (!window.ResizeObserver) {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
  }
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {};
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
}

function renderSidebar(props: {
  selectedAgentId: string;
  onSelectAgent?: (value: string) => void;
  scopeTeams?: TeamRead[];
}) {
  return render(
    <I18nProvider>
      <TooltipProvider>
        <SidebarProvider>
          <AppSidebar
            selected="/enterprise/dashboard"
            onNavigate={() => {}}
            isAdmin={false}
            scopeAgents={[agent]}
            scopeTeams={props.scopeTeams ?? [team]}
            selectedAgentId={props.selectedAgentId}
            onSelectAgent={props.onSelectAgent ?? (() => {})}
            onOpenChat={() => {}}
          />
        </SidebarProvider>
      </TooltipProvider>
    </I18nProvider>,
  );
}

/** 在不挂载 legacy Provider 的前提下渲染管理侧边栏，验证语义消息和可访问名称。 */
function renderSemanticSidebar(locale: AppLocale) {
  return render(
    <AppIntlProvider initialLocale={locale}>
      <TooltipProvider>
        <SidebarProvider>
          <AppSidebar
            selected="/enterprise/dashboard"
            onNavigate={() => {}}
            isAdmin
            sidebarAgent={agent}
            scopeAgents={[agent]}
            scopeTeams={[team]}
            selectedAgentId="agent-1"
            onSelectAgent={() => {}}
            onOpenChat={() => {}}
          />
        </SidebarProvider>
      </TooltipProvider>
    </AppIntlProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  document.documentElement.lang = '';
});

beforeEach(() => {
  stubRadixPointerApis();
});

describe('AppSidebar agent switcher team group', () => {
  it('lists teams under a team group and emits the team scope value on select', async () => {
    const user = userEvent.setup();
    const onSelectAgent = vi.fn();
    renderSidebar({ selectedAgentId: 'agent-1', onSelectAgent });

    await user.click(screen.getByLabelText('切换当前员工'));
    const menu = await screen.findByRole('menu');
    // 分组标签与团队项上的 Badge 都写作「团队」。
    expect(within(menu).getAllByText('团队').length).toBeGreaterThanOrEqual(2);
    const teamItem = within(menu)
      .getAllByRole('menuitem')
      .find((item) => item.textContent?.includes('增长团队'));
    expect(teamItem).toBeTruthy();

    await user.click(teamItem!);
    expect(onSelectAgent).toHaveBeenCalledWith('team:team-1');
  });

  it('shows the team name and team caption when a team scope is selected', () => {
    renderSidebar({ selectedAgentId: 'team:team-1' });

    const trigger = screen.getByLabelText('切换当前员工');
    expect(within(trigger).getByText('当前团队')).toBeTruthy();
    expect(within(trigger).getByText('增长团队')).toBeTruthy();
  });

  it('falls back to a bare team label when the selected team is unknown', () => {
    renderSidebar({ selectedAgentId: 'team:missing', scopeTeams: [team] });

    const trigger = screen.getByLabelText('切换当前员工');
    expect(within(trigger).getByText('当前团队')).toBeTruthy();
    expect(within(trigger).getByText('团队')).toBeTruthy();
  });
});

describe('AppSidebar semantic navigation matrix', () => {
  it.each(['zh-CN', 'en-US'] as const)(
    'localizes shell navigation and ARIA names in %s without a legacy observer',
    (locale) => {
      const copy = semanticSidebarCopy[locale];
      renderSemanticSidebar(locale);

      expect(document.documentElement.lang).toBe(locale);
      expect(screen.getByText(copy.marketplace)).toBeTruthy();
      expect(screen.getByText(copy.profile)).toBeTruthy();
      expect(screen.getByText(copy.knowledge)).toBeTruthy();
      expect(screen.getByText(copy.accounts)).toBeTruthy();
      const modelLabel = screen.getByText(copy.models);
      expect(modelLabel.className).toContain('whitespace-nowrap');
      expect(modelLabel.className).toContain('truncate');
      expect(screen.getByRole('button', { name: copy.collapse })).toBeTruthy();
      expect(screen.getByLabelText(copy.employeeSwitcher)).toBeTruthy();
      expect(screen.getByRole('button', { name: copy.chatSwitcher })).toBeTruthy();
    },
  );

  it('never exposes system tenant management from the ordinary tenant-admin sidebar', async () => {
    const user = userEvent.setup();
    const view = renderSemanticSidebar('zh-CN');

    expect(screen.queryByText('租户管理')).toBeNull();
    expect(screen.queryByText('系统管理员')).toBeNull();
    expect(screen.getByText('账号管理')).toBeTruthy();
    expect(view.container.innerHTML).not.toContain('/system/');

    await user.click(screen.getByRole('button', { name: '收起边栏' }));
    expect(view.container.innerHTML).not.toContain('/system/');
    expect(screen.queryByText('租户管理')).toBeNull();
  });

  it('never exposes system tenant management from an ordinary tenant-member sidebar', async () => {
    const user = userEvent.setup();
    const view = renderSidebar({ selectedAgentId: 'agent-1' });

    expect(screen.queryByText('租户管理')).toBeNull();
    expect(screen.queryByText('系统管理员')).toBeNull();
    expect(view.container.innerHTML).not.toContain('/system/');
    await user.click(screen.getByRole('button', { name: '收起边栏' }));
    expect(view.container.innerHTML).not.toContain('/system/');
    expect(screen.queryByText('租户管理')).toBeNull();
  });
});

describe('AppSidebar chat variant group conversations', () => {
  const leaderAgent: AgentProfileRead = { ...agent, id: 'agent-tl', name: '队长' };
  const teamWithLeader: TeamRead = {
    ...team,
    members: [
      {
        id: 'member-1',
        team_id: 'team-1',
        agent_id: 'agent-tl',
        role: 'leader',
        agent_name: '队长',
        created_at: '2026-08-01T00:00:00Z',
      },
      {
        id: 'member-2',
        team_id: 'team-1',
        agent_id: 'agent-1',
        role: 'member',
        agent_name: '小艾',
        created_at: '2026-08-01T00:00:00Z',
      },
    ],
  };

  function renderChatSidebar(scopeTeams: TeamRead[] = [teamWithLeader]) {
    const sessions = [
      {
        id: 'session-tl',
        tenant_id: 'tenant_demo',
        agent_id: 'agent-tl',
        team_id: 'team-1',
        title: '团队 增长团队 · TL 对话',
        status: 'active',
        updated_at: '2026-08-01T00:00:00Z',
      },
      {
        id: 'session-member',
        tenant_id: 'tenant_demo',
        agent_id: 'agent-1',
        title: '写公告',
        status: 'active',
        updated_at: '2026-08-01T00:00:00Z',
      },
    ];
    return render(
      <I18nProvider>
        <TooltipProvider>
          <SidebarProvider>
            <AppSidebar
              variant="chat"
              sessions={sessions}
              agents={[agent, leaderAgent]}
              scopeTeams={scopeTeams}
              sessionFilter="all"
              onSessionFilterChange={() => {}}
              sessionFilterOptions={[{ value: 'all', label: '全部员工 · 2' }]}
              isSessionUnread={() => false}
              onOpenSession={() => {}}
              onOpenGallery={() => {}}
              onRenameSession={() => {}}
              onDeleteSession={() => {}}
              onOpenAdmin={() => {}}
            />
          </SidebarProvider>
        </TooltipProvider>
      </I18nProvider>,
    );
  }

  it('renders employee sessions and team groups as different conversation types', () => {
    renderChatSidebar();

    expect(screen.getByLabelText('群聊')).toBeTruthy();
    const groupRow = screen.getByText('增长团队').closest('[role="button"]');
    expect(groupRow?.textContent).toContain('2 位成员 · 团队群聊');
    const employeeRow = screen.getByText('写公告').closest('[role="button"]');
    expect(employeeRow?.textContent).not.toContain('群聊');
  });

  it('keeps a group label while the team roster is still loading', () => {
    renderChatSidebar([]);

    expect(screen.getByText('增长团队')).toBeTruthy();
    expect(screen.getByLabelText('群聊')).toBeTruthy();
  });

  it('shows the employee name in a styled tooltip on avatar hover', async () => {
    const user = userEvent.setup();
    renderChatSidebar();

    const employeeRow = screen.getByText('写公告').closest('[role="button"]');
    const avatar = employeeRow?.querySelector('span');
    expect(avatar).toBeTruthy();
    await user.hover(avatar as Element);

    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.textContent).toContain('小艾');
  });
});
