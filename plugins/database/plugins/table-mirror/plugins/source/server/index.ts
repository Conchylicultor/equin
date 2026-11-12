import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { DatabaseDriver, db } from "@plugins/database/server";
import { DbTriggerClaim } from "@plugins/database/plugins/db-triggers/server";
import { ExcludeFromChangeFeed } from "@plugins/network/plugins/live/plugins/change-feed/server";
import { MirrorSet, NeverMirrored } from "./internal/define";
import { installMirrorSource } from "./internal/install";
import { tableMirrorPruneJob } from "./internal/prune";
import { tableMirrorLog } from "./internal/tables";
import { TABLE_MIRROR_TRIGGER_SET } from "./internal/triggers";

export {
  MirrorSet,
  NeverMirrored,
  type MirrorSetDefinition,
  type MirrorSetSpec,
  type MirroredTable,
  type NeverMirroredSpec,
} from "./internal/define";
export { resolveMirrorSet } from "./internal/registry";
export type {
  ReadMirrorChangesOptions,
  ReadMirrorCopyOptions,
  ReadMirrorKeysOptions,
  ReadMirrorRowsOptions,
} from "./internal/read";
export { readSourceIdentity, readTableFingerprints } from "./internal/identity";
export { mirrorSql } from "./internal/sql";

export default {
  description:
    "The table mirror's source half: defineMirrorSet / MirrorSet (tables mirrored together) and NeverMirrored (tables whose rows never leave, refused at module eval and at boot); generated statement-level change-log triggers (one table_mirror_log row per primary key — cascaded deletes, retention and TRUNCATE included); the source identity and per-table fingerprints; the readers — the delta stream paged by a { floor, after } xid8 cursor, a first-sync copy, and reconciliation's key + hash walk and rows by key; and the daily log prune at the 30-day horizon, below which a replica is answered reconcile-required.",
  contributions: [
    // Installed by this plugin's own call in onReadyBlocking (derived from the
    // contributed sets, one table per transaction), never by the schema layer.
    DbTriggerClaim({
      id: TABLE_MIRROR_TRIGGER_SET,
      reason:
        "derived from the contributed MirrorSet declarations and installed one table per transaction in table-mirror/source's onReadyBlocking",
    }),
    // Written by a trigger on every write to a mirrored table (every public
    // pageview, for analytics); read only by a replica's pull, never live.
    ExcludeFromChangeFeed({
      table: tableMirrorLog,
      reason:
        "Written by the mirror triggers on every write to a mirrored table; read only by a replica's pull, never by a live-state resource.",
    }),
  ],
  register: [tableMirrorPruneJob],
  async onReadyBlocking() {
    const sets = MirrorSet.getContributions();
    const never = NeverMirrored.getContributions();
    await DatabaseDriver.get().bootDdl(
      () => installMirrorSource(db, sets, never),
      "boot: table-mirror triggers",
    );
  },
} satisfies ServerPluginDefinition;
