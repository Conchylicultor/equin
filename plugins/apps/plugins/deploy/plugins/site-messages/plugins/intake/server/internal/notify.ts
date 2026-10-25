import { and, count, desc, eq, gt, isNotNull } from "drizzle-orm";
import type {
  ResendEmail,
  ResendSendResult,
} from "@plugins/integrations/plugins/resend/server";
import type { DeploySecretValue } from "@plugins/apps/plugins/deploy/plugins/deploy-secrets/server";
import type { SiteMessageId } from "../../core";
import type { SiteMessagesDb } from "./db";
import { siteMessages } from "./tables";

/** The notification's sender, on the domain verified in Resend. */
export const NOTIFY_FROM = "equin <noreply@equin.ai>";

/** At most this many notification emails in any 24 hours; the rest are held. */
export const DAILY_EMAIL_CAP = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** What one notify run did — for the job's log and the tests. */
export type NotifyOutcome =
  | { kind: "sent"; providerId: string; held: number }
  | { kind: "not-configured" }
  | { kind: "throttled" }
  /** The row is gone (swept, or never committed) or already settled. */
  | { kind: "nothing-to-do" };

export interface NotifyDeps {
  /** The approved Resend key, as the box sees it. */
  apiKey: DeploySecretValue;
  /** Where the email goes: the site's own published address. */
  to: string;
  send: (apiKey: string, email: ResendEmail) => Promise<ResendSendResult>;
  /** 1-based, and the job's budget: the last attempt records `failed`. */
  attempt: number;
  maxAttempts: number;
  now: Date;
}

/** Thrown for a failed send, so the job retries (and, finally, dead-letters). */
export class NotifySendError extends Error {
  override name = "NotifySendError";
}

/**
 * How many messages the cap held since the last email went out — what the next
 * email owes a mention of.
 */
async function heldSinceLastEmail(dbx: SiteMessagesDb): Promise<number> {
  const [last] = await dbx
    .select({ notifiedAt: siteMessages.notifiedAt })
    .from(siteMessages)
    .where(
      and(
        eq(siteMessages.notifyState, "sent"),
        isNotNull(siteMessages.notifiedAt),
      ),
    )
    .orderBy(desc(siteMessages.notifiedAt))
    .limit(1);
  const [held] = await dbx
    .select({ n: count() })
    .from(siteMessages)
    .where(
      last?.notifiedAt
        ? and(
            eq(siteMessages.notifyState, "throttled"),
            gt(siteMessages.createdAt, last.notifiedAt),
          )
        : eq(siteMessages.notifyState, "throttled"),
    );
  return held?.n ?? 0;
}

async function sentInLastDay(dbx: SiteMessagesDb, now: Date): Promise<number> {
  const [row] = await dbx
    .select({ n: count() })
    .from(siteMessages)
    .where(
      and(
        eq(siteMessages.notifyState, "sent"),
        gt(siteMessages.notifiedAt, new Date(now.getTime() - DAY_MS)),
      ),
    );
  return row?.n ?? 0;
}

/** The email for one message: what was written, then where and when it came from. */
export function notificationEmail(
  message: {
    message: string;
    replyTo: string;
    host: string;
    page: string;
    createdAt: Date;
  },
  held: number,
  to: string,
): ResendEmail {
  const lines = [
    message.message,
    "",
    "—",
    `From: ${message.replyTo} (reply to this email to answer)`,
    `Page: https://${message.host}${message.page}`,
    `Received: ${message.createdAt.toISOString()}`,
  ];
  if (held > 0) {
    lines.push(
      "",
      `${held} more ${held === 1 ? "message was" : "messages were"} held by the daily email cap — see the Deploy page.`,
    );
  }
  return {
    from: NOTIFY_FROM,
    to,
    replyTo: message.replyTo,
    subject: `Website message from ${message.replyTo}`,
    text: lines.join("\n"),
  };
}

/**
 * Email one accepted message. Runs serially (the job's own lane), so the cap's
 * count is exact.
 *
 * - No approved key → `not-configured`, and nothing is thrown: a dev worktree
 *   has none by design.
 * - The cap reached → `throttled`; the next email counts it.
 * - A failed send records the error and THROWS so the job retries; on the
 *   last attempt it records `failed` first, so the inbox says so.
 */
export async function notifySiteMessage(
  dbx: SiteMessagesDb,
  messageId: SiteMessageId,
  deps: NotifyDeps,
): Promise<NotifyOutcome> {
  const [row] = await dbx
    .select()
    .from(siteMessages)
    .where(eq(siteMessages.id, messageId));
  if (!row || row.notifyState !== "pending") return { kind: "nothing-to-do" };

  const settle = (
    patch: Partial<typeof siteMessages.$inferInsert>,
  ): Promise<unknown> =>
    dbx.update(siteMessages).set(patch).where(eq(siteMessages.id, messageId));

  if (deps.apiKey.kind === "unset") {
    await settle({ notifyState: "not-configured" });
    return { kind: "not-configured" };
  }
  if ((await sentInLastDay(dbx, deps.now)) >= DAILY_EMAIL_CAP) {
    await settle({ notifyState: "throttled" });
    return { kind: "throttled" };
  }

  const held = await heldSinceLastEmail(dbx);
  const email = notificationEmail(row, held, deps.to);
  const final = deps.attempt >= deps.maxAttempts;
  let result: ResendSendResult;
  try {
    result = await deps.send(deps.apiKey.value, email);
  } catch (err) {
    // No answer at all (network, timeout): the same retry path as a refusal.
    await settle({
      notifyError: err instanceof Error ? err.message : String(err),
      ...(final ? { notifyState: "failed" as const } : {}),
    });
    throw err;
  }
  if (!result.ok) {
    const error = `Resend answered ${result.status}: ${result.error}`;
    await settle({
      notifyError: error,
      ...(final ? { notifyState: "failed" as const } : {}),
    });
    throw new NotifySendError(error);
  }
  await settle({
    notifyState: "sent",
    notifyError: null,
    notifiedAt: deps.now,
  });
  return { kind: "sent", providerId: result.id, held };
}
