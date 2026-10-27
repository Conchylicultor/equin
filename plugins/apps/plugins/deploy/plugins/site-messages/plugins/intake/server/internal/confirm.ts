import { and, count, eq, gt, sql } from "drizzle-orm";
import type { ResendEmail } from "@plugins/integrations/plugins/resend/server";
import type { SiteMessageId } from "../../core";
import type { SiteMessagesDb } from "./db";
import { NOTIFY_FROM, sendOrRecord, type SendDeps } from "./notify";
import { siteMessages } from "./tables";

/** At most this many confirmations in any 24 hours, whoever they go to. */
export const CONFIRM_DAILY_CAP = 30;
/**
 * At most this many confirmations to one address in any 24 hours — the form
 * takes any address, so without this anyone could use it to flood a stranger's
 * inbox from many IPs (the per-visitor rate limit keys on the sender, not the
 * recipient).
 */
export const CONFIRM_PER_ADDRESS_CAP = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

/** What one confirm run did — for the job's log and the tests. */
export type ConfirmOutcome =
  | { kind: "sent"; providerId: string }
  | { kind: "not-configured" }
  | { kind: "throttled" }
  /** The row is gone (swept, or never committed) or already settled. */
  | { kind: "nothing-to-do" };

export interface ConfirmDeps extends SendDeps {
  /** Where the visitor's reply goes: the site's own published address. */
  contact: string;
}

/** Confirmations sent in the last day — to `replyTo` alone when given. */
async function confirmedInLastDay(
  dbx: SiteMessagesDb,
  now: Date,
  replyTo?: string,
): Promise<number> {
  const [row] = await dbx
    .select({ n: count() })
    .from(siteMessages)
    .where(
      and(
        eq(siteMessages.confirmState, "sent"),
        gt(siteMessages.confirmedAt, new Date(now.getTime() - DAY_MS)),
        replyTo === undefined
          ? undefined
          : sql`lower(${siteMessages.replyTo}) = lower(${replyTo})`,
      ),
    );
  return row?.n ?? 0;
}

/** The confirmation: that the message arrived, then a copy of it. */
export function confirmationEmail(
  message: {
    message: string;
    replyTo: string;
    host: string;
    page: string;
    createdAt: Date;
  },
  contact: string,
): ResendEmail {
  return {
    from: NOTIFY_FROM,
    to: message.replyTo,
    replyTo: contact,
    subject: "We received your message",
    text: [
      "Thanks for writing — your message reached us, and we'll reply to this address.",
      "",
      "What you sent:",
      "",
      ...message.message.split("\n").map((line) => `> ${line}`),
      "",
      "—",
      `Sent from https://${message.host}${message.page} on ${message.createdAt.toISOString()}.`,
      "To add something, reply to this email.",
      "If you didn't write this, you can ignore it.",
    ].join("\n"),
  };
}

/**
 * Email the visitor a copy of one accepted message, so they know it arrived.
 * Runs serially (the job's own lane), so the caps' counts are exact.
 *
 * - No approved key → `not-configured`, and nothing is thrown.
 * - A cap reached (the day's, or the address's) → `throttled`; never sent later.
 * - A failed send records the error and THROWS so the job retries; on the
 *   last attempt it records `failed` first.
 */
export async function confirmSiteMessage(
  dbx: SiteMessagesDb,
  messageId: SiteMessageId,
  deps: ConfirmDeps,
): Promise<ConfirmOutcome> {
  const [row] = await dbx
    .select()
    .from(siteMessages)
    .where(eq(siteMessages.id, messageId));
  if (!row || row.confirmState !== "pending") return { kind: "nothing-to-do" };

  const settle = (
    patch: Partial<typeof siteMessages.$inferInsert>,
  ): Promise<unknown> =>
    dbx.update(siteMessages).set(patch).where(eq(siteMessages.id, messageId));

  if (deps.apiKey.kind === "unset") {
    await settle({ confirmState: "not-configured" });
    return { kind: "not-configured" };
  }
  if (
    (await confirmedInLastDay(dbx, deps.now)) >= CONFIRM_DAILY_CAP ||
    (await confirmedInLastDay(dbx, deps.now, row.replyTo)) >=
      CONFIRM_PER_ADDRESS_CAP
  ) {
    await settle({ confirmState: "throttled" });
    return { kind: "throttled" };
  }

  const providerId = await sendOrRecord(
    deps.apiKey.value,
    confirmationEmail(row, deps.contact),
    deps,
    (error, final) =>
      settle({
        confirmError: error,
        ...(final ? { confirmState: "failed" as const } : {}),
      }),
  );
  await settle({
    confirmState: "sent",
    confirmError: null,
    confirmedAt: deps.now,
  });
  return { kind: "sent", providerId };
}
