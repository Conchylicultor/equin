import { sql as drizzleSql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import { LIVE_STATE_HANDOFF_TABLE } from "@plugins/database/plugins/derived-views/core";
import type {
  HandoffState,
  ResumeRecord,
  TableChange,
} from "@plugins/framework/plugins/server-core/core";
import { withDeadline } from "@plugins/packages/plugins/deadline/core";
import { readChangelogSince, replayChange } from "./catch-up";
import { isPrunedPast, readPruneHorizon } from "./changelog-horizon";
import { snapshotLog as log } from "./log-sink";

// The epoch handoff's storage (research/2026-10-30-global-cross-boot-resume-
// epoch-handoff.md): the old backend writes, at its shutdown, the tuples it
// vouched for right after a feed cut and the cut's xid; its successor reads
// them back when the first replayed sub echoes the old boot, and re-proves the
// restart gap from the changelog since the cut. The runtime decides what to
// inherit (resource-runtime's `EpochHandoff`); this file only stores, loads
// and replays — and every way it can fail says so, so the runtime loads.
//
// db-PARAMETRIZED like `persist.ts` / `catch-up.ts`, so a test drives it on a
// throwaway database.

// The whole write — the cut, the state, the INSERT — must fit in the
// shutdown: past this the process exits without a record (the successor then
// loads every sub, as with no handoff at all).
const HANDOFF_WRITE_BUDGET_MS = 3_000;
// How long a record is trusted: its successor's tabs replay within seconds of
// the old backend's exit. A record past it is refused — whatever happened to
// the database in between (a backend that crashed before writing its own, a
// tool that wrote with triggers off) is not something the changelog proves.
const HANDOFF_FRESH = "60 seconds";
// How long the successor waits for its LISTEN session before replaying: a
// replay read before it would leave a gap no live delivery covers.
const LISTENING_BUDGET_MS = 5_000;

const HandoffTupleSchema = z.object({
  key: z.string(),
  pk: z.string(),
  params: z.record(z.string(), z.string()),
  version: z.number().int().positive(),
  definition: z.string(),
});

const HandoffRowSchema = z.object({
  cut_xid: z.string(),
  tuples: z.array(HandoffTupleSchema),
});

/** What the old backend's half needs — injected, so a test can stand them in. */
export interface HandoffWriteDeps {
  /** change-feed's `feedCut`. */
  cut: () => Promise<{ cutXid: string }>;
  /** The runtime's `handoffState`, taken right after the cut. */
  state: () => HandoffState;
  /** Told why nothing was written (default: logged). */
  report: (err: unknown) => void;
}

/**
 * The old backend's half: cut the feed, take the state right after it, store
 * both under this boot's epoch. Never rejects — a cut that cannot be proven,
 * a write that fails or runs out of budget is reported and stores nothing.
 */
export async function writeEpochHandoff(
  db: NodePgDatabase,
  deps: HandoffWriteDeps,
): Promise<void> {
  const write = async (): Promise<number> => {
    const { cutXid } = await deps.cut();
    // Synchronously after the cut resolved: every change below it has made
    // its pending, so a tuple one reached is not in the state.
    const state = deps.state();
    // Only the latest boot's record is ever trusted: this write replaces
    // every other one, so a successor never replays from a cut older than its
    // immediate predecessor's.
    await db.execute(drizzleSql`
      WITH old AS (
        DELETE FROM ${drizzleSql.raw(LIVE_STATE_HANDOFF_TABLE)}
        WHERE epoch <> ${state.epoch}
      )
      INSERT INTO ${drizzleSql.raw(LIVE_STATE_HANDOFF_TABLE)}
        (epoch, cut_xid, tuples)
      VALUES (${state.epoch}, ${cutXid}::numeric, ${JSON.stringify(state.tuples)}::jsonb)
      ON CONFLICT (epoch) DO UPDATE
        SET cut_xid = EXCLUDED.cut_xid, tuples = EXCLUDED.tuples, written_at = now()
    `);
    return state.tuples.length;
  };
  try {
    const n = await withDeadline(
      write(),
      HANDOFF_WRITE_BUDGET_MS,
      () =>
        new Error(
          `the epoch handoff did not finish within ${HANDOFF_WRITE_BUDGET_MS} ms`,
        ),
    );
    log.publish(
      `[live-state-snapshot] epoch handoff: ${n} tuple(s) handed to the successor`,
    );
  } catch (err) {
    deps.report(err);
  }
}

/** What the successor's half needs — injected, so a test can stand them in. */
export interface HandoffLoadDeps {
  /** The tables whose every change is in the changelog (change-feed's `getCoveredTables`). */
  changelogTables: () => readonly string[];
  /** The rollups this boot's reconcile healed — rows rewritten with no changelog entry. */
  healedRollups: () => readonly string[];
  /** Whether this boot applied a migration or deferred a contract (database's `schemaChangedAtBoot`). */
  schemaChanged: () => boolean;
  /** Resolves once the LISTEN session is established (change-feed's `feedListening`). */
  listening: () => Promise<void>;
}

/**
 * The successor's half: the record of boot `epoch`, or null when there is
 * none (a crash, a cut that failed, a write out of budget, a record older
 * than `HANDOFF_FRESH`). Its `replay` waits for the LISTEN session, routes
 * every changelog row since the cut, and refuses when the gap cannot be
 * proven: a migration applied at boot, a rollup healed, history pruned at or
 * past the cut, or no LISTEN session in time.
 */
export async function loadEpochHandoff(
  db: NodePgDatabase,
  epoch: string,
  deps: HandoffLoadDeps,
): Promise<ResumeRecord | null> {
  const rows = await executeRows(db, {
    query: drizzleSql`
      SELECT cut_xid::text AS cut_xid, tuples
      FROM ${drizzleSql.raw(LIVE_STATE_HANDOFF_TABLE)}
      WHERE epoch = ${epoch}
        AND written_at > now() - ${HANDOFF_FRESH}::interval
    `,
    row: HandoffRowSchema,
    label: "loadEpochHandoff",
  });
  const row = rows[0];
  if (row === undefined) return null;
  const cutXid = row.cut_xid;
  return {
    tuples: row.tuples,
    changelogTables: new Set(deps.changelogTables()),
    async replay(route: (change: TableChange) => void) {
      if (deps.schemaChanged()) {
        return { ok: false, reason: "migrated" };
      }
      if (deps.healedRollups().length > 0) {
        return { ok: false, reason: "healed-rollup" };
      }
      // The shadows are installed (the runtime calls this after); once the
      // LISTEN is up, a commit after the read below is routed live into them.
      await withDeadline(
        deps.listening(),
        LISTENING_BUDGET_MS,
        () =>
          new Error(
            `no LISTEN session within ${LISTENING_BUDGET_MS} ms — the changelog replay would leave a gap`,
          ),
      );
      const changes = await readChangelogSince(db, cutXid, "epochHandoff");
      // Read AFTER the rows: a prune that deleted a row at or past the cut
      // before the read moved the horizon there first.
      const horizon = await readPruneHorizon(db);
      if (isPrunedPast(cutXid, horizon)) {
        return { ok: false, reason: "pruned" };
      }
      for (const change of changes) replayChange(change, route);
      return { ok: true };
    },
  };
}
