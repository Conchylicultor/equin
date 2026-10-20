import type { ReactElement } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { useNow } from "@plugins/primitives/plugins/relative-time/web";
import { opsHistory } from "@plugins/debug/plugins/profiling/plugins/op-log/plugins/op-store/core";
import { FIVE_MINUTES, OPS_READ_LIMIT, floorTo } from "../internal/op-groups";
import { LiveOpGantt } from "./live-op-gantt";

const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

/**
 * The Debug > Profiling op Gantt: every op requested in the last 24 h, live —
 * a time range stated in the query, newest first, capped at `OPS_READ_LIMIT`
 * (and saying so when it is). The cutoff is floored to 5 min so the
 * subscription tuple changes at most every 5 min (a minute ticker drives it;
 * the rows themselves are pushed).
 */
export function OpSection(): ReactElement | null {
  const now = useNow(60_000);
  const cutoff = new Date(floorTo(now - TWENTY_FOUR_HOURS, FIVE_MINUTES));
  const result = useLive(opsHistory, {
    where: { requestedAt: { gte: cutoff.toISOString() } },
    limit: OPS_READ_LIMIT,
  });

  if (result.status === "loading") return <Loading label="Loading ops…" />;
  if (result.status === "error")
    return (
      <ResourceErrorInline
        variant="inline"
        subject="the ops"
        error={result.error}
        refetch={result.refetch}
      />
    );
  // The ops are this machine's: a host without the computer says so.
  if (result.status === "unavailable")
    return <Placeholder tone="muted">{result.message}</Placeholder>;
  return (
    <LiveOpGantt
      rows={result.data}
      empty={null}
      capped={result.data.length >= OPS_READ_LIMIT}
    />
  );
}
