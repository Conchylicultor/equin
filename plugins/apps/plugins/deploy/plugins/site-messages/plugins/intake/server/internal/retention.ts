import { eq } from "drizzle-orm";
import { defineRetention } from "@plugins/infra/plugins/retention/server";
import { SPAM_RETENTION_DAYS } from "../../core";
import { siteMessages } from "./tables";

/** The rows the sweep may delete: spam only — accepted messages are kept. */
export const SPAM_ONLY = eq(siteMessages.verdict, "spam");

/**
 * Spam goes after {@link SPAM_RETENTION_DAYS}; a person's message is never
 * swept. `perWorktree: true` because a deployed release is never main, and
 * only perWorktree crons install there.
 */
export const siteMessagesSpamRetention = defineRetention({
  table: siteMessages,
  column: "createdAt",
  ttlDays: SPAM_RETENTION_DAYS,
  perWorktree: true,
  where: SPAM_ONLY,
});
