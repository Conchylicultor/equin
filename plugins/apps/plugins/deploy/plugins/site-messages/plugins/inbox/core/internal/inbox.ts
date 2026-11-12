import { nullable } from "@plugins/fields/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import {
  enumTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import {
  liveCollection,
  type LiveRowsCollection,
} from "@plugins/network/plugins/live/core";
import {
  NOTIFY_STATES,
  SITE_MESSAGE_VERDICTS,
  SPAM_REASONS,
} from "@plugins/apps/plugins/deploy/plugins/site-messages/plugins/intake/core";

// The fields of one message, as the inbox lists, filters and searches them.
// `deploymentId` is the scope every read states
// (`scoped({ where: { deploymentId } })`), which only a listed field can be.
const SITE_MESSAGE_FIELDS = {
  replyTo: textField({ label: "From", primary: true }),
  message: textField({ label: "Message" }),
  createdAt: dateField({ label: "Received" }),
  verdict: enumTextField(SITE_MESSAGE_VERDICTS, {
    label: "Verdict",
    options: {
      accepted: { label: "Message", variant: "success" },
      spam: { label: "Spam", variant: "muted" },
    },
  }),
  notifyState: enumTextField(NOTIFY_STATES, {
    label: "Notification",
    options: {
      pending: { label: "Sending", variant: "info" },
      sent: { label: "Emailed", variant: "success" },
      failed: { label: "Email failed", variant: "destructive" },
      "not-configured": { label: "No email key", variant: "warning" },
      throttled: { label: "Held (daily cap)", variant: "warning" },
      skipped: { label: "Not emailed", variant: "muted" },
    },
  }),
  deploymentId: textField({ label: "Site" }),
};

// On the row, in no list: what the opened message shows.
const SITE_MESSAGE_CARRIED = {
  /** `<deploymentId>/<messageId>` (`siteMessageRowId`): one id across every site's copy. */
  id: textField(),
  /** The intake's own id (`smsg-…`). */
  messageId: textField(),
  host: textField(),
  page: textField(),
  /** Set exactly when `verdict` is `spam`. */
  spamReason: nullable(enumTextField(SPAM_REASONS)),
  /** The provider's (or the network's) last error; null once sent. */
  notifyError: nullable(textField()),
  notifiedAt: nullable(dateField()),
};

/** How many messages one window of {@link siteMessagesInbox} holds at most. */
export const SITE_MESSAGES_INBOX_MAX_LIMIT = 200;

/**
 * A deployed site's contact-form messages, read from this computer's copy of
 * the site's `site_messages` (`apps/deploy/site-mirror`, the intake's
 * `site_messages` mirror set): a live window, newest first, cut on
 * `(createdAt, id)` and read as key-range pages — every message the box
 * holds, searched and filtered in SQL, with no cap past the paging. Served
 * external (the copy lives in a per-replica schema outside the change feed),
 * notified whenever a sync applies a page. Every read names one deployment
 * (`where: { deploymentId }`).
 */
export const siteMessagesInbox = liveCollection("deploy-site-messages.inbox", {
  fields: SITE_MESSAGE_FIELDS,
  carry: { fields: SITE_MESSAGE_CARRIED },
  id: "id",
  sortable: ["createdAt"],
  default: { orderBy: [["createdAt", "desc"]], limit: 50 },
  maxLimit: SITE_MESSAGES_INBOX_MAX_LIMIT,
  count: true,
});

/** One message: a row of {@link siteMessagesInbox}. */
export type SiteMessageRow =
  typeof siteMessagesInbox extends LiveRowsCollection<infer R> ? R : never;

/**
 * A message's row id: its deployment, then the intake's id. The `:rows` read
 * carries ids alone, so the id names which site's copy to read; within one
 * deployment it orders exactly as the message id does (one shared prefix).
 */
export function siteMessageRowId(
  deploymentId: string,
  messageId: string,
): string {
  return `${deploymentId}/${messageId}`;
}

/** The two halves of a {@link siteMessageRowId}; throws on anything else. */
export function parseSiteMessageRowId(id: string): {
  deploymentId: string;
  messageId: string;
} {
  const slash = id.indexOf("/");
  if (
    slash <= 0 ||
    slash === id.length - 1 ||
    id.indexOf("/", slash + 1) !== -1
  ) {
    throw new Error(
      `deploy-site-messages.inbox: "${id}" is not a <deploymentId>/<messageId> row id`,
    );
  }
  return { deploymentId: id.slice(0, slash), messageId: id.slice(slash + 1) };
}
