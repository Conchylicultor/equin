import { and, eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { serveValue } from "@plugins/network/plugins/live/server";
import { mailLabels } from "../../core";
import { _mailAccounts, _mailLabels } from "./tables";
import { resolveMailAccountId } from "./account";

// User labels for the connected account, ordered by name. A db value: the
// declared `reads` route every label upsert from the sync engine back here
// through the DB change-feed, which recomputes and pushes the whole list.
// Returns [] on a cold mailbox (no account yet) — a legitimate answer, not a
// stand-in: there are no labels to name.
export const mailLabelsServed = serveValue(mailLabels, {
  source: "db",
  reads: {
    tables: [_mailLabels, _mailAccounts],
    reason:
      "the whole user-label list of the connected account, whose choice reads every account row — whole-table until it reads through a collection",
  },
  unbounded: {
    reason:
      "the connected account's user labels — Gmail caps an account's labels in the thousands, so the whole list is the working set",
  },
  loader: async () => {
    const accountId = await resolveMailAccountId();
    if (!accountId) return [];
    return db
      .select()
      .from(_mailLabels)
      .where(
        and(eq(_mailLabels.accountId, accountId), eq(_mailLabels.type, "user")),
      )
      .orderBy(_mailLabels.name);
  },
});
