import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

import {
  Checkbox,
  Dialog,
  DialogContent,
  DialogTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui';
import { Button } from '@/components/ui/button';
import { createMessageDescriptor, type MessageDescriptor } from '@/i18n/descriptors';
import { RawIdentifier } from '@/i18n/RawContent';
import { useAppIntl } from '@/i18n/useAppIntl';
import { cn } from '@/lib/utils';
import { SELECT_TRIGGER_CLASS } from '@/lib/enterprise-ui';

export type ImportSourceOption = { value: string; label: string };
export type ImportChoiceItem = { id: string; label: ReactNode };
type ImportText = string | MessageDescriptor;

export type ResourceImportDialogProps = {
  open: boolean;
  loading: boolean;
  /** Header icon (14px). */
  icon: ReactNode;
  title: ImportText;
  /** Optional target select for flows where the destination is not implied by page scope. */
  targetPlaceholder?: ImportText;
  targetLabel?: ImportText;
  targets?: ImportSourceOption[];
  targetId?: string;
  /** Placeholder for the "copy source" select. */
  sourcePlaceholder: ImportText;
  sources: ImportSourceOption[];
  sourceId: string;
  /** Caption above the checkbox list, e.g. "选择 SOP" / "选择技能". */
  itemsLabel: ImportText;
  items: ImportChoiceItem[];
  selectedIds: string[];
  /** Shown when a source is selected but has no importable items. */
  emptyText: ImportText;
  /** Shown before any source is selected. Defaults to "请先选择复制来源". */
  emptySourceText?: ImportText;
  /** Explanatory footer note. */
  note: ReactNode | MessageDescriptor;
  submitText?: ImportText;
  onTargetChange?: (value: string) => void;
  onSourceChange: (value: string) => void;
  onSelectedChange: (ids: string[]) => void;
  onClose: () => void;
  onSubmit: () => void;
};

/**
 * Generic "copy resources from another scope" dialog shared by the SOP and 技能
 * pages: a copy-source select plus a checkbox list of importable resources.
 */
export function ResourceImportDialog({
  open,
  loading,
  icon,
  title,
  targetPlaceholder,
  targetLabel = createMessageDescriptor('resourceImport.target.label'),
  targets,
  targetId,
  sourcePlaceholder,
  sources,
  sourceId,
  itemsLabel,
  items,
  selectedIds,
  emptyText,
  emptySourceText = createMessageDescriptor('resourceImport.empty.source'),
  note,
  submitText = createMessageDescriptor('resourceImport.action.submit'),
  onTargetChange,
  onSourceChange,
  onSelectedChange,
  onClose,
  onSubmit,
}: ResourceImportDialogProps) {
  const { t } = useAppIntl();
  const text = (value: ImportText | ReactNode | undefined): ReactNode => resolveImportText(value, t);
  const showTargetSelect = Boolean(targets && onTargetChange);
  const effectiveSourceId = sourceId || (sources.length === 1 ? sources[0].value : '');

  useEffect(() => {
    if (!open || sourceId || sources.length !== 1) return;
    onSourceChange(sources[0].value);
  }, [onSourceChange, open, sourceId, sources]);

  const toggle = (id: string, checked: boolean) => {
    onSelectedChange(checked ? [...selectedIds, id] : selectedIds.filter((value) => value !== id));
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        aria-describedby={undefined}
        className="flex max-h-[calc(100dvh-4rem)] w-[calc(100%-2rem)] flex-col gap-[16px] overflow-hidden rounded-[14px] px-[20px] py-[16px] sm:max-w-[640px]"
      >
        <div className="flex items-center gap-[6px] px-[12px] text-[#757f9c]">
          {icon}
          <DialogTitle className="text-[14px] font-normal leading-none text-[#757f9c]">
            {text(title)}
          </DialogTitle>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-[14px] overflow-y-auto px-[12px]">
          {showTargetSelect && (
            <div className="flex flex-col gap-[6px]">
              <span className="text-[11px] font-semibold text-[#858b9c]">{text(targetLabel)}</span>
              <Select value={targetId || undefined} onValueChange={onTargetChange}>
                <SelectTrigger className={cn(SELECT_TRIGGER_CLASS, 'w-full')}>
                  <SelectValue placeholder={String(text(targetPlaceholder || targetLabel) || '')} />
                </SelectTrigger>
                <SelectContent>
                  {(targets || []).map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      <RawIdentifier value={item.label} />
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="flex flex-col gap-[6px]">
            <span className="text-[11px] font-semibold text-[#858b9c]">{t('resourceImport.source.label')}</span>
            <div className="relative">
              <select
                value={effectiveSourceId}
                onChange={(event) => onSourceChange(event.target.value)}
                className={cn(
                  SELECT_TRIGGER_CLASS,
                  'w-full appearance-none px-3 pr-9 outline-none disabled:cursor-not-allowed disabled:opacity-60'
                )}
              >
                <option value="" disabled>
                  {text(sourcePlaceholder)}
                </option>
                {sources.map((item) => (
                  <option key={item.value} value={item.value} translate="no" data-i18n-raw-kind="identifier">
                    {item.label}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-[#858b9c]" />
            </div>
          </div>

          <div className="flex flex-col gap-[6px]">
            <span className="text-[11px] font-semibold text-[#858b9c]">{text(itemsLabel)}</span>
            <div className="max-h-[300px] overflow-y-auto rounded-[10px] border border-[#eef0f4] p-[6px]">
              {items.length === 0 ? (
                <div className="py-[28px] text-center text-[12px] text-[#858b9c]">
                  {text(sourceId ? emptyText : emptySourceText)}
                </div>
              ) : (
                items.map((item) => (
                  <label
                    key={item.id}
                    className="flex cursor-pointer items-center gap-[10px] rounded-[8px] px-[8px] py-[7px] hover:bg-[#f6f6f6]"
                  >
                    <Checkbox
                      checked={selectedIds.includes(item.id)}
                      onCheckedChange={(checked) => toggle(item.id, checked === true)}
                    />
                    <span className="min-w-0 flex-1 truncate text-[12px] text-[#18181a]">
                      {renderImportChoiceLabel(item.label)}
                    </span>
                  </label>
                ))
              )}
            </div>
          </div>

          <p className="text-[12px] leading-[1.6] text-[#858b9c]">{text(note)}</p>
        </div>

        <div className="flex items-center justify-end gap-[8px] px-[12px]">
          <Button
            variant="outline"
            disabled={loading}
            onClick={onClose}
            className="h-[32px] w-[80px] rounded-[10px] border-[#e3e7f1] bg-white px-[12px] text-[14px] font-normal text-[#464c5e] hover:border-[#e3e7f1] hover:bg-[#f6f6f6] hover:text-primary"
          >
            {t('resourceImport.action.cancel')}
          </Button>
          <Button
            disabled={loading}
            onClick={onSubmit}
            className="h-[32px] w-[80px] rounded-[10px] bg-primary px-[12px] text-[14px] font-normal text-white hover:bg-primary/80"
          >
            {text(submitText)}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Resolve a descriptor through the active translator while preserving legacy raw caller content. */
function resolveImportText(
  value: ImportText | ReactNode | undefined,
  translate: (id: MessageDescriptor['id'], values?: MessageDescriptor['values']) => string,
): ReactNode {
  if (isImportDescriptor(value)) return translate(value.id, value.values);
  return value ?? null;
}

/** Recognize only the descriptor shape; arbitrary React children stay untouched. */
function isImportDescriptor(value: unknown): value is MessageDescriptor {
  return typeof value === 'object'
    && value !== null
    && 'id' in value
    && typeof value.id === 'string';
}

/** Mark string resource content as raw while preserving caller-supplied React nodes. */
function renderImportChoiceLabel(label: ReactNode): ReactNode {
  return typeof label === 'string' ? <RawIdentifier value={label} /> : label;
}
