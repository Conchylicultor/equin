import { db } from "@plugins/database/server";
import { serveValue } from "@plugins/network/plugins/live/server";
import { mailSyncState } from "@plugins/apps/plugins/mail/plugins/mail-core/core";
import { _mailSyncState } from "@plugins/apps/plugins/mail/plugins/mail-core/server";

// Live `mail_sync_state` table mirror — the UI reads sync progress + failures
// off this. A db value: every UPSERT/UPDATE from the sync jobs recomputes and
// pushes it through the DB change-feed (no manual notify) — the declared
// `reads` name the table. The declaration
// (key + schema) lives in `mail-core`, the leaf every mail plugin imports; this
// plugin, which owns the writes, adds the DB half.
export const mailSyncStateServed = serveValue(mailSyncState, {
  source: "db",
  reads: {
    tables: [_mailSyncState],
    reason:
      "a singleton per-account row — any sync progress or failure write changes what the UI shows",
  },
  unbounded: {
    reason:
      "one row per connected mail account — the app is single-account today",
  },
  loader: async () => db.select().from(_mailSyncState),
});
