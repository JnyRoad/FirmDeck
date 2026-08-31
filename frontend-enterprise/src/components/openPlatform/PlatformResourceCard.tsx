import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

import IconFolder from '../../assets/icons/cap-folder.svg?react';

/** Per-module accent used for the meta line and tag pills (SD1 232:4634 family). */
export type PlatformResourceAccent = 'green' | 'blue' | 'indigo' | 'orange';

const ACCENT_STYLES: Record<PlatformResourceAccent, { meta: string; tag: string }> = {
  green: { meta: 'text-[#2cb360]', tag: 'bg-[#e9f7ef] text-[#2cb360]' },
  blue: { meta: 'text-[#27c9ff]', tag: 'bg-[#c4f1ff] text-[#25c7ff]' },
  indigo: { meta: 'text-[#1a71ff]', tag: 'bg-[#e8f0ff] text-[#1a71ff]' },
  orange: { meta: 'text-[#ff7f00]', tag: 'bg-[#fff2e5] text-[#ff7f00]' },
};

export const platformResourceAccentStyles = ACCENT_STYLES;

export type PlatformResourceCardProps = {
  title: ReactNode;
  /** Accent metric line under the title, e.g. "12M / 6个片段". */
  meta: ReactNode;
  description: ReactNode;
  tags?: string[];
  /** Full 44px icon visual. When omitted a default folder tile is shown. */
  icon?: ReactNode;
  /** Module accent color for the meta line and tag pills. Defaults to green (知识库). */
  accent?: PlatformResourceAccent;
  onClick?: () => void;
  className?: string;
};

/**
 * 广场 resource card shared by the 知识库 / 技能 / SOP / 工具 modules. It renders a
 * colorful module icon, a title with an accent meta line, a readable description
 * and a row of accent pills on a clean white card.
 */
export default function PlatformResourceCard({
  title,
  meta,
  description,
  tags,
  icon,
  accent = 'green',
  onClick,
  className,
}: PlatformResourceCardProps) {
  const accentStyles = ACCENT_STYLES[accent];
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'relative flex h-[220px] w-full shrink-0 flex-col overflow-hidden rounded-[20px] border-[0.5px] border-[#f0f1f5] bg-white p-[16px] text-left transition-shadow hover:shadow-[0_10px_24px_rgba(15,23,42,0.07)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9dd7cf]',
        className,
      )}
    >
      <div className="flex h-full w-full flex-col items-start">
        <div className="flex w-full items-center gap-[12px]">
          {icon ?? (
            <span className="grid size-[44px] shrink-0 place-items-center rounded-[12px] bg-[#f2f4f8] text-[#8a94a6]">
              <IconFolder className="size-[22px]" />
            </span>
          )}
          <div className="flex min-w-0 flex-1 flex-col gap-[4px]">
            <p className="w-full truncate text-[14px] leading-[20px] font-semibold text-[#18181a]">{title}</p>
            <p className={cn('w-full truncate text-[11px] leading-[16px] font-medium', accentStyles.meta)}>{meta}</p>
          </div>
        </div>

        <p className="mt-[18px] line-clamp-3 h-[54px] w-full text-[12px] leading-[18px] text-[#757f9c]">
          {description}
        </p>

        {tags && tags.length > 0 && (
          <div className="mt-auto flex w-full shrink-0 flex-wrap items-end gap-x-[8px] gap-y-[6px] overflow-hidden pt-[12px]">
            {tags.map((tag) => (
              <span
                key={tag}
                className={cn(
                  'inline-flex min-w-0 max-w-full shrink-0 items-center truncate rounded-[90px] px-[10px] py-[4px] text-[10px] leading-[14px]',
                  accentStyles.tag,
                )}
              >
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>
    </button>
  );
}
