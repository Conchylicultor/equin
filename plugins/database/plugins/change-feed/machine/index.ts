import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ExcludeFromFork } from "@plugins/database/plugins/admin/server";
import { LIVE_STATE_CHANGELOG_TABLE } from "@plugins/database/plugins/derived-views/core";

export default {
  description:
    "The change feed's changelog excluded from a worktree's DB fork — forking is the desktop's, so this half is too.",
  contributions: [
    // The changelog is this feed's transactional OUTBOX — a bounded replay
    // buffer the L2 cold-boot catch-up reads to find what changed while a
    // backend was down. Its entries describe commits against the database that
    // produced them, and it is pruned against that database's own snapshot
    // watermark, so a fork inherits replay instructions for a history it does
    // not share. It is excluded together with `live_state_snapshot` (declared by
    // live-state-snapshot, which owns that table): catch-up compares the two, so
    // emptying one and not the other would leave the pair disagreeing.
    //
    // A table name string rather than a table object: the changelog is created
    // inside the server half's trigger-rebuild transaction, not by a drizzle
    // migration, so there is no table object to pass.
    ExcludeFromFork({
      table: LIVE_STATE_CHANGELOG_TABLE,
      reason:
        "Replay outbox describing commits against the source database, pruned against its own watermark; excluded together with live_state_snapshot.",
    }),
  ],
} satisfies MachinePluginDefinition;
