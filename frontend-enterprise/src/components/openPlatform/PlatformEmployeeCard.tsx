import { Ban } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

import IconArrowRight from '../../assets/icons/arrow-right.svg?react';

export type PlatformStat = {
  value: ReactNode;
  label: string;
};

export type PlatformEmployeeCardProps = {
  /** Avatar illustration, typically an <EmployeeAvatar />. */
  avatar: ReactNode;
  name: ReactNode;
  role: ReactNode;
  online?: boolean;
  description: ReactNode;
  /** Bottom metric segments (资料 / 技能 / SOP …). */
  stats: PlatformStat[];
  onOpen?: () => void;
  onUnpublish?: () => void;
  unpublishing?: boolean;
  className?: string;
  copy?: Partial<PlatformEmployeeCardCopy>;
};

export type PlatformEmployeeCardCopy = {
  statusOnline: string;
  statusOffline: string;
  unpublishAria: string;
  unpublishTitle: string;
  unpublishAction: string;
};

const DEFAULT_PLATFORM_EMPLOYEE_CARD_COPY: PlatformEmployeeCardCopy = {
  statusOnline: '在线',
  statusOffline: '下线',
  unpublishAria: '从广场下线',
  unpublishTitle: '从广场下线',
  unpublishAction: '下线',
};

/** Readable 数字员工广场 card aligned with the primary employee gallery. */
export default function PlatformEmployeeCard({
  avatar,
  name,
  role,
  online = true,
  description,
  stats,
  onOpen,
  onUnpublish,
  unpublishing = false,
  className,
  copy,
}: PlatformEmployeeCardProps) {
  const ui = { ...DEFAULT_PLATFORM_EMPLOYEE_CARD_COPY, ...copy };
  return (
    <article
      className={cn(
        'group relative h-[262px] w-full shrink-0 rounded-[20px] border-[0.5px] border-[#f6f6f6] bg-white px-[10px] py-[12px] text-left transition-shadow hover:shadow-[0_10px_24px_rgba(0,0,0,0.06)]',
        className,
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex h-full w-full flex-col justify-end gap-[12px] rounded-[16px] text-left outline-none focus-visible:ring-2 focus-visible:ring-[#9dd7cf]"
      >
        <div className="flex w-full flex-col pt-[34px]">
          <div className="flex h-[68px] w-full items-end justify-between rounded-[16px] bg-[#f6f6f6] px-[10px] pb-[6px] pt-[8px]">
            <div className="flex min-w-0 flex-1 items-end gap-[12px]">
              <div className="relative flex h-[94px] w-[80px] shrink-0 items-end justify-center">
                {avatar}
              </div>
              <div className="flex min-w-0 flex-1 flex-col items-start justify-center gap-[3px] pb-[1px]">
                <p className="w-full truncate text-[12px] leading-[17px] font-semibold text-[#18181a]">{name}</p>
                <p className="w-full truncate text-[10px] leading-[15px] text-[#757f9c]">{role}</p>
                <span className="inline-flex min-w-[42px] items-center justify-center rounded-[90px] bg-white px-[6px] py-[3px]">
                  <span className="flex items-center gap-[2px]">
                    <i
                      className={cn('size-[4px] shrink-0 rounded-full', online ? 'bg-[#22c55e]' : 'bg-[#9ca3af]')}
                      aria-hidden="true"
                    />
                    <span className="text-[8px] leading-[11px] text-[#757f9c]">
                      {online ? ui.statusOnline : ui.statusOffline}
                    </span>
                  </span>
                </span>
              </div>
            </div>
            <span className="grid size-[28px] shrink-0 self-center place-items-center rounded-[10px] bg-white text-[#757f9c] transition-colors group-hover:text-[#18181a]">
              <IconArrowRight className="size-[15px]" />
            </span>
          </div>
        </div>

        <p className="line-clamp-2 h-[36px] w-full px-[4px] text-[12px] leading-[18px] text-[#757f9c]">
          {description}
        </p>

        <div className="flex w-full items-stretch">
          {stats.map((stat, index) => (
            <div
              key={stat.label}
              className={cn(
                'flex h-[58px] min-w-0 flex-1 flex-col items-center justify-center border-[0.5px] border-[#e3e7f1] px-[6px]',
                index === 0 && 'rounded-l-[14px]',
                index === stats.length - 1 && 'rounded-r-[14px]',
                index > 0 && 'border-l-0',
              )}
            >
              <span className="text-[18px] leading-[24px] font-medium tabular-nums text-[#18181a]">{stat.value}</span>
              <span className="max-w-full truncate text-[10px] leading-[14px] text-[#464c5e]">{stat.label}</span>
            </div>
          ))}
        </div>
      </button>

      {onUnpublish && (
        <button
          type="button"
          aria-label={ui.unpublishAria}
          title={ui.unpublishTitle}
          disabled={unpublishing}
          onClick={onUnpublish}
          className={cn(
            'absolute top-[12px] right-[12px] inline-flex h-[28px] max-w-[calc(100%-24px)] items-center gap-[5px] rounded-[9px] border border-[#f3c7c7] bg-white px-[9px] text-[10px] font-medium text-[#b42318] shadow-[0_3px_10px_rgba(20,20,20,0.06)] transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f1aaaa]',
            'hover:border-[#e49b9b] hover:bg-[#fff7f7] disabled:cursor-wait disabled:opacity-50',
          )}
        >
          <Ban className="size-[12px] shrink-0" strokeWidth={1.8} />
          <span className="truncate">{ui.unpublishAction}</span>
        </button>
      )}
    </article>
  );
}
