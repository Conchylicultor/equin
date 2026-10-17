import {
  WithHoverCard,
  type WithHoverCardProps,
} from "@plugins/primitives/plugins/overlay/plugins/hover-card/web";
import type { ReactElement } from "react";
import type { SegmentedProgressBarProps } from "../../core";

type Props = Pick<
  SegmentedProgressBarProps,
  "steps" | "activeStep" | "summary"
>;

/** The one-line name of where the bar stands: `Design · step 2 of 4`. */
export function progressStepLabel({
  steps,
  activeStep,
}: Pick<Props, "steps" | "activeStep">): string {
  const current = steps.findIndex((s) => s.id === activeStep);
  return `${steps[current]?.label ?? activeStep} · step ${current + 1} of ${steps.length}`;
}

/**
 * The hover card every variant wraps its bar in: where the bar stands and what
 * it tracks, then the whole path as a stepper — one equal segment per step
 * with its name under it, the current one lit — and what the current step
 * means. So a user who has never seen the bar learns the full path from one
 * hover.
 */
export function ProgressStepsTooltip({
  side,
  pinOnClick,
  children,
  steps,
  activeStep,
  summary,
}: Props & {
  side?: WithHoverCardProps["side"];
  /** A click on the bar pins the card open — for a bar with no click action of its own. */
  pinOnClick?: WithHoverCardProps["pinOnClick"];
  /** The bar — the card's trigger. */
  children: ReactElement;
}) {
  const current = steps.findIndex((s) => s.id === activeStep);
  return (
    <WithHoverCard
      card={{
        title: progressStepLabel({ steps, activeStep }),
        description: summary,
        steps: {
          items: steps,
          current,
          caption: steps[current]?.description,
        },
      }}
      side={side}
      pinOnClick={pinOnClick}
    >
      {children}
    </WithHoverCard>
  );
}
