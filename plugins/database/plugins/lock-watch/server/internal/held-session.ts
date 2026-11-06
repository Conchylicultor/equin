import type { Pool } from "pg";
import { openHeldClient } from "@plugins/database/plugins/admin/server";
import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";

// The watch's own session on this worktree's database, opened on the first
// look and kept between looks. A fresh connection per look (what the watch
// did until 2026-11-04) is blind exactly when new connections stall: that
// day every new direct connection on the cluster went unanswered for a minute
// and the watch, queued behind them, saw nothing. A held session is already
// past the postmaster, so the look still runs. Lost (a deadline, the server
// closing it), it leaves the pool and the next look opens another.
let held: Pool | null = null;

export async function heldSession(): Promise<Pool> {
  if (!held) {
    const pool = await openHeldClient("lock-watch", runtimeNamespace());
    // Another look may have opened it while the connection config was read.
    if (held) await pool.end();
    else held = pool;
  }
  return held;
}

/** Close the held session, if a look ever opened it. */
export async function closeHeldSession(): Promise<void> {
  if (held === null) return;
  const pool = held;
  held = null;
  await pool.end();
}
