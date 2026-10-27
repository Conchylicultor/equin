import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { parsedText } from "@plugins/database/plugins/sql-column/server";
import { idColumn } from "@plugins/ids/server";
import {
  NotifyStateSchema,
  SiteMessageVerdictSchema,
  SpamReasonSchema,
  siteMessageIdKind,
} from "../../core";

/**
 * One message a visitor sent through the site's contact form — kept whatever
 * became of it, so nothing a person wrote is lost silently. Spam rows go after
 * `SPAM_RETENTION_DAYS` (`retention.ts`); accepted ones are kept.
 *
 * The visitor's IP is never stored: `ip_hash` is `sha256(install salt ‖ ip)`
 * (`ip-hash.ts`), read only by the rate limiter.
 */
export const siteMessages = pgTable(
  "site_messages",
  {
    id: idColumn(siteMessageIdKind),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    // What the visitor wrote.
    message: text("message").notNull(),
    replyTo: text("reply_to").notNull(),
    // Where it came from.
    host: text("host").notNull(),
    page: text("page").notNull(),
    ipHash: text("ip_hash").notNull(),
    // What the intake decided.
    verdict: parsedText("verdict", SiteMessageVerdictSchema).notNull(),
    /** Set exactly when `verdict` is `spam`. */
    spamReason: parsedText("spam_reason", SpamReasonSchema),
    // The notification email.
    notifyState: parsedText("notify_state", NotifyStateSchema).notNull(),
    /** The provider's (or the network's) last error; null once sent. */
    notifyError: text("notify_error"),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    // The confirmation email: a copy of the message, sent to the visitor so
    // they know it arrived. The same states as the notification; rows from
    // before confirmations existed read `skipped`.
    confirmState: parsedText("confirm_state", NotifyStateSchema)
      .notNull()
      .default("skipped"),
    /** The provider's (or the network's) last error; null once sent. */
    confirmError: text("confirm_error"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  },
  (t) => [
    index("site_messages_ip_hash_created_at_idx").on(t.ipHash, t.createdAt),
    index("site_messages_created_at_idx").on(t.createdAt),
    index("site_messages_notify_state_idx").on(t.notifyState, t.notifiedAt),
    index("site_messages_confirm_state_idx").on(t.confirmState, t.confirmedAt),
  ],
);

/**
 * The install's random salt for `ip_hash`, created on first use. One row:
 * a fixed `name`, so concurrent first messages converge on one salt.
 */
export const siteMessagesSalt = pgTable("site_messages_salt", {
  name: text("name").primaryKey(),
  /** 32 random bytes, hex. */
  salt: text("salt").notNull(),
});
