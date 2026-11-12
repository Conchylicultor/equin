import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { serveValue } from "@plugins/network/plugins/live/server";
import { isHostSingleton } from "@plugins/infra/plugins/paths/core";
import { HOST_IDLE_STATE_ID, hostIdle, type HostIdle } from "../../core";
import { _hostIdleState } from "./tables";

/**
 * The idle state main's evaluation last wrote. Only the host singleton
 * evaluates, so only it can answer: anywhere else the read is refused
 * `main-only` — a worktree's own row would be a stale copy forked from main,
 * which no evaluation ever updates.
 */
export const hostIdleServed = serveValue(hostIdle, {
  source: "db",
  reads: {
    tables: [_hostIdleState],
    reason: "the one host idle state row the evaluation writes",
  },
  loader: async (): Promise<HostIdle> => {
    if (!isHostSingleton())
      throw hostIdle.refuse(
        "main-only",
        "Whether the computer is idle is worked out by main's backend only.",
      );
    const [row] = await db
      .select()
      .from(_hostIdleState)
      .where(eq(_hostIdleState.id, HOST_IDLE_STATE_ID));
    if (row === undefined) return { state: "unevaluated" };
    return {
      state: row.state,
      quietSince: row.quietSince?.toISOString() ?? null,
      idleSince: row.idleSince?.toISOString() ?? null,
      evaluatedAt: row.evaluatedAt.toISOString(),
      blockers: row.blockers,
    };
  },
});
