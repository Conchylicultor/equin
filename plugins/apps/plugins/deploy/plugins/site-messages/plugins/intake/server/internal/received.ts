import { db } from "@plugins/database/server";
import { siteMessageIdKind } from "../../core";
import { siteMessages } from "./tables";

/** A fixed stand-in for the salted IP hash: a seeded message has no sender IP. */
const SEEDED_IP_HASH = "seeded-message-no-ip";

/**
 * Store one message as if the intake had accepted it and both emails had
 * gone out: verdict `accepted`, notification and confirmation `sent`, all at
 * `createdAt`. For a demo's seed — nothing is enqueued, so no email is sent.
 */
export async function insertReceivedSiteMessage(message: {
  createdAt: Date;
  message: string;
  replyTo: string;
  host: string;
  page: string;
}): Promise<void> {
  await db.insert(siteMessages).values({
    id: siteMessageIdKind.mint(),
    createdAt: message.createdAt,
    message: message.message,
    replyTo: message.replyTo,
    host: message.host,
    page: message.page,
    ipHash: SEEDED_IP_HASH,
    verdict: "accepted",
    spamReason: null,
    notifyState: "sent",
    notifiedAt: message.createdAt,
    confirmState: "sent",
    confirmedAt: message.createdAt,
  });
}
