import { desc, eq } from "drizzle-orm";
import { SiteMessagesListQuerySchema, type SiteMessagesPage } from "../../core";
import type { z } from "zod";
import type { SiteMessagesDb } from "./db";
import { siteMessages } from "./tables";

/** One bounded page of stored messages, newest first, optionally one verdict. */
export async function listSiteMessages(
  dbx: SiteMessagesDb,
  query: z.output<typeof SiteMessagesListQuerySchema>,
): Promise<SiteMessagesPage> {
  const rows = await dbx
    .select()
    .from(siteMessages)
    .where(
      query.verdict === undefined
        ? undefined
        : eq(siteMessages.verdict, query.verdict),
    )
    .orderBy(desc(siteMessages.createdAt))
    // One past the page: whether more exist, without a count.
    .limit(query.limit + 1);
  return {
    kind: "messages",
    hasMore: rows.length > query.limit,
    messages: rows.slice(0, query.limit).map((r) => ({
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      message: r.message,
      replyTo: r.replyTo,
      host: r.host,
      page: r.page,
      verdict: r.verdict,
      spamReason: r.spamReason,
      notifyState: r.notifyState,
      notifyError: r.notifyError,
      notifiedAt: r.notifiedAt?.toISOString() ?? null,
    })),
  };
}
