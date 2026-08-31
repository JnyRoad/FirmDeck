import EmployeeAvatar from '@/components/EmployeeAvatar';
import { teamLeader } from '@/components/TeamCard';
import { employeeDisplayName } from '@/employee';
import { RawContent, RawIdentifier } from '@/i18n/RawContent';
import { useAppIntl } from '@/i18n/useAppIntl';

import {
  CHAT_EMPTY_CARD_CLASS,
  CHAT_EMPTY_CLASS,
  CHAT_EMPTY_GREETING_CARD_CLASS,
  CHAT_EMPTY_ROLE_CLASS,
  CHAT_EMPTY_STAT_CELL_CLASS,
  CHAT_EMPTY_SUBTITLE_CLASS,
  CHAT_EMPTY_TAGS_CLASS,
  CHAT_EMPTY_TITLE_CLASS,
} from '../chatPageStyles';
import type { UseChatSession } from '../useChatSession';

function greetingFontSize(displayName: string): number {
  const length = Array.from(displayName).length;
  return length > 20 ? 20 : length > 12 ? 24 : length > 6 ? 30 : 36;
}

export default function ChatEmptyState({ chat }: { chat: UseChatSession }) {
  if (chat.currentSession?.team_id) {
    return <TeamEmptyCard chat={chat} />;
  }
  return <EmployeeEmptyCard chat={chat} />;
}

/** 渲染员工会话空状态；员工资料与标签属于 raw 业务数据。 */
function EmployeeEmptyCard({ chat }: { chat: UseChatSession }) {
  const { displayedAgent, displayedProfile, emptyRoleSummary, emptyProfileTags, emptyStats } = chat;
  const { t } = useAppIntl();
  const displayName = displayedAgent ? employeeDisplayName(displayedAgent) : '';

  return (
    <div className={CHAT_EMPTY_CLASS}>
      <div className={CHAT_EMPTY_GREETING_CARD_CLASS}>
        <div className="flex min-h-[102px] w-full gap-[10px]">
          <div className="relative h-[102px] w-[136px] shrink-0 self-end">
            <div className="absolute bottom-0 left-0 h-[160px] w-[136px]">
            <EmployeeAvatar
              profile={displayedProfile ?? undefined}
              agent={displayedAgent ?? undefined}
              width={136}
              height={160}
              radius={0}
              fit="cover"
              objectPosition="bottom"
              className="bg-transparent!"
            />
            </div>
          </div>
          <div className="flex min-w-0 flex-1 flex-col justify-center gap-[8px] py-[12px] capitalize">
            <strong
              className={`${CHAT_EMPTY_TITLE_CLASS} max-w-full [overflow-wrap:anywhere]`}
              style={{ fontSize: `${greetingFontSize(displayName)}px` }}
              title={displayName}
            >
              {t('chat.empty.greetingEmployee', { name: displayName })}
            </strong>
            <span className={CHAT_EMPTY_SUBTITLE_CLASS}>{t('chat.empty.prompt')}</span>
          </div>
        </div>
      </div>

      <div className={CHAT_EMPTY_CARD_CLASS}>
        <div className="flex min-w-0 flex-1 flex-col justify-center gap-[8px] px-[4px]">
          <p className={CHAT_EMPTY_ROLE_CLASS}>{emptyRoleSummary}</p>
          <div className={CHAT_EMPTY_TAGS_CLASS}>
            {emptyProfileTags.map((tag, index) => (
              <span key={`${tag}-${index}`} translate="no" data-i18n-raw-kind="content">
                <RawContent value={tag} />
              </span>
            ))}
          </div>
        </div>
        <div className="flex flex-1 items-stretch">
          {emptyStats.map((item) => (
            <div key={item.label} className={CHAT_EMPTY_STAT_CELL_CLASS}>
              <span className="text-[18px] font-medium leading-none">{item.value}</span>
              <span className="text-[10px] leading-none">{item.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** 渲染团队会话空状态；团队名称、成员名和描述均保持原始业务内容。 */
function TeamEmptyCard({ chat }: { chat: UseChatSession }) {
  const { displayedTeam, currentSession, agents, teamEmptyStats } = chat;
  const { t } = useAppIntl();
  const members = displayedTeam?.members || [];
  const leader = displayedTeam ? teamLeader(displayedTeam) : null;
  const teamName = displayedTeam?.name || currentSession?.team_name || '';
  const agentById = (agentId: string) => agents.find((agent) => agent.id === agentId) || null;
  const summary = displayedTeam?.description?.trim() || t('chat.empty.teamSummary', {
    count: members.length,
    leader: leader?.agent_name || t('chat.empty.unset'),
  });
  const memberTags = members.slice(0, 5).map((member) => ({
    name: member.agent_name || t('chat.empty.unset'),
    isLeader: member.role === 'leader',
  }));
  const stats = [
    { label: t('chat.empty.memberCount'), value: members.length },
    { label: t('chat.empty.taskCount'), value: teamEmptyStats.tasks },
    { label: t('chat.empty.blackboardCount'), value: teamEmptyStats.blackboard },
  ];

  return (
    <div className={CHAT_EMPTY_CLASS}>
      <div className={CHAT_EMPTY_GREETING_CARD_CLASS}>
        <div className="flex min-h-[102px] w-full gap-[10px]">
          <div className="relative h-[102px] w-[136px] shrink-0 self-end">
            <div className="absolute inset-x-0 bottom-[14px] flex items-center justify-center">
              {members.slice(0, 3).map((member) => (
                <EmployeeAvatar
                  key={member.id}
                  agent={agentById(member.agent_id)}
                  size={56}
                  className="-ml-[14px] shrink-0 rounded-full ring-4 ring-[#f6f6f6] first:ml-0"
                />
              ))}
            </div>
          </div>
          <div className="flex min-w-0 flex-1 flex-col justify-center gap-[8px] py-[12px] capitalize">
            <strong
              className={`${CHAT_EMPTY_TITLE_CLASS} max-w-full [overflow-wrap:anywhere]`}
              style={{ fontSize: `${greetingFontSize(teamName)}px` }}
              title={teamName}
            >
              {t('chat.empty.greetingTeam', { name: teamName })}
            </strong>
            <span className={CHAT_EMPTY_SUBTITLE_CLASS}>{t('chat.empty.prompt')}</span>
          </div>
        </div>
      </div>

      <div className={CHAT_EMPTY_CARD_CLASS}>
        <div className="flex min-w-0 flex-1 flex-col justify-center gap-[8px] px-[4px]">
            {displayedTeam?.description ? (
              <p
                className={CHAT_EMPTY_ROLE_CLASS}
                translate="no"
                data-i18n-raw-kind="content"
              >
                <RawContent value={summary} />
              </p>
            ) : (
              <p className={CHAT_EMPTY_ROLE_CLASS}>{summary}</p>
            )}
          <div className={CHAT_EMPTY_TAGS_CLASS}>
            {memberTags.map((tag, index) => (
              <span key={`${tag.name}-${index}`}>
                <RawIdentifier value={tag.name} />
                {tag.isLeader ? ` · ${t('chat.empty.projectLead')}` : null}
              </span>
            ))}
          </div>
        </div>
        <div className="flex flex-1 items-stretch">
          {stats.map((item) => (
            <div key={item.label} className={CHAT_EMPTY_STAT_CELL_CLASS}>
              <span className="text-[18px] font-medium leading-none">{item.value}</span>
              <span className="text-[10px] leading-none">{item.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
