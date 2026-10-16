import { db } from "@plugins/database/server";
import { serveValue } from "@plugins/network/plugins/live/server";
import { mailAccount } from "../../core";
import { readMailAccount } from "./account";
import { _mailAccounts } from "./tables";

// The connected account (or `null`), recomputed by the change feed on every
// write to its declared `reads` table, `mail_accounts`. One row — no `unbounded` reason to state.
export const mailAccountServed = serveValue(mailAccount, {
  source: "db",
  reads: {
    tables: [_mailAccounts],
    reason:
      "the earliest connected account is picked across every account row, so any account write may change it",
  },
  loader: () => readMailAccount(db),
});
