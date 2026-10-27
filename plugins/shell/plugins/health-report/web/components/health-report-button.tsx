import {
  Button,
  ControlSizeProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { InlinePopover } from "@plugins/primitives/plugins/overlay/plugins/popover/web";
import {
  ActivityRing,
  type Activity,
  type ActivityState,
} from "@plugins/primitives/plugins/css/plugins/activity-ring/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import {
  mergeDot,
  verdictOf,
  type DotMerge,
  type ReportedStatus,
} from "../../core";
import { HealthReport } from "../slots";
import { HealthStore } from "../internal/store";
import { BUTTON_TINT_CLASS } from "../internal/tone";
import { HealthDot } from "./health-dot";
import { HealthReportPanel } from "./health-report-panel";
import { StatusProbes } from "./status-probes";

interface DotView extends DotMerge {
  verdict: string;
}

function sameView(a: DotView, b: DotView): boolean {
  return (
    a.state === b.state &&
    a.count === b.count &&
    a.transitioning === b.transitioning &&
    a.pending === b.pending &&
    a.verdict === b.verdict &&
    JSON.stringify(a.marks) === JSON.stringify(b.marks)
  );
}

/** The one ring for many activities: anything running spins it, else anything failed breaks it. */
function ringOf(activities: readonly Activity[]): ActivityState | null {
  if (activities.some((a) => a.state === "running")) return "running";
  if (activities.some((a) => a.state === "failed")) return "failed";
  return null;
}

/**
 * The dot itself, and the popover it opens.
 *
 * Reads the merge through a selector, so the button re-renders only when what
 * it shows changes — not on every status a probe republishes.
 */
function HealthReportTrigger({
  activities,
}: {
  activities: readonly Activity[];
}) {
  const rows = HealthReport.Row.useContributions();
  const ids = rows.flatMap((row) => (row.kind === "status" ? [row.id] : []));
  const idsKey = ids.join("\n");
  const view = HealthStore.useSelector(
    (state): DotView => {
      const statuses: ReportedStatus[] = ids.map((id) => state[id]);
      return { ...mergeDot(statuses), verdict: verdictOf(statuses) };
    },
    [idsKey],
    sameView,
  );

  // Narrowed here, once: the tint map is keyed only by the two states that
  // need a look, and `needsLook` below is just its presence.
  const tint =
    view.state === "attention" || view.state === "critical"
      ? BUTTON_TINT_CLASS[view.state]
      : undefined;
  const needsLook = tint !== undefined;
  const marked = view.marks.length > 0;
  // The activity labels ride along in the tooltip / accessible name: the ring
  // alone says "something is running", the words say what.
  const label = [view.verdict, ...activities.map((a) => a.label)].join(" · ");

  return (
    <InlinePopover
      align="end"
      width="2xl"
      padding="none"
      tooltip={label}
      trigger={
        <Button
          variant="ghost"
          shape="pill"
          aspect={needsLook || marked ? "text" : "icon"}
          aria-label={label}
          data-health={view.state}
          className={tint}
        >
          <ControlSizeProvider size="md">
            <ActivityRing state={ringOf(activities)}>
              <HealthDot
                halo
                level={view.state}
                pulsing={view.pending || view.transitioning}
              />
            </ActivityRing>
          </ControlSizeProvider>
          {needsLook ? (
            <span className="font-semibold tabular-nums">{view.count}</span>
          ) : null}
          {view.marks.map((mark) => (
            <Icon
              key={mark.id}
              icon={mark.icon}
              title={mark.label}
              className="size-4 text-muted-foreground"
            />
          ))}
        </Button>
      }
    >
      <HealthReportPanel />
    </InlinePopover>
  );
}

/**
 * The health report's button: one dot merging every `HealthReport.Row`.
 *
 * - all ok → a green dot, nothing else;
 * - an ambient condition (the machine busy) → the dot keeps its colour, with
 *   the condition's small icons beside it (`mergeDot`);
 * - some rows need a look → an amber / red dot plus how many, in tinted figures;
 * - not known yet → a grey dot, pulsing, until every row has reported;
 * - the dot also pulses while a row is transitioning (reconnecting).
 *
 * Clicking opens the report. The button owns its own status store and mounts
 * one probe per status row, so the dot is coloured whether or not the report is
 * open — mount exactly one of these per page. Its density is the ambient
 * `ControlSize` of wherever it is placed.
 *
 * `activities` — background work the host wants shown with the dot (the
 * collapsed floating bar's build, …) — draws a ring around the dot and joins
 * the tooltip. The button names no source; the host gathers them.
 */
export function HealthReportButton({
  activities = [],
}: {
  activities?: readonly Activity[];
}) {
  return (
    <HealthStore.Provider>
      <StatusProbes />
      <HealthReportTrigger activities={activities} />
    </HealthStore.Provider>
  );
}
