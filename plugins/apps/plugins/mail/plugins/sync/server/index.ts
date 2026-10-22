import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { mailSyncEndpoint, mailHydrateMessageEndpoint } from "../core";
import { handleMailSync, handleMailHydrate } from "./internal/handlers";
import { backfillJob } from "./internal/backfill";
import { deltaJob } from "./internal/delta";
import { syncTickJob } from "./internal/tick";
import { attachmentScanJob } from "./internal/attachment-scan";
import { hydrateJob } from "./internal/hydrate";
import { mailSyncStateServed } from "./internal/resource";
import { mailMessageBodyServed } from "./internal/body-value";
import { mailSearchServed } from "./internal/search-value";

export default {
  description:
    "Gmail sync engine (on-demand model): a bounded, metadata-only backfill mirrors a recent window of message envelopes; history.list incremental delta keeps them fresh (with a bounded full-resync fallback on historyId expiry) via a scheduled main-only delta tick (the documented no-polling exception). Message bodies + attachments are hydrated lazily on first open by the mail.hydrate job (asked for by a mail.message-body subscriber, or POST /api/mail/hydrate to retry) and cached; the mail.message-body value reads one message's body state from the mirror. The mail.search paged value answers a Gmail search as ranked thread ids, mirroring the envelopes it sees. Mirrors threads/messages/labels into the mail-core tables.",
  contributions: [
    ...mailSyncStateServed.declare,
    ...mailMessageBodyServed.declare,
    ...mailSearchServed.declare,
  ],
  httpRoutes: {
    [mailSyncEndpoint.route]: handleMailSync,
    [mailHydrateMessageEndpoint.route]: handleMailHydrate,
  },
  register: [backfillJob, deltaJob, syncTickJob, attachmentScanJob, hydrateJob],
} satisfies ServerPluginDefinition;
