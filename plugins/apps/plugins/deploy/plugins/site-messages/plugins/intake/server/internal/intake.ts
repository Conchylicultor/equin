import { and, eq, gt, sql } from "drizzle-orm";
import {
  siteMessageIdKind,
  type SiteMessageBody,
  type SiteMessageId,
  type SiteMessageResponse,
} from "../../core";
import { classifySiteMessage } from "./classify";
import type { SiteMessagesDb, SiteMessagesTx } from "./db";
import { ipHash } from "./ip-hash";
import { RATE_LOOKBACK_MS, rateDecision } from "./rate-limit";
import { siteMessages } from "./tables";

/** What the request itself says about the sender. Used in memory, never stored as-is. */
export interface IntakeContext {
  ip: string;
  userAgent: string;
  now: Date;
}

/**
 * How an accepted message's emails are queued — the notification to the site
 * and the confirmation to the visitor — in the SAME transaction as its row, so
 * a message is never stored without its jobs nor a job enqueued for a row that
 * rolled back. The route passes the notify and confirm jobs; a test its own.
 */
export type EnqueueEmails = (
  messageId: SiteMessageId,
  tx: SiteMessagesTx,
) => Promise<unknown>;

/**
 * Take one message from the contact form.
 *
 * Under the visitor's advisory lock (so a burst cannot race past the limit):
 * over the rate limit → `rate-limited`, nothing stored. Otherwise the message
 * is stored whatever it is — spam with its reason, never emailed; accepted
 * with its notification and its confirmation queued. Spam is answered `sent` like the rest.
 */
export async function recordSiteMessage(
  dbx: SiteMessagesDb,
  body: SiteMessageBody,
  ctx: IntakeContext,
  enqueueEmails: EnqueueEmails,
): Promise<SiteMessageResponse> {
  const hash = await ipHash(dbx, ctx.ip);
  return dbx.transaction(async (tx) => {
    // Transaction-scoped, so PgBouncer's transaction pooling keeps it sound.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`site-messages:${hash}`}, 0))`,
    );
    const prior = await tx
      .select({ createdAt: siteMessages.createdAt })
      .from(siteMessages)
      .where(
        and(
          eq(siteMessages.ipHash, hash),
          gt(
            siteMessages.createdAt,
            new Date(ctx.now.getTime() - RATE_LOOKBACK_MS),
          ),
        ),
      );
    const rate = rateDecision(
      prior.map((r) => r.createdAt),
      ctx.now,
    );
    if (!rate.ok)
      return { kind: "rate-limited", retryAfterS: rate.retryAfterS };

    const verdict = classifySiteMessage({
      honeypot: body.honeypot,
      elapsedMs: body.elapsedMs,
      userAgent: ctx.userAgent,
    });
    const id = siteMessageIdKind.mint();
    await tx.insert(siteMessages).values({
      id,
      createdAt: ctx.now,
      message: body.message,
      replyTo: body.replyTo,
      host: body.host,
      page: body.page,
      ipHash: hash,
      verdict: verdict.verdict,
      spamReason: verdict.verdict === "spam" ? verdict.reason : null,
      notifyState: verdict.verdict === "spam" ? "skipped" : "pending",
      confirmState: verdict.verdict === "spam" ? "skipped" : "pending",
    });
    if (verdict.verdict === "accepted") await enqueueEmails(id, tx);
    return { kind: "sent" };
  });
}
