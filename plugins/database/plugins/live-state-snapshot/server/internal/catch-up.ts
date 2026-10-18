import { sql as drizzleSql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import {
  executeOne,
  executeRows,
} from "@plugins/database/plugins/sql-rows/core";
import {
  readLayout,
  routeChange,
} from "@plugins/database/plugins/change-feed/server";
import type { FeedChange } from "@plugins/database/plugins/change-feed/server";
import {
  LIVE_STATE_CHANGELOG_TABLE,
  LIVE_STATE_SNAPSHOT_TABLE,
} from "@plugins/database/plugins/derived-views/core";
import { isPrunedPast, readPruneHorizon } from "./changelog-horizon";
import { snapshotLog as log } from "./log-sink";
import { usableRowSql } from "./persist";
import type { L2Expectation } from "./persist";

// The changelog columns the catch-up reads (see CHANGELOG_TABLE_DDL in
// change-feed's triggers.ts). `xid` is a `numeric` — which pg hands back as a
// STRING, and which this query casts to `text` anyway; the value is compared as a
// BigInt below, never as a number. `op` is a `char(1)` whose only three writers
// are the trigger function's I/U/D, so the enum is the check that was previously
// a bare assertion. `ids` is the one genuinely nullable column: a bulk statement
// with no single-column PK writes NULL, which the replay routes as FULL.
//
// `keys` / `unchanged` are a routed table's key layout and known-unchanged
// column set — written by `live_state_notify_routed()` exactly as it NOTIFYs
// them, and NULL for every other table. `keys` is `jsonb` (decoded to its object), parsed by
// the same reader as the live payload so the replay routes exactly what the
// NOTIFY would have.
const ChangelogRowSchema = z.object({
  xid: z.string(),
  t: z.string(),
  op: z.enum(["I", "U", "D"]),
  ids: z.array(z.string()).nullable(),
  keys: z.unknown(),
  unchanged: z.array(z.string()).nullable(),
});
type ChangelogRow = z.infer<typeof ChangelogRowSchema>;

// `min(...)` over an empty table is NULL, so the floor read is nullable. A bare
// aggregate with no GROUP BY ⇒ exactly one row, hence `executeOne`.
const MinPositionRowSchema = z.object({ min_position: z.string().nullable() });

// Replay one changelog row through the EXACT same cascade the live listener uses
// (change-feed's exported `routeChange`). Catch-up ≡ "replay the missed changelog
// rows as if they had just arrived over NOTIFY" — reusing `routeChange` makes that
// true by construction and prevents drift, and THAT INVARIANT requires preserving
// `row.ids` for every op (the live listener never strips them). A genuinely id-less
// bulk statement still arrives with `row.ids === null` → FULL; a reach entry
// recomputes in FULL regardless of ids; a membership entry gains the same
// scoped delivery it gets on the live path.
// See research/2026-06-22-global-live-state-l2-persisted-materialization.md §3.5.
function replayChange(
  row: ChangelogRow,
  route: (change: FeedChange) => void,
): void {
  // The layout is read by the live NOTIFY's own rule (`readLayout`): one that
  // does not parse replays the row unscoped (FULL for its readers) rather than
  // drop it — a missed change is the one outcome catch-up exists to prevent.
  const { scope, malformed } = readLayout(row.ids, row.keys, row.unchanged);
  if (malformed) {
    log.publish(
      `[live-state-snapshot] catch-up: malformed key layout on a "${row.t}" changelog row — replaying it unscoped`,
      "stderr",
    );
  }
  // No `xid` — catch-up replays run at boot, before any client subscribes, so
  // ack attribution has no consumer here; a missing ack is safe by design (the
  // client's resub snapshot watermark backstops any op the downtime absorbed).
  // No `changedAt` either: the replay is not when the change happened.
  //
  // `unchanged` replays as written, though a catch-up follows a restart that
  // may have been a deploy that changed the routes: it lists columns KNOWN
  // equal in every row, a fact whatever gate the trigger compared under — a
  // column a new route reads that the old gate did not compare is simply not
  // listed, so that route is reached. Likewise its `keys`: a column the old
  // layout did not carry reads as unknown, which recomputes — never skips.
  route({
    source: "feed",
    table: row.t,
    op: row.op,
    ...scope,
  });
}

/**
 * What the boot catch-up will do, decided BEFORE anything is seeded (C20):
 *
 * - `none` — no usable persisted row: nothing to replay (every persisted key is
 *   recomputed instead);
 * - `backstop` — the prune deleted a changelog row at or after the oldest
 *   usable row's floor (`horizon` ≥ `floor`): the missing history means no row
 *   can be proven current, so the caller clears the rows and recomputes every
 *   persisted key, seeding nothing;
 * - `replay` — replay every changelog row at or after `floor`.
 */
export type CatchUpProbe =
  | { kind: "none" }
  | { kind: "backstop"; floor: string; horizon: string }
  | { kind: "replay"; floor: string };

/** The lower of two catch-up positions (xid8 as numeric text). */
export function minPosition(a: string, b: string): string {
  return BigInt(a) <= BigInt(b) ? a : b;
}

// The floor is the OLDEST USABLE persisted row's position (the conservative
// floor — every usable row already incorporates everything strictly older than
// its own). A row the usable-row predicate refuses is recomputed, never
// served or seeded, so its position bounds nothing.
export async function probeCatchUp(
  db: NodePgDatabase,
  exp: L2Expectation,
): Promise<CatchUpProbe> {
  const floorRow = await executeOne(db, {
    query: drizzleSql`
      SELECT min(position)::text AS min_position
      FROM ${drizzleSql.raw(LIVE_STATE_SNAPSHOT_TABLE)}
      WHERE params_key = '{}' AND ${usableRowSql(exp)}
    `,
    row: MinPositionRowSchema,
    label: "probeCatchUp/snapshot-floor",
  });
  const floor = floorRow.min_position;
  if (floor === null) return { kind: "none" };

  // The prune horizon: if the prune deleted a row at or after our floor,
  // history was pruned out from under a stale snapshot. (Not the oldest
  // RETAINED xid: the changelog is sparse, so the oldest survivor of an
  // ordinary prune sits above the floor with nothing missing in between.)
  const horizon = await readPruneHorizon(db);
  if (horizon !== null && isPrunedPast(floor, horizon)) {
    return { kind: "backstop", floor, horizon };
  }
  return { kind: "replay", floor };
}

// Bounded cold-boot catch-up: replay only the changelog rows committed at or
// after the probe's floor. Usually empty after a short deploy. Each replayed row
// flows through the recompute cascade → push to subscribers → re-persist,
// advancing the floor.
//
// It routes every replayed row through `routeChange` (every entry through its
// declared reads, plus each persisted entry's drift seeded at boot from its
// `tables_read` — so catch-up works at a cold boot with NO loader having run;
// a persisted entry is targeted at `{}` with nobody subscribed). It also relies on
// the post-LISTEN ordering documented at the call site in `server/index.ts`:
// this runs after change-feed's listener has its LISTEN up, so a commit landing
// after the `SELECT` below is delivered on the live path (no gap).
export async function replayCatchUp(
  db: NodePgDatabase,
  floor: string,
  route: (change: FeedChange) => void = routeChange,
): Promise<void> {
  const rows = await executeRows(db, {
    query: drizzleSql`
      SELECT xid::text AS xid, t, op, ids, keys, unchanged
      FROM ${drizzleSql.raw(LIVE_STATE_CHANGELOG_TABLE)}
      WHERE xid >= ${floor}::numeric
      ORDER BY seq
    `,
    row: ChangelogRowSchema,
    label: "replayCatchUp/changelog-replay",
  });

  if (rows.length === 0) {
    log.publish(
      "[live-state-snapshot] catch-up: no changelog rows since floor — already current",
    );
    return;
  }

  log.publish(
    `[live-state-snapshot] catch-up: replaying ${rows.length} changelog row(s) since floor xid ${floor}`,
  );
  for (const row of rows) replayChange(row, route);
}
