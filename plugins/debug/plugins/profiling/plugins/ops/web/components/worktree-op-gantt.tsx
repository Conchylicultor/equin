import { type ReactElement, type ReactNode } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import {
  opsHistory,
  type OpRow,
} from "@plugins/debug/plugins/profiling/plugins/op-log/plugins/op-store/core";
import {
  FIVE_MINUTES,
  OPS_READ_LIMIT,
  TWENTY_MINUTES,
  ceilTo,
  floorTo,
} from "../internal/op-groups";
import { LiveOpGantt, type OpWindow } from "./live-op-gantt";

// One worktree's ops can span every other worktree's around them; the span is
// read in two steps. First that worktree's own ops — no time bound of its
// own: its newest `OPS_READ_LIMIT`, within the store's 30-day retention (a
// worktree with more starts its span late, and says so). Their span ± 20 min
// is the span, floored / ceiled to 5 min so the second tuple is stable — a
// time range stated in that query. While one of them is still in flight its
// end grows with `now`, so the span is left open-ended rather than re-keyed
// every tick. Either read coming back full is said on the chart (`capped`).
function windowOf(rows: readonly OpRow[]): OpWindow | null {
  let startMs = Infinity;
  let endMs = -Infinity;
  let open = false;
  for (const r of rows) {
    const requested = r.requestedAt.getTime();
    startMs = Math.min(startMs, requested);
    if (r.closedBy === null) open = true;
    else endMs = Math.max(endMs, requested + r.totalMs);
  }
  if (startMs === Infinity) return null;
  return {
    startMs: floorTo(startMs - TWENTY_MINUTES, FIVE_MINUTES),
    endMs: open
      ? null
      : ceilTo(Math.max(endMs, startMs) + TWENTY_MINUTES, FIVE_MINUTES),
  };
}

function WindowGantt({
  span,
  worktree,
  empty,
  ownCapped,
}: {
  span: OpWindow;
  worktree: string;
  empty: ReactNode;
  /** The worktree's own read came back full: its span may start earlier. */
  ownCapped: boolean;
}): ReactElement {
  const start = new Date(span.startMs).toISOString();
  // An op overlaps the span when it was requested inside it, or requested
  // before it and completed inside it.
  const overlaps = {
    or: [
      { column: "requestedAt", op: "gte", operand: start },
      { column: "completedAt", op: "gte", operand: start },
    ],
  } as const;
  const result = useLive(opsHistory, {
    where:
      span.endMs === null
        ? overlaps
        : {
            and: [
              overlaps,
              {
                column: "requestedAt",
                op: "lte",
                operand: new Date(span.endMs).toISOString(),
              },
            ],
          },
    limit: OPS_READ_LIMIT,
  });
  if (result.status === "loading") return <Loading label="Loading ops…" />;
  if (result.status === "error")
    return (
      <ResourceErrorInline
        variant="inline"
        subject="the ops around this worktree"
        error={result.error}
        refetch={result.refetch}
      />
    );
  if (result.status === "unavailable")
    return <Placeholder tone="muted">{result.message}</Placeholder>;
  return (
    <LiveOpGantt
      rows={result.data}
      span={span}
      highlightWorktree={worktree}
      empty={empty}
      capped={ownCapped || result.data.length >= OPS_READ_LIMIT}
    />
  );
}

/**
 * The op Gantt scoped to one worktree: its ops, and every other op that ran
 * alongside them (± 20 min), so contention reads in context. `empty` renders
 * when the worktree has no recorded op.
 */
export function WorktreeOpGantt({
  worktree,
  empty,
}: {
  worktree: string;
  empty: ReactNode;
}): ReactElement {
  const own = useLive(opsHistory, {
    where: { opSlug: worktree },
    limit: OPS_READ_LIMIT,
  });
  if (own.status === "loading") return <Loading label="Loading ops…" />;
  if (own.status === "error")
    return (
      <ResourceErrorInline
        variant="inline"
        subject="this worktree's ops"
        error={own.error}
        refetch={own.refetch}
      />
    );
  // The ops are this machine's: a host without the computer says so.
  if (own.status === "unavailable")
    return <Placeholder tone="muted">{own.message}</Placeholder>;
  const span = windowOf(own.data);
  if (span === null) return <>{empty}</>;
  return (
    <WindowGantt
      span={span}
      worktree={worktree}
      empty={empty}
      ownCapped={own.data.length >= OPS_READ_LIMIT}
    />
  );
}
