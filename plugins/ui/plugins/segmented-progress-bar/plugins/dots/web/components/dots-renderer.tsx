import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import type { SegmentedProgressBarProps } from "@plugins/ui/plugins/segmented-progress-bar/core";
import { ProgressStepsTooltip } from "@plugins/ui/plugins/segmented-progress-bar/web";

export function DotsRenderer({
  steps,
  activeStep,
  summary,
  compact = false,
}: SegmentedProgressBarProps) {
  const currentIndex = steps.findIndex((s) => s.id === activeStep);

  const dots = steps.map((step, i) => {
    const isPast = i < currentIndex;
    const isActive = i === currentIndex;

    let dotClass = "size-2 rounded-full ";
    if (isPast) dotClass += "bg-success";
    else if (isActive) dotClass += "bg-primary";
    else dotClass += "border border-muted-foreground/40";

    return { step, i, dotClass };
  });

  const tooltip = { steps, activeStep, summary };

  if (compact) {
    return (
      <ProgressStepsTooltip {...tooltip}>
        <Inline gap="2xs">
          {dots.map(({ step, dotClass }) => (
            <span key={step.id} className={dotClass} />
          ))}
        </Inline>
      </ProgressStepsTooltip>
    );
  }

  const activeLabel = steps[currentIndex]?.label ?? activeStep;

  return (
    <ProgressStepsTooltip {...tooltip}>
      <Inline gap="xs">
        {dots.map(({ step, i, dotClass }) => (
          <Inline key={step.id} gap="xs">
            <span className={dotClass} />
            {i < steps.length - 1 && (
              <span className="h-px w-3 bg-muted-foreground/30" />
            )}
          </Inline>
        ))}
        <Text variant="caption" className="text-muted-foreground">
          {activeLabel}
        </Text>
      </Inline>
    </ProgressStepsTooltip>
  );
}
