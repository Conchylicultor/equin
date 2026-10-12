import { useMemo, type ReactElement, type ReactNode } from "react";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { useNow } from "@plugins/primitives/plugins/relative-time/web";
import { useSleepNowForFold } from "@plugins/infra/plugins/host/plugins/machine-sleep/web";
import type { SleepNow } from "@plugins/infra/plugins/host/plugins/machine-sleep/core";
import { useConversationTitleBySlug } from "@plugins/conversations/web";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { attemptPane } from "@plugins/tasks/plugins/attempt-view/web";
import type { OpRow } from "@plugins/debug/plugins/profiling/plugins/op-log/plugins/op-store/core";
import { OpGantt } from "@plugins/debug/plugins/profiling/plugins/ops/plugins/op-gantt/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { useOpActivation } from "../internal/use-op-activation";
import {
  OPS_READ_LIMIT,
  groupOps,
  overlapping,
  recordsAt,
} from "../internal/op-groups";

/** A span to clip the ops to (worktree mode), in epoch ms; `endMs` null = open-ended. */
export interface OpWindow {
  startMs: number;
  endMs: number | null;
}

interface LiveOpGanttProps {
  rows: readonly OpRow[];
  span?: OpWindow;
  highlightWorktree?: string;
  /** What to show when no op falls in the span. */
  empty: ReactNode;
  /**
   * Whether a read behind `rows` came back full (`OPS_READ_LIMIT` rows): the
   * range may hold older ops than it drew, and the chart says so. (A read of
   * exactly that many says so too: a full read cannot tell "exactly full" from
   * "more", hence "may".)
   */
  capped: boolean;
}

// While any op is in flight its bar (and its open wait) grows with `now`; at a
// 24h axis a second is sub-pixel, so a 5 s presentational tick is plenty. The
// rows themselves are pushed.
const TICK_MS = 5000;

// The machine's sleep clock rides with `now`: only an in-flight op's tail can
// hold a nap no event has recorded yet.
function TickingGantt(props: LiveOpGanttProps): ReactElement {
  const now = useNow(TICK_MS);
  const sleepNow = useSleepNowForFold();
  return <GanttAt {...props} now={now} sleepNow={sleepNow} />;
}

function GanttAt({
  rows,
  span,
  highlightWorktree,
  empty,
  now,
  sleepNow,
}: LiveOpGanttProps & { now: number; sleepNow: SleepNow }): ReactElement {
  const titleBySlug = useConversationTitleBySlug();
  const openPane = useOpenPane();
  const opActivation = useOpActivation();
  const data = useMemo(() => {
    const records = recordsAt(rows, now, sleepNow);
    return groupOps(
      span
        ? overlapping(records, span.startMs, span.endMs ?? Infinity)
        : records,
      titleBySlug,
    );
  }, [rows, now, sleepNow, span, titleBySlug]);

  if (data.groups.length === 0) return <>{empty}</>;
  return (
    <OpGantt
      groups={data.groups}
      totalMs={data.totalMs}
      highlightWorktree={highlightWorktree}
      opActivation={opActivation}
      worktreeActivation={(worktree, conversationId) => {
        if (conversationId != null) {
          return openPane.to(
            conversationPane,
            { convId: conversationId },
            { mode: "push" },
          );
        }
        const attemptId = worktree.split("/").pop() ?? worktree;
        return openPane.to(attemptPane, { attemptId }, { mode: "push" });
      }}
    />
  );
}

/**
 * The op Gantt over live `opsHistory` rows: projected to read-model records in
 * the browser, grouped per worktree, labelled with conversation titles. Ticks
 * (and reads the machine's sleep clock) only while something is in flight — a
 * closed op's record depends on neither, so a settled chart renders once.
 */
export function LiveOpGantt(props: LiveOpGanttProps): ReactElement {
  const inFlight = props.rows.some((r) => r.closedBy === null);
  const chart = inFlight ? (
    <TickingGantt {...props} />
  ) : (
    <GanttAt {...props} now={0} sleepNow={null} />
  );
  if (!props.capped) return chart;
  return (
    <Stack gap="xs">
      <Text variant="caption" tone="muted">
        {`Showing the newest ${OPS_READ_LIMIT} ops — older ones may not be drawn.`}
      </Text>
      {chart}
    </Stack>
  );
}
