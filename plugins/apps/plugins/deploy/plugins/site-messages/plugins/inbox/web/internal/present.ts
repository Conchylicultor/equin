import type { BadgeVariant } from "@plugins/primitives/plugins/css/plugins/badge/web";
import type {
  NotifyState,
  SiteMessageVerdict,
  SpamReason,
} from "@plugins/apps/plugins/deploy/plugins/site-messages/plugins/intake/core";

export const VERDICT_LABEL: Record<SiteMessageVerdict, string> = {
  accepted: "Message",
  spam: "Spam",
};

export const VERDICT_VARIANT: Record<SiteMessageVerdict, BadgeVariant> = {
  accepted: "success",
  spam: "muted",
};

export const SPAM_REASON_LABEL: Record<SpamReason, string> = {
  honeypot: "filled the hidden field a person never sees",
  "too-fast": "sent less than three seconds after the form opened",
  "bot-user-agent": "sent by a crawler or an HTTP library",
};

export const NOTIFY_LABEL: Record<NotifyState, string> = {
  pending: "Sending",
  sent: "Emailed",
  failed: "Email failed",
  "not-configured": "No email key",
  throttled: "Held (daily cap)",
  skipped: "Not emailed",
};

export const NOTIFY_VARIANT: Record<NotifyState, BadgeVariant> = {
  pending: "info",
  sent: "success",
  failed: "destructive",
  "not-configured": "warning",
  throttled: "warning",
  skipped: "muted",
};

/** A reply to the visitor, from the user's own mail client. */
export function replyHref(replyTo: string): string {
  return `mailto:${replyTo}?subject=${encodeURIComponent("Re: your message")}`;
}
