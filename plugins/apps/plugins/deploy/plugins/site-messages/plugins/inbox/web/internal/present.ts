import type { SpamReason } from "@plugins/apps/plugins/deploy/plugins/site-messages/plugins/intake/core";

export const SPAM_REASON_LABEL: Record<SpamReason, string> = {
  honeypot: "filled the hidden field a person never sees",
  "too-fast": "sent less than three seconds after the form opened",
  "bot-user-agent": "sent by a crawler or an HTTP library",
};

/** A reply to the visitor, from the user's own mail client. */
export function replyHref(replyTo: string): string {
  return `mailto:${replyTo}?subject=${encodeURIComponent("Re: your message")}`;
}

/** A message's first line: what a list row shows of it. */
export function firstLine(message: string): string {
  return message.split("\n")[0]!;
}
