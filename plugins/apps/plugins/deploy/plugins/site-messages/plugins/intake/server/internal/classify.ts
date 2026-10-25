import { isBotUserAgent } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/host-only/server";
import { MIN_HUMAN_ELAPSED_MS, type SpamReason } from "../../core";

/** What the intake decided about one message. */
export type Classification =
  { verdict: "accepted" } | { verdict: "spam"; reason: SpamReason };

/**
 * Is this a person? Every signal is server-side and cheap: the hidden
 * honeypot field filled, the form sent faster than a person could write it,
 * or a crawler / HTTP library's user agent. First match names the reason.
 */
export function classifySiteMessage(input: {
  honeypot: string;
  elapsedMs: number;
  userAgent: string;
}): Classification {
  if (input.honeypot.trim() !== "")
    return { verdict: "spam", reason: "honeypot" };
  if (input.elapsedMs < MIN_HUMAN_ELAPSED_MS)
    return { verdict: "spam", reason: "too-fast" };
  if (isBotUserAgent(input.userAgent))
    return { verdict: "spam", reason: "bot-user-agent" };
  return { verdict: "accepted" };
}
