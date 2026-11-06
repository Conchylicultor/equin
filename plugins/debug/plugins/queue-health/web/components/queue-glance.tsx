import {
  HOLD_CLASSES,
  HOLD_SPECS,
  reachableSlots,
  type HoldClass,
} from "@plugins/infra/plugins/jobs/core";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { QueueClassPulse, QueueTone } from "../../core";
import {
  useQueuePulse,
  type QueuePulseRead,
} from "../internal/use-queue-health";

// The Job queue row's glance: one segmented bar per hold class, one segment per
// slot that class can reach. It sits inside the row's click target, so it holds
// no controls — "Open queue" is the row's action.
//
// The bars measure REACH, not ownership: a slot on the widest runner that is
// running an instant job is still a slot a minutes job cannot have, so it fills
// a segment on all three bars. "minutes 4/4" therefore means "a new build or DB
// fork would wait", and the three numerators can add up past the pool size.

type SegmentState = "busy" | "forfeited" | "free" | "unknown";

// Theme tokens only. The neutral fill is a muted tone rather than a status
// colour: a busy slot is not good or bad news by itself. A bar takes a status
// colour only when its class is what coloured the row.
const BUSY_CLASS: Record<QueueTone, string> = {
  ok: cn("bg-muted-foreground/60"),
  attention: cn("bg-warning"),
  critical: cn("bg-destructive"),
};
const NUMBER_CLASS: Record<QueueTone, string> = {
  ok: cn("text-muted-foreground"),
  attention: cn("text-warning"),
  critical: cn("text-destructive"),
};
const FREE_CLASS = cn("bg-muted-foreground/15");
const UNKNOWN_CLASS = cn("bg-muted-foreground/10");
// Forfeited = written off by a stuck job for the life of the backend: drawn as
// a hatch in the text colour, so it reads as "gone" beside both a free and a
// busy segment, and follows the bar's tint.
const HATCH_CLASS = cn(
  "bg-muted-foreground/15 bg-[image:repeating-linear-gradient(135deg,currentColor_0_1px,transparent_1px_3px)]",
);

function segmentClass(state: SegmentState, tone: QueueTone): string {
  switch (state) {
    case "busy":
      return BUSY_CLASS[tone];
    case "forfeited":
      return cn(HATCH_CLASS, NUMBER_CLASS[tone]);
    case "free":
      return FREE_CLASS;
    case "unknown":
      return UNKNOWN_CLASS;
  }
}

/**
 * Busy slots fill from the left and forfeited ones hatch from the right, so
 * the plain run between them is exactly the usable slots still free.
 */
function segmentStates(
  reachable: number,
  cls?: QueueClassPulse,
): SegmentState[] {
  return Array.from({ length: reachable }, (_, i): SegmentState => {
    if (!cls) return "unknown";
    if (i >= reachable - cls.forfeited) return "forfeited";
    if (i < cls.busy - cls.forfeited) return "busy";
    return "free";
  });
}

function ClassBar({
  hold,
  cls,
  tone,
}: {
  hold: HoldClass;
  /** Absent while the queue cannot be read: the bar is drawn, unfilled, with "–". */
  cls?: QueueClassPulse;
  tone: QueueTone;
}) {
  // The segment count never waits for data: it is the class table's reach,
  // which the browser knows without asking. Only the fill does.
  const reachable = cls?.reachable ?? reachableSlots(hold);
  const states = segmentStates(reachable, cls);
  return (
    <Line className="gap-sm" data-queue-class={hold} data-tone={tone}>
      <Text variant="caption" tone="muted" className={cn(rigidClass(), "w-14")}>
        {HOLD_SPECS[hold].label}
      </Text>
      <Fill aria-hidden>
        <Stack direction="row" gap="2xs">
          {states.map((state, i) => (
            <Fill
              // Positional: the i-th slot of this class's reach has no
              // identity beyond its index.
              key={i}
              data-segment={state}
              className={cn("h-1.5 rounded-sm", segmentClass(state, tone))}
            />
          ))}
        </Stack>
      </Fill>
      <Text
        variant="caption"
        className={cn(
          rigidClass(),
          "w-9 text-right tabular-nums",
          NUMBER_CLASS[tone],
        )}
      >
        {cls ? `${cls.busy}/${reachable}` : "–"}
      </Text>
    </Line>
  );
}

/** The bars for any read — drawn unfilled with "–" when the queue is unknown,
 * never as an empty queue. */
export function QueueGlanceView({ read }: { read: QueuePulseRead }) {
  const pulse = read.kind === "ready" ? read.value : undefined;
  return (
    <Stack gap="2xs">
      {HOLD_CLASSES.map((hold) => (
        <ClassBar
          key={hold}
          hold={hold}
          cls={pulse?.classes.find((c) => c.hold === hold)}
          tone={pulse ? pulse.verdict.cause[hold] : "ok"}
        />
      ))}
    </Stack>
  );
}

export function QueueGlance() {
  return <QueueGlanceView read={useQueuePulse()} />;
}
