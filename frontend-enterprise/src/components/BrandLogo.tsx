import { cn } from '@/lib/utils';
import { RawIdentifier } from '@/i18n/RawContent';
import logoMark from '../assets/firmdeck/firmdeck-logo-mark.png';

export type BrandLogoProps = {
  /** Hide the "OpenBMB / FirmDeck" wordmark and only render the logo mark. */
  markOnly?: boolean;
  /** Size of the square logo mark in pixels. */
  markSize?: number;
  className?: string;
  /** Extra classes applied to the wordmark wrapper (e.g. to hide it responsively). */
  wordmarkClassName?: string;
};

/** Brand logo lockup (logo mark + "OpenBMB" / "FirmDeck" wordmark). Figma node 504:7137. */
export default function BrandLogo({
  markOnly = false,
  markSize = 28,
  className,
  wordmarkClassName,
}: BrandLogoProps) {
  return (
    <span className={cn('flex items-center gap-[8px] overflow-hidden p-[4px]', className)}>
      <img
        src={logoMark}
        alt=""
        className="shrink-0"
        style={{ width: markSize, height: markSize }}
      />
      {!markOnly && (
        <span className={cn('flex flex-col items-center gap-[2px] leading-none', wordmarkClassName)}>
          {/* <span className="text-[12px] font-semibold leading-none text-[#0f136c]">
            OpenBMB
          </span> */}
          <strong className="text-[17px] font-semibold leading-none text-[#18181a]">
            <RawIdentifier value="FirmDeck" />
          </strong>
        </span>
      )}
      {markOnly && <RawIdentifier className="sr-only" value="FirmDeck" />}
    </span>
  );
}
