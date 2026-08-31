import { Crown } from 'lucide-react';

import { Badge } from '@/components/ui';
import { useAppIntl, type MessageId, type MessageValues } from '@/i18n';
import { RawContent, RawIdentifier } from '@/i18n/RawContent';
import { cn } from '@/lib/utils';

import type { AgentProfileRead, TeamTaskBidRead } from '../types';

import EmployeeAvatar from './EmployeeAvatar';

type BiddingArenaMessageId = MessageId;

type BiddingArenaTranslate = (id: BiddingArenaMessageId, values?: MessageValues) => string;

export const BID_HP_MAX = 100;

/** HP 扣减 = (10 - 该轮得分) × 3，下限 0；无得分的历史数据按满血显示。 */
export function computeBidHp(bids: TeamTaskBidRead[]): number {
  let hp = BID_HP_MAX;
  bids.forEach((bid) => {
    if (bid.score == null) return;
    hp -= (10 - bid.score) * 3;
  });
  return Math.max(0, Math.min(BID_HP_MAX, hp));
}

function hpBarClass(hp: number): string {
  if (hp <= 0) return 'bg-[#c3c8d4]';
  if (hp < 30) return 'bg-[#f5483b]';
  if (hp < 60) return 'bg-[#f5a83b]';
  return 'bg-[#35b26f]';
}

const BUBBLE_STYLES = [
  'bg-[#e8f0ff]',
  'bg-[#eaf7ee]',
  'bg-[#fdf1e3]',
  'bg-[#f3e8ff]',
  'bg-[#e6f6f7]',
];

/** Localize the finite bid-kind enum while preserving unknown protocol values verbatim. */
function bidKindLabel(kind: string, translate: BiddingArenaTranslate): string {
  if (kind === 'rebuttal') return translate('teamDetailPage.bidding.kind.rebuttal');
  if (kind === 'statement') return translate('teamDetailPage.bidding.kind.statement');
  return kind;
}

type BiddingArenaProps = {
  bids: TeamTaskBidRead[];
  /** 已裁决时的胜者 agent_id；竞标中或未裁决传 null。 */
  winnerId?: string | null;
  /** 用于解析候选人头像。 */
  agents?: AgentProfileRead[];
  /** bid.agent_name 缺失时的兜底名称解析。 */
  resolveName?: (agentId: string) => string;
};

export default function BiddingArena({
  bids,
  winnerId = null,
  agents = [],
  resolveName,
}: BiddingArenaProps) {
  const { t: appT } = useAppIntl();
  /** Format one bidding-arena chrome label from the canonical semantic catalog. */
  function t(id: BiddingArenaMessageId, values?: MessageValues): string {
    return appT(id, values);
  }

  const agentById = new Map(agents.map((agent) => [agent.id, agent]));

  const candidateIds: string[] = [];
  const bidsByAgent = new Map<string, TeamTaskBidRead[]>();
  bids.forEach((bid) => {
    if (!bidsByAgent.has(bid.agent_id)) {
      bidsByAgent.set(bid.agent_id, []);
      candidateIds.push(bid.agent_id);
    }
    bidsByAgent.get(bid.agent_id)?.push(bid);
  });

  const rounds = [...new Set(bids.map((bid) => bid.round))].sort((a, b) => a - b);

  /** Resolve an employee identifier for raw display; it never enters the product message catalog. */
  function candidateName(bid: TeamTaskBidRead | undefined, agentId: string): string {
    return bid?.agent_name || resolveName?.(agentId) || agentId;
  }

  return (
    <div className="grid grid-cols-1 gap-[10px] sm:grid-cols-2">
      {candidateIds.map((agentId, index) => {
        const candidateBids = bidsByAgent.get(agentId) || [];
        const hp = computeBidHp(candidateBids);
        const eliminated = hp <= 0;
        const isWinner = winnerId === agentId;
        const bubbleStyle = BUBBLE_STYLES[index % BUBBLE_STYLES.length];
        return (
          <div
            key={agentId}
            data-testid={`arena-candidate-${agentId}`}
            className={cn(
              'rounded-[12px] border border-[#eef1f6] p-[12px]',
              eliminated && 'opacity-60 grayscale',
            )}
          >
            <div className="flex items-center gap-[8px]">
              <EmployeeAvatar agent={agentById.get(agentId)} size={32} radius={10} />
              <span className="min-w-0 truncate text-[14px] font-medium text-[#18181a]">
                <RawIdentifier value={candidateName(candidateBids[0], agentId)} />
              </span>
              {isWinner && (
                <Badge
                  variant="secondary"
                  className="shrink-0 gap-[2px] rounded-full bg-[#fff3d6] text-[11px] font-normal text-[#b57900]"
                >
                  <Crown className="size-[12px]" />
                  {t('teamDetailPage.bidding.winner')}
                </Badge>
              )}
              {eliminated && (
                <Badge
                  variant="secondary"
                  className="shrink-0 rounded-full bg-[#f2f3f7] text-[11px] font-normal text-[#858b9c]"
                >
                  {t('teamDetailPage.bidding.eliminated')}
                </Badge>
              )}
              <span className="ml-auto shrink-0 text-[12px] text-[#858b9c]">
                {t('teamDetailPage.bidding.hp', { hp })}
              </span>
            </div>
            <div className="mt-[8px] h-[8px] overflow-hidden rounded-full bg-[#f2f3f7]">
              <div
                data-testid={`arena-hp-${agentId}`}
                className={cn('h-full rounded-full transition-[width] duration-500', hpBarClass(hp))}
                style={{ width: `${hp}%` }}
              />
            </div>
            <div className="mt-[10px] flex flex-col gap-[8px]">
              {rounds.map((round) => {
                const roundBids = candidateBids.filter((bid) => bid.round === round);
                if (roundBids.length === 0) return null;
                return (
                  <div key={round}>
                    <p className="mb-[4px] text-[11px] font-medium text-[#a7adbb]">
                      {t('teamDetailPage.bidding.round', { round })}
                    </p>
                    <div className="flex flex-col gap-[6px]">
                      {roundBids.map((bid) => (
                        <div
                          key={bid.id}
                          className={cn('rounded-[10px] px-[10px] py-[8px]', bubbleStyle)}
                        >
                          <div className="mb-[2px] flex flex-wrap items-center gap-[6px] text-[11px] text-[#464c5e]">
                            <span className="font-medium">{bidKindLabel(bid.kind, t)}</span>
                            {bid.score != null && (
                              <span>{t('teamDetailPage.bidding.score', { score: bid.score })}</span>
                            )}
                          </div>
                          <p className="text-[13px] leading-[20px] whitespace-pre-wrap text-[#18181a]">
                            <RawContent value={bid.content} />
                          </p>
                          {bid.score_rationale && (
                            <p className="mt-[4px] text-[12px] leading-[18px] whitespace-pre-wrap text-[#464c5e]">
                              <RawContent value={bid.score_rationale} />
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
