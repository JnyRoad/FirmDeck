import type { ReactNode } from 'react';

import { useAppIntl, type MessageId } from '@/i18n';
import { cn } from '@/lib/utils';

import { BADGE_TONE_CLASS, runStatusBadge, taskStatusBadge, type BadgeTone } from './shared';

export function StatusBadge({ tone, children }: { tone: BadgeTone; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-[12px] py-[4px] text-[10px] leading-none whitespace-nowrap capitalize',
        BADGE_TONE_CLASS[tone],
      )}
    >
      {children}
    </span>
  );
}

export function TaskStatusBadge({ status }: { status: string }) {
  const { locale, t } = useAppIntl();
  const { tone, text } = taskStatusBadge(status, { locale, t });
  return <StatusBadge tone={tone}>{text}</StatusBadge>;
}

/** Render a run outcome while localizing the product fallback for unknown statuses. */
export function TaskRunResultBadge({ status }: { status: string }) {
  const { locale, t } = useAppIntl();
  const preset = runStatusBadge(status, { locale, t });
  return <StatusBadge tone={preset.tone}>{preset.text}</StatusBadge>;
}
