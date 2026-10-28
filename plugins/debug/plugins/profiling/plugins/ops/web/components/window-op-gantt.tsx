import { type ReactElement, type ReactNode } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { opsHistory } from "@plugins/debug/plugins/profiling/plugins/op-log/plugins/op-store/core";
import { OPS_READ_LIMIT, type OpWindow } from "../internal/op-groups";
import { LiveOpGantt } from "./live-op-gantt";

/**
 * Every op in the repo overlapping `span` — whichever worktree ran it — on one
 * Gantt, so a worktree's (or one op's) contention reads in context. The span is
 * a time range stated in the query; its bounds must already be floored /
 * ceiled by the caller so the subscription tuple is stable. An open-ended span
 * (`endMs` null) follows an in-flight op without re-keying every tick.
 */
export function WindowOpGantt({
  span,
  highlightWorktree,
  highlightOpId,
  subject,
  empty,
  alsoCapped = false,
}: {
  span: OpWindow;
  highlightWorktree?: string;
  highlightOpId?: string;
  /** What the read is of, for its error ("the ops around this worktree"). */
  subject: string;
  empty: ReactNode;
  /** Another read behind the span came back full: the span may start earlier. */
  alsoCapped?: boolean;
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
        subject={subject}
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
      highlightWorktree={highlightWorktree}
      highlightOpId={highlightOpId}
      empty={empty}
      capped={alsoCapped || result.data.length >= OPS_READ_LIMIT}
    />
  );
}
