// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentProfileRead, TeamRead } from '@/types';
import { TooltipProvider } from '@/components/ui/tooltip';

const intlState = vi.hoisted(() => ({ locale: 'zh-CN' as 'zh-CN' | 'en-US' }));

vi.mock('@/i18n/useAppIntl', () => ({
  useAppIntl: () => ({
    locale: intlState.locale,
    setLocale: vi.fn(),
    t: (id: string, values?: Record<string, unknown>) => {
      const locale = intlState.locale;
      const messages: Record<string, Record<string, string | ((input?: Record<string, unknown>) => string)>> = {
        'zh-CN': {
          'capabilityScope.title': '能力范围',
          'capabilityScope.action.viewDescription': '查看仅限 SOP 说明',
          'capabilityScope.action.toggle': '切换能力范围',
          'capabilityScope.option.general': '通用',
          'capabilityScope.option.sopOnly': '仅限 SOP',
          'capabilityScope.description.general': '闲聊与 SOP 执行中均可自主调用。',
          'capabilityScope.description.tool': '仅在 SOP 步骤指定相关工具时可用。',
          'capabilityScope.tooltip.tool': '仅限SOP：只有在SOP步骤中指定相关工具时方可调用',
          'capabilityScope.loading': '正在加载员工能力',
          'employeeAvatar.ariaLabel': '员工头像',
          'employeeAvatar.dialog.title': '设置头像',
          'employeeAvatar.dialog.titleSeparator': '：',
          'employeeAvatar.mode.custom': '自定义头像',
          'employeeAvatar.preview.description': '头像会显示在我的数字员工、数字员工档案页和对话端的员工选择中。',
          'employeeAvatar.preset.heading': '默认头像',
          'employeeAvatar.preset.hint': '选择一个适合岗位的默认头像。',
          'employeeAvatar.preset.serviceOrbit': '研发员工',
          'employeeAvatar.upload.action': '上传自定义头像',
          'employeeAvatar.upload.hint': '支持常见图片格式，会自动裁剪为方形头像。',
          'employeeAvatar.action.cancel': '取消',
          'employeeAvatar.action.save': '保存头像',
          'employeeProfile.dialog.title': '编辑数字员工档案',
          'employeeProfile.dialog.titleSeparator': '：',
          'employeeProfile.preview.label': '数字员工档案',
          'employeeProfile.preview.fallbackName': '数字员工',
          'employeeProfile.field.name': '数字员工姓名',
          'employeeProfile.field.role': '岗位',
          'employeeProfile.field.onboardedAt': '入职时间',
          'employeeProfile.field.status': '工作状态',
          'employeeProfile.field.description': '岗位描述',
          'employeeProfile.field.summary': '看板摘要',
          'employeeProfile.field.persona': '岗位执行约束',
          'employeeProfile.field.defaultModel': '默认模型',
          'employeeProfile.field.maxActions': '单次 HarnessLoop 最大调用轮次',
          'employeeProfile.field.expertise': '掌握方向',
          'employeeProfile.field.workStyles': '工作风格',
          'employeeProfile.field.workModes': '工作模式',
          'employeeProfile.status.active': '在线',
          'employeeProfile.status.archived': '下线',
          'employeeProfile.placeholder.name': '例如：默认员工',
          'employeeProfile.placeholder.role': '例如：研发',
          'employeeProfile.placeholder.description': '概括这个数字员工的岗位边界、服务风格和执行重点',
          'employeeProfile.placeholder.summary': '用于数字员工档案页顶部展示的 system prompt 摘要',
          'employeeProfile.placeholder.persona': '员工在对话中的角色、人设、回复风格和执行边界',
          'employeeProfile.placeholder.tags': '输入后回车添加',
          'employeeProfile.model.inherited': '统一继承模型配置中的全局默认模型',
          'employeeProfile.model.hint': '员工不再单独绑定模型；切换全局默认模型后，所有员工立即生效。',
          'employeeProfile.maxActions.hint': '限制该员工在一轮对话中可自主执行的模型动作与能力调用总数，范围 1–100；达到上限后未完成任务会进入后续轮次。',
          'employeeProfile.gallery.label': '发布到广场',
          'employeeProfile.gallery.hint': '开启后，其他账号可以在对话端和数字员工广场中选择这个员工。',
          'employeeProfile.validation.nameRequired': '请输入数字员工姓名',
          'employeeProfile.toast.updated': '数字员工档案已更新',
          'employeeProfile.action.cancel': '取消',
          'employeeProfile.action.save': '保存资料',
          'resourceImport.target.label': '复制到',
          'resourceImport.source.label': '复制来源',
          'resourceImport.empty.source': '请先选择复制来源',
          'resourceImport.action.cancel': '取消',
          'resourceImport.action.submit': '复制',
          'emptyEmployee.title': '还没有数字员工',
          'emptyEmployee.description.admin': '创建你的第一位数字员工，为它配置知识库、技能与工具，即可开始接管对话与任务。',
          'emptyEmployee.action.create': '新建数字员工',
          'emptyEmployee.action.browse': '浏览开放广场',
          'teamCard.memberCount': (input) => `${input?.count ?? 0} 名成员`,
          'teamCard.description.empty': '暂无描述',
          'teamCard.ariaLabel': '团队卡片',
          'teamCard.leaderPrefix': '项目领导',
          'teamCard.leaderSeparator': '：',
          'teamCard.leaderMissing': '未设置',
          'teamCard.moreMembers': (input) => `+${input?.count ?? 0}`,
          'teamCard.leader.label': (input) => `项目领导：${input?.name ?? '未设置'}`,
          'chat.team.expandReply': (input) => `展开${input?.memberName ?? ''}的回复`,
          'chat.team.collapseReply': (input) => `收起${input?.memberName ?? ''}的回复`,
        },
        'en-US': {
          'capabilityScope.title': 'Capability scope',
          'capabilityScope.action.viewDescription': 'View SOP-only guidance',
          'capabilityScope.action.toggle': 'Toggle capability scope',
          'capabilityScope.option.general': 'General',
          'capabilityScope.option.sopOnly': 'SOP-only',
          'capabilityScope.description.general': 'Available during chat and SOP execution.',
          'capabilityScope.description.tool': 'Available when the tool is specified in an SOP step.',
          'capabilityScope.tooltip.tool': 'SOP-only: callable only when the related tool is specified in an SOP step.',
          'capabilityScope.loading': 'Loading employee capabilities',
          'employeeAvatar.ariaLabel': 'Employee avatar',
          'employeeAvatar.dialog.title': 'Set avatar',
          'employeeAvatar.dialog.titleSeparator': ': ',
          'employeeAvatar.mode.custom': 'Custom avatar',
          'employeeAvatar.preview.description': 'This avatar appears in employee lists, the employee profile, and employee selection in chat.',
          'employeeAvatar.preset.heading': 'Default avatar',
          'employeeAvatar.preset.hint': 'Choose a default avatar that fits the role.',
          'employeeAvatar.preset.serviceOrbit': 'Engineering employee',
          'employeeAvatar.upload.action': 'Upload custom avatar',
          'employeeAvatar.upload.hint': 'Common image formats are supported and cropped to a square avatar.',
          'employeeAvatar.action.cancel': 'Cancel',
          'employeeAvatar.action.save': 'Save avatar',
          'employeeProfile.dialog.title': 'Edit employee profile',
          'employeeProfile.dialog.titleSeparator': ': ',
          'employeeProfile.preview.label': 'Employee profile',
          'employeeProfile.preview.fallbackName': 'Digital employee',
          'employeeProfile.field.name': 'Employee name',
          'employeeProfile.field.role': 'Role',
          'employeeProfile.field.onboardedAt': 'Start date',
          'employeeProfile.field.status': 'Work status',
          'employeeProfile.field.description': 'Role description',
          'employeeProfile.field.summary': 'Dashboard summary',
          'employeeProfile.field.persona': 'Execution constraints',
          'employeeProfile.field.defaultModel': 'Default model',
          'employeeProfile.field.maxActions': 'Maximum HarnessLoop actions per turn',
          'employeeProfile.field.expertise': 'Expertise',
          'employeeProfile.field.workStyles': 'Work styles',
          'employeeProfile.field.workModes': 'Work modes',
          'employeeProfile.status.active': 'Active',
          'employeeProfile.status.archived': 'Offline',
          'employeeProfile.placeholder.name': 'For example: Default employee',
          'employeeProfile.placeholder.role': 'For example: Engineering',
          'employeeProfile.placeholder.description': 'Summarize this employee’s role boundaries, service style, and execution focus',
          'employeeProfile.placeholder.summary': 'A system prompt summary shown at the top of the employee profile',
          'employeeProfile.placeholder.persona': 'The employee’s role, persona, reply style, and execution boundaries',
          'employeeProfile.placeholder.tags': 'Type and press Enter to add',
          'employeeProfile.model.inherited': 'Uses the global default model from model settings',
          'employeeProfile.model.hint': 'Employees no longer bind to individual models; changing the global default applies immediately to every employee.',
          'employeeProfile.maxActions.hint': 'Limits model actions and capability calls in one turn to 1–100; unfinished work continues in a later turn after the limit.',
          'employeeProfile.gallery.label': 'Publish to marketplace',
          'employeeProfile.gallery.hint': 'When enabled, other accounts can choose this employee in chat and the employee marketplace.',
          'employeeProfile.validation.nameRequired': 'Enter an employee name',
          'employeeProfile.toast.updated': 'Employee profile updated',
          'employeeProfile.action.cancel': 'Cancel',
          'employeeProfile.action.save': 'Save profile',
          'resourceImport.target.label': 'Copy to',
          'resourceImport.source.label': 'Copy source',
          'resourceImport.empty.source': 'Select a copy source first',
          'resourceImport.action.cancel': 'Cancel',
          'resourceImport.action.submit': 'Copy',
          'emptyEmployee.title': 'No digital employees yet',
          'emptyEmployee.description.admin': 'Create your first digital employee, configure its knowledge bases, skills, and tools, and let it take over conversations and tasks.',
          'emptyEmployee.action.create': 'Create digital employee',
          'emptyEmployee.action.browse': 'Browse marketplace',
          'teamCard.memberCount': (input) => `${input?.count ?? 0} member${input?.count === 1 ? '' : 's'}`,
          'teamCard.description.empty': 'No description',
          'teamCard.ariaLabel': 'Team card',
          'teamCard.leaderPrefix': 'Project lead',
          'teamCard.leaderSeparator': ': ',
          'teamCard.leaderMissing': 'Not set',
          'teamCard.moreMembers': (input) => `+${input?.count ?? 0}`,
          'teamCard.leader.label': (input) => `Project lead: ${input?.name ?? 'Not set'}`,
          'chat.team.expandReply': (input) => `Expand ${input?.memberName ?? ''}’s reply`,
          'chat.team.collapseReply': (input) => `Collapse ${input?.memberName ?? ''}’s reply`,
        },
      };
      const message = messages[locale][id];
      return typeof message === 'function' ? message(values) : message ?? `${locale}:${id}`;
    },
  }),
}));

import CapabilityScopeLoading from './CapabilityScopeLoading';
import { CapabilityScopeControl } from './CapabilityScopeControl';
import EmptyEmployeeState from './EmptyEmployeeState';
import EmployeeAvatar from './EmployeeAvatar';
import EmployeeAvatarEditor from './EmployeeAvatarEditor';
import EmployeeProfileEditor from './EmployeeProfileEditor';
import { ResourceImportDialog } from './ResourceImportDialog';
import TeamCard from './TeamCard';

const agent: AgentProfileRead = {
  id: 'agent-1',
  tenant_id: 'tenant_demo',
  name: '小艾',
  description: '负责原始业务描述',
  persona_prompt: '保持原始执行约束',
  is_overall: false,
  status: 'active',
  metadata: {
    role_name: '项目负责人',
    avatar_text: '艾',
    avatar_preset: 'service-orbit',
  },
  resources: [],
  created_at: '2026-08-15T00:00:00Z',
  updated_at: '2026-08-15T00:00:00Z',
};

const team: TeamRead = {
  id: 'team-1',
  tenant_id: 'tenant_demo',
  name: '运营团队',
  description: '团队原始描述',
  owner_user_id: 'user-1',
  config: {},
  status: 'active',
  members: [
    {
      id: 'member-1',
      team_id: 'team-1',
      agent_id: agent.id,
      agent_name: agent.name,
      role: 'leader',
      created_at: '2026-08-15T00:00:00Z',
    },
  ],
  created_at: '2026-08-15T00:00:00Z',
  updated_at: '2026-08-15T00:00:00Z',
};

afterEach(() => {
  cleanup();
  intlState.locale = 'zh-CN';
});

describe('employee and capability semantic chrome', () => {
  it.each([
    ['zh-CN', '能力范围', '仅在 SOP 步骤指定相关工具时可用。'],
    ['en-US', 'Capability scope', 'Available when the tool is specified in an SOP step.'],
  ] as const)('localizes capability scope chrome in %s', (locale, title, description) => {
    intlState.locale = locale;
    render(
      <TooltipProvider>
        <CapabilityScopeControl value="sop_specific" onChange={vi.fn()} resourceType="tool" />
      </TooltipProvider>,
    );

    expect(screen.getByText(title)).toBeTruthy();
    expect(screen.getByText(description)).toBeTruthy();
    expect(screen.getByRole('button', { name: locale === 'en-US' ? 'View SOP-only guidance' : '查看仅限 SOP 说明' })).toBeTruthy();
    expect(screen.getByRole('switch', { name: locale === 'en-US' ? 'Toggle capability scope' : '切换能力范围' })).toBeTruthy();
  });

  it.each([
    ['zh-CN', '正在加载员工能力'],
    ['en-US', 'Loading employee capabilities'],
  ] as const)('localizes capability loading status in %s', (locale, label) => {
    intlState.locale = locale;
    render(<CapabilityScopeLoading />);

    expect(screen.getByRole('status', { name: label })).toBeTruthy();
    expect(screen.getByText(label)).toBeTruthy();
  });

  it.each([
    ['zh-CN', '设置头像', '研发员工', '上传自定义头像'],
    ['en-US', 'Set avatar', 'Engineering employee', 'Upload custom avatar'],
  ] as const)('localizes avatar editor chrome and preserves employee name in %s', (locale, title, preset, upload) => {
    intlState.locale = locale;
    render(<EmployeeAvatarEditor agent={agent} open onClose={vi.fn()} />);

    expect(screen.getByText(title)).toBeTruthy();
    expect(screen.getAllByText(preset).length).toBeGreaterThan(0);
    expect(screen.getByText(upload)).toBeTruthy();
    expect(screen.getByText('小艾')).toBeTruthy();
  });

  it.each([
    ['zh-CN', '编辑数字员工档案', '数字员工姓名', '请输入数字员工姓名'],
    ['en-US', 'Edit employee profile', 'Employee name', 'Enter an employee name'],
  ] as const)('localizes profile editor labels and placeholders in %s', (locale, title, label, placeholder) => {
    intlState.locale = locale;
    render(<EmployeeProfileEditor agent={agent} open onClose={vi.fn()} />);

    expect(screen.getByText(title)).toBeTruthy();
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.getByPlaceholderText(locale === 'en-US' ? 'For example: Default employee' : '例如：默认员工')).toBeTruthy();
    expect(screen.getByDisplayValue('小艾')).toBeTruthy();
    expect(screen.getByDisplayValue('负责原始业务描述')).toBeTruthy();
    expect(screen.queryByText(placeholder)).toBeNull();
  });

  it('lets long English dialog actions size to their localized content without wrapping', () => {
    intlState.locale = 'en-US';
    render(<EmployeeProfileEditor agent={agent} open onClose={vi.fn()} />);

    const save = screen.getByRole('button', { name: 'Save profile' });
    const classTokens = save.className.split(/\s+/);
    expect(classTokens).toContain('min-w-[80px]');
    expect(classTokens).toContain('whitespace-nowrap');
    expect(classTokens).not.toContain('w-[80px]');
  });

  it.each([
    ['zh-CN', '还没有数字员工', '新建数字员工', '浏览开放广场'],
    ['en-US', 'No digital employees yet', 'Create digital employee', 'Browse marketplace'],
  ] as const)('localizes empty employee actions in %s', (locale, title, createAction, browseAction) => {
    intlState.locale = locale;
    render(<EmptyEmployeeState isAdmin onCreate={vi.fn()} onBrowsePlatform={vi.fn()} />);

    expect(screen.getByText(title)).toBeTruthy();
    expect(screen.getByRole('button', { name: createAction })).toBeTruthy();
    expect(screen.getByRole('button', { name: browseAction })).toBeTruthy();
  });

  it.each([
    ['zh-CN', '2 名成员', '项目领导：小艾'],
    ['en-US', '2 members', 'Project lead: 小艾'],
  ] as const)('localizes team card count and preserves team data in %s', (locale, count, leader) => {
    intlState.locale = locale;
    const twoMemberTeam: TeamRead = {
      ...team,
      members: [
        ...team.members,
        {
          ...team.members[0],
          id: 'member-2',
          agent_id: 'agent-2',
          agent_name: '小周',
        },
      ],
    };
    render(<TeamCard team={twoMemberTeam} agents={[agent]} onOpen={vi.fn()} />);

    expect(screen.getByText('运营团队')).toBeTruthy();
    expect(screen.getByText('团队原始描述')).toBeTruthy();
    expect(screen.getByText(count)).toBeTruthy();
    const leaderName = screen.getByText('小艾');
    expect(leaderName.parentElement?.parentElement?.textContent).toContain(leader);
  });

  it.each([
    ['zh-CN', '复制来源', '取消', '复制'],
    ['en-US', 'Copy source', 'Cancel', 'Copy'],
  ] as const)('localizes resource import dialog controls in %s', (locale, sourceLabel, cancel, submit) => {
    intlState.locale = locale;
    render(
      <ResourceImportDialog
        open
        loading={false}
        icon={null}
        title={{ id: 'resourceImport.target.label' }}
        sourcePlaceholder={{ id: 'resourceImport.empty.source' }}
        sources={[]}
        sourceId=""
        itemsLabel={{ id: 'resourceImport.source.label' }}
        items={[]}
        selectedIds={[]}
        emptyText={{ id: 'resourceImport.empty.source' }}
        note={{ id: 'resourceImport.target.label' }}
        onSourceChange={vi.fn()}
        onSelectedChange={vi.fn()}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />
    );

    expect(screen.getAllByText(sourceLabel).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: cancel })).toBeTruthy();
    expect(screen.getByRole('button', { name: submit })).toBeTruthy();
  });

  it('uses a locale-aware avatar aria label without translating avatarText', () => {
    intlState.locale = 'en-US';
    render(
      <>
        <EmployeeAvatar agent={agent} />
        <span data-testid="raw-avatar-text" translate="no" data-i18n-raw-kind="identifier">艾</span>
      </>,
    );

    expect(screen.getByLabelText('Employee avatar')).toBeTruthy();
    expect(screen.getByTestId('raw-avatar-text').textContent).toBe('艾');
  });
});
