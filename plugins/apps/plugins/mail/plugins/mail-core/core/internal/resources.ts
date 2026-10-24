import { liveValue } from "@plugins/network/plugins/live/core";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";
import {
  MailAccountSchema,
  MailSyncStateSchema,
  MailLabelSchema,
} from "./fields";

// One row per connected account's sync-engine watermark + error state. Served by
// the `sync` plugin (`mailSyncStateServed`), which loads the whole
// `mail_sync_state` table; table writes recompute and push it via the DB
// change-feed, so the UI sees failures/progress live. A value, not a
// collection: both readers fold every row into one sync view.
export const mailSyncState = liveValue("mail-sync-state", {
  schema: wholeList(MailSyncStateSchema, {
    reason:
      "one row per connected mail account — the app is single-account today",
  }),
});

// The account's user labels, ordered by name. Served here
// (`mailLabelsServed`) over `mail_labels`: every label upsert from the sync
// engine recomputes and pushes it via the DB change-feed.
//
// It lives HERE, in the leaf every mail plugin already imports, rather than in
// its consumer: the threads DataView reads it for the friendly label names its
// `labels` field options carry, so a filter chip reads "Promotions" rather than
// "Label_12". Hosting it in a consumer would force any future one to import that
// consumer and risk closing a cycle.
export const mailLabels = liveValue("mail-labels", {
  schema: wholeList(MailLabelSchema, {
    reason:
      "the connected account's user labels — Gmail caps an account's labels in the thousands, so the whole list is the working set",
  }),
});

/**
 * THE connected account — the one the mail surfaces show — or `null` before
 * any account has connected. One row, never collection-shaped: the earliest
 * connected (`connected_at`, then `id`), the same definition
 * `resolveMailAccountId` uses server-side, so "the account" is one choice.
 *
 * The threads list reads it to scope its live window to the account
 * (`mailThreadsSource.scoped({ where: { accountId } })`): the scope is data
 * the client states, not a subquery the server hides.
 */
export const mailAccount = liveValue("mail-account", {
  schema: MailAccountSchema.pick({ id: true, email: true }).nullable(),
});
