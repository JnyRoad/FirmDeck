import { useEffect, useState, type ReactNode } from "react";
import {
  Brain,
  ChevronLeft,
  ChevronRight,
  IdCard,
  Workflow,
  XIcon,
} from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useAppIntl } from "@/i18n/useAppIntl";
import type { MessageId } from "@/i18n/types";
import galleryImage from "@/assets/onboarding-gallery.png";
import profileImage from "@/assets/onboarding-profile.png";

export const ONBOARDING_SEEN_KEY = "staffdeck_onboarding_guide_seen";

/** Custom event that lets any part of the app re-open the onboarding guide. */
export const OPEN_ONBOARDING_EVENT = "staffdeck-open-onboarding";
export const OPEN_QUICK_START_EVENT = "staffdeck-open-quick-start";

type GuideCard = {
  icon: ReactNode;
  titleId: MessageId;
  descriptionId: MessageId;
};

type GuideStep = {
  image: string;
  eyebrowId: MessageId;
  titleLineIds: MessageId[];
  descriptionId: MessageId;
  cards: GuideCard[];
};

const CARD_ICON_CLASS = "size-[18px] text-white";
const CARD_BADGE_CLASS =
  "font-['Alimama_ShuHeiTi',_sans-serif] text-[16px] font-bold text-white";

const STEPS: GuideStep[] = [
  {
    image: galleryImage,
    eyebrowId: "onboarding.welcome.eyebrow",
    titleLineIds: ["onboarding.welcome.titlePrimary", "onboarding.welcome.titleSecondary"],
    descriptionId: "onboarding.welcome.description",
    cards: [
      {
        icon: <IdCard className={CARD_ICON_CLASS} />,
        titleId: "onboarding.welcome.card.manage.title",
        descriptionId: "onboarding.welcome.card.manage.description",
      },
      {
        icon: <Workflow className={CARD_ICON_CLASS} />,
        titleId: "onboarding.welcome.card.process.title",
        descriptionId: "onboarding.welcome.card.process.description",
      },
      {
        icon: <Brain className={CARD_ICON_CLASS} />,
        titleId: "onboarding.welcome.card.business.title",
        descriptionId: "onboarding.welcome.card.business.description",
      },
    ],
  },
  {
    image: profileImage,
    eyebrowId: "onboarding.concepts.eyebrow",
    titleLineIds: ["onboarding.concepts.title"],
    descriptionId: "onboarding.concepts.description",
    cards: [
      {
        icon: <span className={CARD_BADGE_CLASS}>01</span>,
        titleId: "onboarding.concepts.card.model.title",
        descriptionId: "onboarding.concepts.card.model.description",
      },
      {
        icon: <span className={CARD_BADGE_CLASS}>02</span>,
        titleId: "onboarding.concepts.card.capability.title",
        descriptionId: "onboarding.concepts.card.capability.description",
      },
      {
        icon: <span className={CARD_BADGE_CLASS}>03</span>,
        titleId: "onboarding.concepts.card.deploy.title",
        descriptionId: "onboarding.concepts.card.deploy.description",
      },
    ],
  },
];

export default function OnboardingGuide() {
  const { t } = useAppIntl();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);

  useEffect(() => {
    const seen = window.localStorage.getItem(ONBOARDING_SEEN_KEY);
    if (!seen) {
      setStep(0);
      setOpen(true);
    }
  }, []);

  useEffect(() => {
    const reopen = () => {
      setStep(0);
      setOpen(true);
    };
    window.addEventListener(OPEN_ONBOARDING_EVENT, reopen);
    return () => window.removeEventListener(OPEN_ONBOARDING_EVENT, reopen);
  }, []);

  /** 记录欢迎引导已完成，并接续打开快速开始引导。 */
  function finish() {
    window.localStorage.setItem(ONBOARDING_SEEN_KEY, "1");
    setOpen(false);
    window.dispatchEvent(new Event(OPEN_QUICK_START_EVENT));
  }

  /** 返回上一个欢迎引导步骤。 */
  function goPrev() {
    setStep((prev) => Math.max(0, prev - 1));
  }

  /** 进入下一个步骤，末页时完成引导。 */
  function goNext() {
    if (step >= STEPS.length - 1) {
      finish();
    } else {
      setStep((prev) => Math.min(STEPS.length - 1, prev + 1));
    }
  }

  /** 将 Dialog 的关闭交互映射为引导完成。 */
  function handleOpenChange(next: boolean) {
    if (!next) finish();
    else setOpen(true);
  }

  const current = STEPS[step];
  const isFirst = step === 0;
  const isLast = step === STEPS.length - 1;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="grid w-[904px] max-w-[calc(100vw-2rem)] grid-cols-1 gap-0 overflow-hidden rounded-[20px] border-0 p-0 ring-0 md:grid-cols-[474px_430px] sm:max-w-[904px]"
      >
        <DialogTitle className="sr-only">
          {current.titleLineIds.map((id) => t(id)).join("")}
        </DialogTitle>

        <div className="hidden h-[560px] bg-[#e9eef6] md:block">
          <img
            key={current.image}
            src={current.image}
            alt=""
            className="size-full object-cover object-top-left"
          />
        </div>

        <div className="relative flex h-[560px] flex-col justify-between bg-linear-to-b from-[#f9fcff] to-[#e3f1ff] px-[36px] pt-[10px] pb-[32px]">
          <div className="flex items-center justify-end">
            <button
              type="button"
              onClick={finish}
              aria-label={t("onboarding.action.close")}
              className="flex size-[20px] items-center justify-center text-[#757f9c] transition-colors hover:text-[#18181a]"
            >
              <XIcon className="size-[14px]" />
            </button>
          </div>

          <div className="flex flex-col gap-[24px]">
            <div className="flex flex-col gap-[4px]">
              <span className="-skew-x-6 text-[12px] leading-none text-[#464c5e]">
                {t(current.eyebrowId)}
              </span>
              <div className="-skew-x-6">
                {current.titleLineIds.map((lineId) => (
                  <p
                    key={lineId}
                    className="bg-linear-to-r from-[#105acf] to-[#007bff] bg-clip-text text-[32px] leading-[44px] font-semibold text-transparent"
                  >
                    {t(lineId)}
                  </p>
                ))}
              </div>
              <p className="text-[12px] leading-[20px] text-[#757f9c]">
                {t(current.descriptionId)}
              </p>
            </div>

            <div className="flex flex-col gap-[12px]">
              {current.cards.map((card) => (
                <div
                  key={card.titleId}
                  className="flex items-center gap-[8px] rounded-[14px] bg-white/60 px-[12px] py-[10px]"
                >
                  <div className="flex size-[32px] shrink-0 items-center justify-center rounded-[8px] bg-linear-to-br from-[#89b6ff] to-[#527aff]">
                    {card.icon}
                  </div>
                  <div className="flex min-w-0 flex-col gap-[4px]">
                    <p className="truncate text-[14px] leading-none text-[#464c5e]">
                      {t(card.titleId)}
                    </p>
                    <p className="truncate text-[12px] leading-none text-[#757f9c]">
                      {t(card.descriptionId)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-[4px] text-[#757f9c]">
              <button
                type="button"
                onClick={goPrev}
                disabled={isFirst}
                aria-label={t("onboarding.action.previous")}
                className="flex size-[14px] items-center justify-center transition-colors enabled:hover:text-[#18181a] disabled:cursor-default disabled:opacity-40"
              >
                <ChevronLeft className="size-[14px]" />
              </button>
              <span className="text-[12px]">
                {step + 1}/{STEPS.length}
              </span>
              <button
                type="button"
                onClick={goNext}
                disabled={isLast}
                aria-label={t("onboarding.action.next")}
                className="flex size-[14px] items-center justify-center transition-colors enabled:hover:text-[#18181a] disabled:cursor-default disabled:opacity-40"
              >
                <ChevronRight className="size-[14px]" />
              </button>
            </div>

            <div className="flex items-center gap-[12px]">
              <button
                type="button"
                onClick={finish}
                className="flex w-[80px] items-center justify-center rounded-[10px] border-[0.5px] border-[#e3e7f1] bg-white px-[20px] py-[8px] text-[14px] text-[#757f9c] transition-colors hover:bg-[#f6f6f6] hover:text-[#18181a]"
              >
                {t("onboarding.action.skip")}
              </button>
              <button
                type="button"
                onClick={goNext}
                className="flex w-[134px] items-center justify-center rounded-[10px] bg-[#18181a] px-[32px] py-[8px] text-[14px] text-white transition-colors hover:bg-[#303030]"
              >
                {isLast ? t("onboarding.action.start") : t("onboarding.action.next")}
              </button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
