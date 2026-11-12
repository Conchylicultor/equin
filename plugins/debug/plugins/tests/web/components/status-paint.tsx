import type { ReactElement } from "react";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import {
  StatusDot,
  type StatusDotPaint,
} from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import type { StatusHistoryEntry, TestOutcome, TestStatus } from "../../core";

/** What each status is called and what it means (the summary cards' tooltips). */
export const STATUS_META: Record<
  TestStatus,
  { label: string; description: string; fill: string }
> = {
  failing: {
    label: "Failing",
    description: "red on the code it last ran",
    fill: "bg-destructive",
  },
  flaky: {
    label: "Flaky",
    description: "both verdicts on the current code",
    fill: "bg-warning",
  },
  stale: {
    label: "Stale",
    description:
      "its code changed since its last run; the ring is the last known verdict",
    fill: "bg-muted-foreground",
  },
  passing: {
    label: "Passing",
    description: "green on the current code",
    fill: "bg-success",
  },
  never: {
    label: "Never run",
    description: "no recorded run yet",
    fill: "bg-muted",
  },
};

const OUTCOME_FILL: Record<TestOutcome, string> = {
  passed: "bg-success",
  failed: "bg-destructive",
  "not-loaded": "bg-destructive",
};
const OUTCOME_RING: Record<TestOutcome, string> = {
  passed: "border-success",
  failed: "border-destructive",
  "not-loaded": "border-destructive",
};

/** A status as a dot; a stale file's is a ring in its last known verdict. */
export function statusPaint(
  status: TestStatus,
  lastOutcome: TestOutcome | null,
): StatusDotPaint {
  if (status === "stale")
    return {
      ringClass:
        lastOutcome === null
          ? "border-muted-foreground"
          : OUTCOME_RING[lastOutcome],
    };
  return { colorClass: STATUS_META[status].fill };
}

export function TestStatusDot({
  status,
  lastOutcome,
}: {
  status: TestStatus;
  lastOutcome: TestOutcome | null;
}): ReactElement {
  return <StatusDot {...statusPaint(status, lastOutcome)} />;
}

/**
 * The last results, newest last, as a strip of ticks: a result on older code
 * is drawn faint, so a stale file's history reads as such.
 */
export function HistoryStrip({
  history,
}: {
  history: readonly StatusHistoryEntry[];
}): ReactElement {
  return (
    <Inline gap="2xs" aria-label="Recent runs">
      {[...history].reverse().map((h) => (
        <span
          key={h.opId}
          title={`${h.outcome} · ${h.origin} · ${new Date(h.at).toLocaleString()}${h.current ? "" : " · older code"}`}
          className={`h-3 w-1 rounded-sm ${OUTCOME_FILL[h.outcome]} ${h.current ? "" : "opacity-30"}`}
        />
      ))}
    </Inline>
  );
}

/** A plugin's subtree as one stacked bar, worst first. */
export function CountsBar({
  counts,
  total,
  wide = false,
}: {
  counts: Record<TestStatus, number>;
  total: number;
  /** The page-wide bar (full width) rather than a row's mini bar. */
  wide?: boolean;
}): ReactElement {
  return (
    <Clip
      axis="x"
      className={`rounded-full bg-muted ${wide ? "h-2 w-full" : "h-1.5 w-16"}`}
    >
      <Line>
        {(Object.keys(STATUS_META) as TestStatus[]).map((s) =>
          counts[s] > 0 ? (
            <span
              key={s}
              className={`h-2 ${STATUS_META[s].fill}`}
              style={{ width: `${(counts[s] / Math.max(total, 1)) * 100}%` }}
            />
          ) : null,
        )}
      </Line>
    </Clip>
  );
}
