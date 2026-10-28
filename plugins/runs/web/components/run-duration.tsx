import type { ReactNode } from "react";
import { useNow } from "@plugins/primitives/plugins/relative-time/web";
import type { RunRow } from "../../core";
import { formatDuration } from "@plugins/fields/plugins/duration/core";

/** A running run's elapsed time: ticks once a second from `startedAt`. */
function Elapsed({ startedAt }: { startedAt: Date }): ReactNode {
  const now = useNow(1000);
  return formatDuration(Math.max(0, now - startedAt.getTime()));
}

/**
 * How long a run took — or, while it is still in flight, how long it has been
 * going. One formatter for both, so the cell does not change shape the moment
 * a run finishes.
 *
 * The server's `duration` is finished-only (NULL while running): the elapsed
 * time of a running run is this ticker, read off the browser's clock, rather
 * than a value the server would have to re-push every second.
 */
export function RunDuration({
  run,
}: {
  run: Pick<RunRow, "startedAt" | "finishedAt" | "duration">;
}): ReactNode {
  if (run.finishedAt === null) return <Elapsed startedAt={run.startedAt} />;
  return run.duration === null ? null : formatDuration(run.duration);
}
