import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Popover,
  PopoverAnchor,
  PopoverArrow,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { XIcon } from "lucide-react";
import { EnterpriseRoute } from "@/enums/routes";
import { useAppIntl } from "@/i18n/useAppIntl";
import type { MessageId } from "@/i18n/types";
import { OPEN_QUICK_START_EVENT } from "./OnboardingGuide";

const ONBOARDING_SEEN_KEY = "firmdeck_onboarding_guide_seen";
export const QUICK_START_SEEN_KEY = "firmdeck_quick_start_guide_seen";
export const QUICK_START_COMPLETED_EVENT = "firmdeck-quick-start-completed";
export const OPEN_MODEL_CREATE_EVENT = "firmdeck-open-model-create";

type QuickStartStep = {
  titleId: MessageId;
  descriptionId: MessageId;
  route: EnterpriseRoute;
  target: string;
  fallbackTarget?: string;
  actionTarget?: string;
  side?: "top" | "right" | "bottom" | "left";
  nextLabelId?: MessageId;
  nextRoute?: EnterpriseRoute;
  eventName?: string;
};

const STEPS: QuickStartStep[] = [
  {
    titleId: "quickStart.model.title",
    descriptionId: "quickStart.model.description",
    route: EnterpriseRoute.Models,
    target: "models-create",
    eventName: OPEN_MODEL_CREATE_EVENT,
  },
  {
    titleId: "quickStart.agent.title",
    descriptionId: "quickStart.agent.description",
    route: EnterpriseRoute.Agents,
    target: "route-/enterprise/agents",
    side: "right",
  },
  {
    titleId: "quickStart.platform.title",
    descriptionId: "quickStart.platform.description",
    route: EnterpriseRoute.Platform,
    target: "route-/enterprise/platform",
    side: "right",
  },
  {
    titleId: "quickStart.dashboard.title",
    descriptionId: "quickStart.dashboard.description",
    route: EnterpriseRoute.Dashboard,
    target: "route-/enterprise/dashboard",
    side: "right",
  },
  {
    titleId: "quickStart.scheduledTasks.title",
    descriptionId: "quickStart.scheduledTasks.description",
    route: EnterpriseRoute.ScheduledTasks,
    target: "route-/enterprise/scheduled-tasks",
    side: "right",
  },
  {
    titleId: "quickStart.memories.title",
    descriptionId: "quickStart.memories.description",
    route: EnterpriseRoute.Memories,
    target: "route-/enterprise/memories",
    side: "right",
  },
  {
    titleId: "quickStart.knowledge.title",
    descriptionId: "quickStart.knowledge.description",
    route: EnterpriseRoute.Knowledge,
    target: "route-/enterprise/knowledge",
    side: "right",
  },
  {
    titleId: "quickStart.generalSkills.title",
    descriptionId: "quickStart.generalSkills.description",
    route: EnterpriseRoute.GeneralSkills,
    target: "route-/enterprise/general-skills",
    side: "right",
  },
  {
    titleId: "quickStart.sop.title",
    descriptionId: "quickStart.sop.description",
    route: EnterpriseRoute.Skills,
    target: "route-/enterprise/skills",
    side: "right",
  },
  {
    titleId: "quickStart.chat.title",
    descriptionId: "quickStart.chat.description",
    route: EnterpriseRoute.Skills,
    target: "open-chat",
    side: "right",
    nextLabelId: "quickStart.action.startChat",
    nextRoute: EnterpriseRoute.Gallery,
  },
];

function findVisibleTarget(targetName: string) {
  return Array.from(document.querySelectorAll<HTMLElement>(`[data-guide-target="${targetName}"]`)).find((element) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
}

function findStepTarget(step: QuickStartStep) {
  return findVisibleTarget(step.target) || (step.fallbackTarget ? findVisibleTarget(step.fallbackTarget) : undefined);
}

export default function QuickStartGuide({ isAdmin }: { isAdmin: boolean }) {
  const { t } = useAppIntl();
  const navigate = useNavigate();
  const location = useLocation();
  const steps = useMemo(() => (isAdmin ? STEPS : STEPS.slice(1)), [isAdmin]);
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [anchorRect, setAnchorRect] = useState({ top: 0, left: 0, width: 1, height: 1 });
  const [anchorReady, setAnchorReady] = useState(false);

  useEffect(() => {
    const welcomeSeen = window.localStorage.getItem(ONBOARDING_SEEN_KEY);
    const quickStartSeen = window.localStorage.getItem(QUICK_START_SEEN_KEY);
    if (welcomeSeen && !quickStartSeen) setOpen(true);
  }, []);

  useEffect(() => {
    const reopen = () => {
      if (window.localStorage.getItem(QUICK_START_SEEN_KEY)) return;
      setStep(0);
      setOpen(true);
    };
    window.addEventListener(OPEN_QUICK_START_EVENT, reopen);
    return () => window.removeEventListener(OPEN_QUICK_START_EVENT, reopen);
  }, []);

  /** 记录快速开始已完成，并通知页面其他区域。 */
  function finish() {
    window.localStorage.setItem(QUICK_START_SEEN_KEY, "1");
    setOpen(false);
    window.dispatchEvent(new Event(QUICK_START_COMPLETED_EVENT));
  }

  /** 前往下一步，末页时跳转到目标并完成。 */
  function goNext() {
    if (step === steps.length - 1) {
      if (current.nextRoute) navigate(current.nextRoute);
      finish();
    } else setStep((current) => current + 1);
  }

  /** 返回快速开始的上一步。 */
  function goPrev() {
    setStep((current) => Math.max(0, current - 1));
  }

  /** 执行当前步骤的页面导航与可选目标操作。 */
  function runAction() {
    const current = steps[step];
    navigate(current.route);
    const eventName = current.eventName;
    if (eventName) {
      window.setTimeout(() => window.dispatchEvent(new Event(eventName)), 0);
    } else {
      window.setTimeout(() => findStepTarget(current)?.click(), 50);
    }
  }

  const current = steps[step];
  const isLast = step === steps.length - 1;

  useEffect(() => {
    if (open && location.pathname !== current.route) navigate(current.route);
  }, [current.route, location.pathname, navigate, open]);

  useLayoutEffect(() => {
    if (!open) return undefined;

    let frame = 0;
    let fallbackAllowed = false;
    setAnchorReady(false);
    const updateAnchor = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const target = findVisibleTarget(current.target)
          || (fallbackAllowed && current.fallbackTarget
            ? findVisibleTarget(current.fallbackTarget)
            : undefined);
        if (!target) return;
        const rect = target.getBoundingClientRect();
        setAnchorRect({ top: rect.top, left: rect.left, width: rect.width, height: rect.height });
        setAnchorReady(true);
      });
    };

    updateAnchor();
    const delayed = window.setTimeout(updateAnchor, 120);
    const fallbackDelay = window.setTimeout(() => {
      fallbackAllowed = true;
      updateAnchor();
    }, 700);
    const observer = new MutationObserver(updateAnchor);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", updateAnchor);
    window.addEventListener("scroll", updateAnchor, true);
    return () => {
      window.clearTimeout(delayed);
      window.clearTimeout(fallbackDelay);
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", updateAnchor);
      window.removeEventListener("scroll", updateAnchor, true);
    };
  }, [current.fallbackTarget, current.target, location.pathname, open]);

  return (
    <Popover open={open} onOpenChange={(next) => !next && finish()} modal>
      {open && <div aria-hidden="true" className="fixed inset-0 z-40 cursor-default bg-transparent" />}
      <PopoverAnchor asChild>
        <span aria-hidden="true" className="pointer-events-none fixed z-40" style={anchorRect} />
      </PopoverAnchor>
      <PopoverContent
        side={current.side || "bottom"}
        align="center"
        sideOffset={16}
        collisionPadding={12}
        avoidCollisions
        onInteractOutside={(event) => event.preventDefault()}
        className={`z-50 flex w-[434px] max-w-[calc(100vw-24px)] flex-col gap-[16px] rounded-[20px] border-0 bg-[rgba(24,24,26,0.8)] p-[24px] text-white shadow-[0_18px_60px_rgba(0,0,0,0.24)] ring-0 ${anchorReady ? "visible" : "invisible pointer-events-none"}`}
      >
        <PopoverArrow width={22} height={11} className="fill-[rgba(24,24,26,0.8)]" />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t("quickStart.action.close")}
          onClick={finish}
          className="absolute top-[18px] right-[18px] text-white hover:bg-white/10 hover:text-white"
        >
          <XIcon className="size-[18px]" />
        </Button>
        <div className="flex min-h-[86px] flex-col gap-[4px] pb-[32px]">
          <PopoverTitle className="text-[14px] leading-[22px] font-medium text-white">
            {t(current.titleId)}
          </PopoverTitle>
          <PopoverDescription className="text-[14px] leading-[22px] font-normal text-[#f6f6f6]">
            {t(current.descriptionId)}
          </PopoverDescription>
        </div>

        <div className="flex items-center justify-between gap-[16px]">
          <span className="shrink-0 py-[3px] text-[14px] leading-normal text-[#858b9c]">
            {step + 1} / {steps.length}
          </span>
          <div className="flex min-w-0 items-center gap-[16px] max-[420px]:gap-[8px]">
            <Button
              variant="outline"
              onClick={step === 0 ? runAction : goPrev}
              className="h-[34px] min-w-[100px] rounded-[10px] border-[0.5px] border-[#6d6d6d] bg-black/20 px-[20px] text-[14px] leading-[22px] font-normal whitespace-nowrap text-white hover:bg-white/10 hover:text-white"
            >
              {step === 0 ? t("quickStart.action.addNow") : t("quickStart.action.previous")}
            </Button>
            <Button
              onClick={goNext}
              className="h-[34px] min-w-[100px] rounded-[8px] bg-white px-[16px] text-[14px] leading-[22px] font-normal whitespace-nowrap text-[#29282d] hover:bg-[#f0f0f0] hover:text-[#29282d]"
            >
              {current.nextLabelId
                ? t(current.nextLabelId)
                : t(isLast ? "quickStart.action.finish" : "quickStart.action.next")}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
