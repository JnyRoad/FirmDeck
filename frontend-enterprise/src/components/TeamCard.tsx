import { Badge } from '@/components/ui';
import { useAppIntl } from '@/i18n/useAppIntl';
import { RawContent, RawIdentifier } from '@/i18n/RawContent';

import type { AgentProfileRead, TeamMemberRead, TeamRead } from '../types';
import EmployeeAvatar from './EmployeeAvatar';

export type TeamCardProps = {
  team: TeamRead;
  /** 画廊已加载的员工列表，用于把成员 agent_id 映射到头像。 */
  agents: AgentProfileRead[];
  busy?: boolean;
  onOpen: () => void;
};

export function teamLeader(team: TeamRead): TeamMemberRead | null {
  return (team.members || []).find((member) => member.role === 'leader') || null;
}

/** Render a localized team card while marking team-owned names and descriptions as raw. */
export default function TeamCard({ team, agents, busy = false, onOpen }: TeamCardProps) {
  const { t } = useAppIntl();
  const members = team.members || [];
  const leader = teamLeader(team);
  const stacked = members.slice(0, 3);
  const extraCount = members.length - stacked.length;
  const agentById = (agentId: string) => agents.find((agent) => agent.id === agentId) || null;

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={t('teamCard.ariaLabel')}
      aria-busy={busy}
      onClick={() => {
        if (!busy) onOpen();
      }}
      onKeyDown={(event) => {
        if (!busy && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          onOpen();
        }
      }}
      className="flex cursor-pointer flex-col gap-[12px] rounded-[20px] border border-[#F6F6F6] bg-white p-[20px] transition-shadow hover:shadow-[0_16px_30px_0_rgba(0,0,0,0.10)]"
    >
      <div className="flex items-start justify-between gap-[8px]">
        <span className="min-w-0 truncate text-[16px] font-medium text-[#18181a]" title={team.name}>
          <RawIdentifier value={team.name} />
        </span>
        <Badge
          variant="secondary"
          className="shrink-0 rounded-full bg-[#f2f3f7] text-[12px] font-normal text-[#464c5e]"
        >
          {t('teamCard.memberCount', { count: members.length })}
        </Badge>
      </div>
      <p className="line-clamp-2 min-h-[34px] text-[12px] leading-[17px] text-[#757f9c]">
        {team.description ? <RawContent value={team.description} /> : t('teamCard.description.empty')}
      </p>
      <div className="flex items-center justify-between gap-[8px]">
        <span className="flex min-w-0 items-center gap-[6px] text-[12px] text-[#757f9c]">
          {leader && (
            <EmployeeAvatar agent={agentById(leader.agent_id)} size={20} className="shrink-0" />
          )}
          <span className="truncate">
            {t('teamCard.leaderPrefix')}{t('teamCard.leaderSeparator')}
            {leader?.agent_name
              ? <RawIdentifier value={leader.agent_name} />
              : t('teamCard.leaderMissing')}
          </span>
        </span>
        <span className="flex shrink-0 items-center">
          {stacked.map((member) => (
            <EmployeeAvatar
              key={member.id}
              agent={agentById(member.agent_id)}
              size={24}
              className="-ml-[6px] ring-2 ring-white first:ml-0"
            />
          ))}
          {extraCount > 0 && (
            <span className="-ml-[6px] grid size-[24px] place-items-center rounded-full bg-[#eef1f6] text-[10px] text-[#464c5e] ring-2 ring-white">
              {t('teamCard.moreMembers', { count: extraCount })}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}
