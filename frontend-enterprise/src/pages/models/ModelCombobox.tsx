import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { LoaderCircle } from 'lucide-react';

import { createAppTranslator, getStoredLocale } from '@/i18n';
import { AppIntlContext } from '@/i18n/provider';

export type ModelComboboxOption = { value: string; label: string };

type ModelComboboxProps = {
  value: string;
  onChange: (value: string) => void;
  options: ModelComboboxOption[];
  loading?: boolean;
  disabled?: boolean;
  placeholder?: string;
};

/** 为独立测试和受控页面提供一致的翻译入口；缺少 Provider 时回退到存储 locale。 */
function useModelComboboxIntl() {
  const context = useContext(AppIntlContext);
  return useMemo(() => context ?? createAppTranslator(getStoredLocale()), [context]);
}

export default function ModelCombobox({
  value,
  onChange,
  options,
  loading = false,
  disabled = false,
  placeholder,
}: ModelComboboxProps) {
  const { t } = useModelComboboxIntl();
  const [open, setOpen] = useState(false);
  // Filtering the dropdown by `value` (the committed selection) means
  // reopening it right after picking a model shows only that one match —
  // `query` tracks what the user is actively typing instead, and resets to
  // null (no filter) once a value is committed by selection.
  const [query, setQuery] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open]);

  const filtered = useMemo(() => {
    const keyword = (query ?? '').trim().toLowerCase();
    if (!keyword) return options;
    return options.filter(
      (option) => option.label.toLowerCase().includes(keyword) || option.value.toLowerCase().includes(keyword),
    );
  }, [options, query]);

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <input
        type="text"
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        autoComplete="off"
        data-1p-ignore="true"
        data-lpignore="true"
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          onChange(event.target.value);
          setQuery(event.target.value);
          setOpen(true);
        }}
        className="h-[36px] w-full rounded-[9px] border border-[#e3e7f1] px-[12px] text-[13px] text-[#18181a] outline-none focus:border-primary disabled:cursor-not-allowed disabled:bg-[#f9fafb] disabled:text-[#b7bccb]"
      />
      {loading && (
        <LoaderCircle className="absolute top-[11px] right-[12px] size-[14px] animate-spin text-[#858b9c]" />
      )}
      {open && !disabled && (
        <div className="absolute top-[calc(100%+4px)] left-0 z-10 max-h-[220px] w-full overflow-y-auto rounded-[10px] border border-[#e3e7f1] bg-white p-[4px] shadow-[0_8px_24px_rgba(20,20,30,0.12)]">
          {loading ? (
            <p className="px-[10px] py-[10px] text-center text-[12px] text-[#858b9c]">{t('modelSetup.models.loading')}</p>
          ) : filtered.length === 0 ? (
            <p className="px-[10px] py-[10px] text-center text-[12px] text-[#858b9c]">
              {options.length === 0 ? t('modelSetup.models.empty') : t('modelSetup.models.noMatch')}
            </p>
          ) : (
            filtered.map((option) => (
              <button
                key={option.value}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  onChange(option.value);
                  setQuery(null);
                  setOpen(false);
                }}
                className="block w-full rounded-[7px] px-[10px] py-[7px] text-left text-[13px] text-[#18181a] hover:bg-[#f6f6f7]"
              >
                {option.label}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
