import { Button as UiButton } from '@/components/ui';
import { useAppIntl } from '@/i18n/useAppIntl';
import IconAccount from '../assets/icons/sys-accounts.svg?react';
import IconAdd from '../assets/icons/add.svg?react';
import IconGlobe from '../assets/icons/globe.svg?react';

/** Render the localized empty employee state while preserving the role-specific action callbacks. */
export default function EmptyEmployeeState({
  isAdmin,
  onCreate,
  onBrowsePlatform,
}: {
  isAdmin: boolean;
  onCreate: () => void;
  onBrowsePlatform: () => void;
}) {
  const { t } = useAppIntl();
  return (
    <div className="min-h-full w-full min-w-0 max-w-full box-border px-[48px] pt-[32px] pb-[43px] max-[900px]:px-[16px]">
      <div className="mx-auto flex min-h-[calc(100vh-220px)] max-w-[560px] flex-col items-center justify-center text-center">
        <div className="relative flex size-[96px] items-center justify-center rounded-[28px] border border-[#e7dfd3] bg-white shadow-[0_12px_30px_rgba(37,32,24,0.08)]">
          <IconAccount className="size-[40px] text-[#858b9c]" />
          <span className="absolute bottom-[-8px] right-[-8px] flex size-[34px] items-center justify-center rounded-full bg-primary text-white shadow-[0_6px_16px_rgba(0,0,0,0.22)]">
            <IconAdd className="size-[18px]" />
          </span>
        </div>

        <h2 className="mt-[24px] text-[22px] font-semibold leading-tight text-[#18181a]">
          {t('emptyEmployee.title')}
        </h2>
        <p className="mt-[10px] text-[14px] leading-[22px] text-[#757f9c]">
          {t(isAdmin ? 'emptyEmployee.description.admin' : 'emptyEmployee.description.member')}
        </p>

        <div className="mt-[28px] flex flex-wrap items-center justify-center gap-[12px]">
          <UiButton
            onClick={onCreate}
            className="inline-flex h-[42px] items-center gap-[8px] rounded-[14px] bg-primary px-[22px] text-[14px] font-medium text-white hover:bg-primary/80"
          >
            <IconAdd className="size-[16px]" />
            {t('emptyEmployee.action.create')}
          </UiButton>
          <UiButton
            variant="outline"
            onClick={onBrowsePlatform}
            className="inline-flex h-[42px] items-center gap-[8px] rounded-[14px] border-[0.5px] border-[#e3e7f1] bg-white px-[22px] text-[14px] font-normal text-[#464c5e] hover:bg-[#f6f6f6] hover:text-[#464c5e]"
          >
            <IconGlobe className="size-[16px]" />
            {t('emptyEmployee.action.browse')}
          </UiButton>
        </div>
      </div>
    </div>
  );
}
