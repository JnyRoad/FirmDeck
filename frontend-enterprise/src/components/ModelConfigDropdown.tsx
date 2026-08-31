import { CheckOutlined } from '../icons';
import IconChevronDown from '../assets/icons/chevron-down.svg?react';
import type { ModelConfigRead } from '../types';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui';
import { Button as UIButton } from '@/components/ui/button';
import { MENU_CONTENT_CLASS, MENU_ITEM_CLASS } from '@/lib/enterprise-ui';
import { cn } from '@/lib/utils';
import { RawIdentifier } from '@/i18n/RawContent';
import { useAppIntl } from '@/i18n/useAppIntl';

const DEFAULT_MODEL_BUTTON_CLASS =
  'h-8 max-w-[220px] gap-1 rounded-[10px] border-[0.5px] border-[#e3e7f1] bg-white px-4 text-[12px] font-normal text-[#757f9c] hover:border-[#cbd3e6]! hover:bg-white! hover:text-[#18181a]! aria-expanded:border-[#cbd3e6]! aria-expanded:bg-white! aria-expanded:text-[#18181a]!';

type ModelConfigDropdownProps = {
  models: ModelConfigRead[];
  value: string;
  onChange: (modelId: string) => void;
  disabled?: boolean;
  buttonClassName?: string;
  menuClassName?: string;
  align?: 'start' | 'center' | 'end';
  placeholder?: string;
};

/** 本地化选择器 chrome，并将模型名与 model ID 作为 raw identifier 保留。 */
export function ModelConfigDropdown({
  models,
  value,
  onChange,
  disabled = false,
  buttonClassName,
  menuClassName,
  align = 'end',
  placeholder,
}: ModelConfigDropdownProps) {
  const { t } = useAppIntl();
  const selected = models.find((item) => item.id === value) || null;
  const label = selected?.name || selected?.model || placeholder || t('modelConfig.placeholder');

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <UIButton
          variant="outline"
          disabled={disabled || models.length === 0}
          className={cn(DEFAULT_MODEL_BUTTON_CLASS, buttonClassName)}
          title={label}
        >
          <RawIdentifier className="min-w-0 truncate" value={label} />
          <IconChevronDown className="size-[12px] shrink-0" />
        </UIButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className={cn(MENU_CONTENT_CLASS, menuClassName)}>
        {models.length === 0 ? (
          <DropdownMenuItem disabled className={MENU_ITEM_CLASS}>
            {t('modelConfig.empty')}
          </DropdownMenuItem>
        ) : (
          models.map((model) => (
            <DropdownMenuItem
              key={model.id}
              className={MENU_ITEM_CLASS}
              onSelect={() => onChange(model.id)}
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <strong className="truncate text-[13px] text-foreground">
                  <RawIdentifier value={model.name || model.model} />
                </strong>
                <em className="truncate text-[11px] not-italic text-[#858b9c]">
                  {model.is_default
                    ? t('modelConfig.defaultModel', { model: model.model })
                    : <RawIdentifier value={model.model} />}
                </em>
              </span>
              {value === model.id && <CheckOutlined />}
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
