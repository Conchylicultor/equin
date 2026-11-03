import {
  reportServerError,
  setEpochHandoffHooks,
  type MachinePluginDefinition,
} from "@plugins/framework/plugins/server-core/core";
import { ExcludeFromFork } from "@plugins/database/plugins/admin/server";
import {
  feedCut,
  feedListening,
  getCoveredTables,
} from "@plugins/network/plugins/live/plugins/change-feed/server";
import { db, schemaChangedAtBoot } from "@plugins/database/server";
import { L2CodeDigest } from "../server/internal/code-stamp";
import { healedRollups } from "../server/internal/healed-rollups";
import {
  loadEpochHandoff,
  writeEpochHandoff,
} from "../server/internal/handoff";
import { snapshotLog as log } from "../server/internal/log-sink";
import { liveReadDigest } from "./internal/live-read-digest";
import { sourceDigest } from "@plugins/packages/plugins/source-digest/server";
import {
  LIVE_STATE_HANDOFF_TABLE,
  LIVE_STATE_SNAPSHOT_TABLE,
} from "@plugins/database/plugins/derived-views/core";

export default {
  description:
    "The desktop's half of L2: the snapshot and epoch handoff tables excluded from a worktree's DB fork (forking is the desktop's), the code digest every persisted key's L2 definition is stamped with (the digest of the code its Resource.Declare names — a compiled collection's liveReadCode, a hand-written loader's own module — so a row persisted by other code is recomputed), and the epoch handoff's hooks — a backend replaced by a successor process hands its tuples over under the same digest, and a successor running other code inherits nothing.",
  contributions: [
    // Collected before any `onReadyBlocking`: the server half reads it in its
    // own (it boots first) — `../server/internal/code-stamp`. Each persisted
    // key is stamped with the digest of the code its Declare names.
    L2CodeDigest({ digest: (code) => sourceDigest(code) }),
    // The snapshot is a cold-boot ACCELERATOR, not a correctness prerequisite —
    // `initSnapshotSubsystem` degrades to a full recompute when it is absent, so
    // a fork loses startup latency and nothing else.
    //
    // It must not be inherited, because a persisted value is computed FROM other
    // tables and the fork empties several of them (notifications, mail, the
    // observability set). Keeping the snapshot while emptying its sources would
    // make a fresh worktree serve a value that disagrees with the rows behind it
    // — and for a boot-critical resource that stale value is what the very first
    // paint renders. Emptying both makes that mismatch unrepresentable.
    //
    // A table name string rather than a table object: this table is created with
    // `CREATE TABLE IF NOT EXISTS` (see derived-views/core's imperative-tables),
    // not by a drizzle migration, so there is no table object to pass.
    ExcludeFromFork({
      table: LIVE_STATE_SNAPSHOT_TABLE,
      reason:
        "Cold-boot accelerator computed from tables the fork empties; an inherited value would disagree with the rows behind it on first paint.",
    }),
    // A handoff names a boot of THIS database's backend; a fork's backend
    // never echoes one (its epochs are its own), and the tuples it vouches
    // for were computed from rows the fork empties.
    ExcludeFromFork({
      table: LIVE_STATE_HANDOFF_TABLE,
      reason:
        "The epoch handoff of the source's backend: no fork's tab echoes its epochs, and its tuples were computed from tables the fork empties.",
    }),
  ],
  // The epoch handoff (`../server/internal/handoff`): installed before
  // readiness flips, so the first replayed sub after the swap finds it. Its
  // table is created by the server half's `ensureSnapshotTable`; a degraded
  // init leaves it missing, and every load then fails — reported, and every
  // sub loads. Desktop-only: a browser host has no successor process, and the
  // code digest reads the source on disk.
  onReadyBlocking() {
    setEpochHandoffHooks({
      write: (state) =>
        writeEpochHandoff(db, {
          code: liveReadDigest,
          cut: feedCut,
          state,
          report: (err) => {
            log.publish(
              `[live-state-snapshot] epoch handoff not written: ${String(err)}`,
              "stderr",
            );
            reportServerError({
              message: `[live-state-snapshot] the epoch handoff was not written — the successor reloads every sub: ${String(err)}`,
              errorType: "EpochHandoffError",
            });
          },
        }),
      load: (epoch) =>
        loadEpochHandoff(db, epoch, {
          code: liveReadDigest,
          refused: (reason) =>
            log.publish(
              `[live-state-snapshot] epoch handoff not inherited: ${reason} — every sub loads`,
            ),
          changelogTables: getCoveredTables,
          healedRollups,
          schemaChanged: schemaChangedAtBoot,
          listening: feedListening,
        }),
    });
  },
} satisfies MachinePluginDefinition;
