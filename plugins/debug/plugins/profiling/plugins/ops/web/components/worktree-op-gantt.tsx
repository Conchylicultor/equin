import { type ReactElement, type ReactNode } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { opsHistory } from "@plugins/debug/plugins/profiling/plugins/op-log/plugins/op-store/core";
import {
  OPS_READ_LIMIT,
  TWENTY_MINUTES,
  windowOf,
} from "../internal/op-groups";
import { WindowOpGantt } from "./window-op-gantt";

// One worktree's ops can span every other worktree's around them; the span is
// read in two steps. First that worktree's own ops — no time bound of its
// own: its newest `OPS_READ_LIMIT`, within the store's 30-day retention (a
// worktree with more starts its span late, and says so). Their span ± 20 min
// (`windowOf`) is the second read's time range. Either read coming back full is
// said on the chart (`capped`).

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
  const span = windowOf(own.data, TWENTY_MINUTES);
  if (span === null) return <>{empty}</>;
  return (
    <WindowOpGantt
      span={span}
      highlightWorktree={worktree}
      subject="the ops around this worktree"
      empty={empty}
      alsoCapped={own.data.length >= OPS_READ_LIMIT}
    />
  );
}
