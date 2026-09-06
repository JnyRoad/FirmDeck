import { InfoCircleOutlined } from '@/icons';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { MessageId } from '@/i18n/types';
import { useAppIntl } from '@/i18n/useAppIntl';
import { cn } from '@/lib/utils';
import type { CapabilityScope } from '@/types';

export type CapabilityScopeResourceType = 'tool' | 'skill' | 'sop' | 'knowledge_base';

const SCOPE_TOOLTIP_IDS = {
  tool: 'capabilityScope.tooltip.tool',
  skill: 'capabilityScope.tooltip.skill',
  sop: 'capabilityScope.tooltip.sop',
  knowledge_base: 'capabilityScope.tooltip.knowledgeBase',
} as const satisfies Record<CapabilityScopeResourceType, MessageId>;

const SCOPE_INLINE_IDS = {
  tool: 'capabilityScope.description.tool',
  skill: 'capabilityScope.description.skill',
  sop: 'capabilityScope.description.sop',
  knowledge_base: 'capabilityScope.description.knowledgeBase',
} as const satisfies Record<CapabilityScopeResourceType, MessageId>;

const SCOPE_LABEL_IDS = {
  general: 'capabilityScope.option.general',
  sop_specific: 'capabilityScope.option.sopOnly',
} as const;

/** Return the stable message ID for a normalized capability scope. */
export function capabilityScopeLabelId(value: unknown) {
  return SCOPE_LABEL_IDS[normalizeCapabilityScope(value)];
}

/** Normalize legacy and canonical wire values without localizing the scope token. */
export function normalizeCapabilityScope(value: unknown): CapabilityScope {
  return value === 'sop_specific' || value === 'sop-specific' ? 'sop_specific' : 'general';
}

/** Return the semantic label ID for the normalized scope; callers resolve it in their locale. */
export function capabilityScopeLabel(value: unknown): typeof SCOPE_LABEL_IDS[keyof typeof SCOPE_LABEL_IDS] {
  return capabilityScopeLabelId(value);
}

/** Render a compact localized capability-scope badge. */
export function CapabilityScopeBadge({
  value,
  className,
}: {
  value: unknown;
  className?: string;
}) {
  const scope = normalizeCapabilityScope(value);
  const { t } = useAppIntl();
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-[10px] py-[4px] text-[10px] leading-none whitespace-nowrap',
        scope === 'sop_specific'
          ? 'bg-[#fff2e5] text-[#c65f00]'
          : 'bg-[#edf4ff] text-[#1a71ff]',
        className,
      )}
    >
      {t(capabilityScopeLabel(scope))}
    </span>
  );
}

/** Render the localized scope switch while keeping resource-specific guidance explicit. */
export function CapabilityScopeControl({
  value,
  onChange,
  disabled = false,
  className,
  compact = false,
  resourceType,
}: {
  value: CapabilityScope;
  onChange: (value: CapabilityScope) => void;
  disabled?: boolean;
  className?: string;
  compact?: boolean;
  resourceType: CapabilityScopeResourceType;
}) {
  const isSopSpecific = normalizeCapabilityScope(value) === 'sop_specific';
  const { t } = useAppIntl();
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-[16px] rounded-[12px] border border-[#eceef1] bg-[#fafbfc]',
        compact ? 'px-[12px] py-[10px]' : 'px-[14px] py-[12px]',
        className,
      )}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-[6px]">
          <span className="text-[13px] font-medium text-[#18181a]">{t('capabilityScope.title')}</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={t('capabilityScope.action.viewDescription')}
                className="inline-flex size-[18px] shrink-0 items-center justify-center rounded-full text-[#8b93a7] outline-none transition-colors hover:text-primary focus-visible:ring-2 focus-visible:ring-[#1a71ff]/40"
              >
                <InfoCircleOutlined className="size-[14px]" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" align="start" className="max-w-[360px] leading-[1.55]">
              {t(SCOPE_TOOLTIP_IDS[resourceType])}
            </TooltipContent>
          </Tooltip>
        </div>
        {!compact && (
          <p className="mt-[2px] text-[12px] leading-[1.55] text-[#858b9c]">
            {isSopSpecific ? t(SCOPE_INLINE_IDS[resourceType]) : t('capabilityScope.description.general')}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-[8px]">
        <span className={cn('text-[12px]', !isSopSpecific ? 'font-medium text-[#18181a]' : 'text-[#858b9c]')}>
          {t('capabilityScope.option.general')}
        </span>
        <Switch
          checked={isSopSpecific}
          disabled={disabled}
          aria-label={t('capabilityScope.action.toggle')}
          onCheckedChange={(checked) => onChange(checked ? 'sop_specific' : 'general')}
        />
        <span className={cn('text-[12px]', isSopSpecific ? 'font-medium text-[#18181a]' : 'text-[#858b9c]')}>
          {t('capabilityScope.option.sopOnly')}
        </span>
      </div>
    </div>
  );
}
