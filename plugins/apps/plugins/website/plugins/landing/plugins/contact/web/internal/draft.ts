import {
  SiteMessageBodySchema,
  type SiteMessageBody,
  type SiteMessageResponse,
} from "@plugins/apps/plugins/deploy/plugins/site-messages/plugins/intake/core";

/** What the visitor has typed. Kept across closing and reopening the form. */
export interface ContactDraft {
  message: string;
  email: string;
  /** The hidden `website` field — a person never fills it. */
  honeypot: string;
}

export const EMPTY_DRAFT: ContactDraft = {
  message: "",
  email: "",
  honeypot: "",
};

/**
 * Send is offered only for a message and a valid address — the server's own
 * rules (the body schema's fields), so the form never offers what it refuses.
 */
export function canSend(draft: ContactDraft): boolean {
  return (
    SiteMessageBodySchema.shape.message.safeParse(draft.message).success &&
    SiteMessageBodySchema.shape.replyTo.safeParse(draft.email).success
  );
}

/** The request body for a draft sent `elapsedMs` after the form opened, from `where`. */
export function messageBody(
  draft: ContactDraft,
  elapsedMs: number,
  where: { host: string; page: string },
): SiteMessageBody {
  return {
    message: draft.message.trim(),
    replyTo: draft.email.trim(),
    honeypot: draft.honeypot,
    elapsedMs: Math.max(0, Math.round(elapsedMs)),
    host: where.host,
    page: where.page,
  };
}

/** Where the form stands after a send attempt (or before any). */
export type ContactPhase =
  | { kind: "compose"; notice: ComposeNotice | null }
  | { kind: "sent"; replyTo: string };

/** A send that did not land — said inline, the typed text kept. */
export type ComposeNotice =
  | { kind: "rate-limited"; retryAfterS: number }
  | { kind: "error"; message: string };

export function phaseAfter(
  response: SiteMessageResponse,
  replyTo: string,
): ContactPhase {
  return response.kind === "sent"
    ? { kind: "sent", replyTo }
    : {
        kind: "compose",
        notice: { kind: "rate-limited", retryAfterS: response.retryAfterS },
      };
}

/** "a minute", "5 minutes", "2 hours" — how long a rate-limited visitor waits. */
export function waitText(retryAfterS: number): string {
  const minutes = Math.ceil(retryAfterS / 60);
  if (minutes <= 1) return "a minute";
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.ceil(minutes / 60);
  return hours === 1 ? "an hour" : `${hours} hours`;
}
