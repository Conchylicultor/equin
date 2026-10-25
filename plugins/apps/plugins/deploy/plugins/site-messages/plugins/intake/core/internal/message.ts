import { z } from "zod";
import {
  PagePathSchema,
  SiteHostSchema,
} from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/core";

/** A request whose declared `Content-Length` exceeds this is refused (413). */
export const MAX_SITE_MESSAGE_BODY_BYTES = 8192;
/** A message's length, after trimming. */
export const MAX_MESSAGE_LENGTH = 5000;
/** RFC 5321's limit on a forward path. */
export const MAX_REPLY_TO_LENGTH = 254;
/** Any honeypot value longer than this is malformed, not just filled. */
export const MAX_HONEYPOT_LENGTH = 256;
/**
 * A person takes longer than this between opening the form and sending it; a
 * script posting the moment the page loads does not. Faster is spam.
 */
export const MIN_HUMAN_ELAPSED_MS = 3000;
/** An `elapsedMs` above a day is a stuck tab or a lie; both are refused. */
const MAX_ELAPSED_MS = 24 * 60 * 60 * 1000;

/**
 * What the contact form posts to `POST /api/site-messages`. The server reads
 * the visitor's IP and user agent from the request itself — never the body.
 */
export const SiteMessageBodySchema = z
  .object({
    message: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
    replyTo: z.string().trim().max(MAX_REPLY_TO_LENGTH).email(),
    /**
     * The visually hidden `website` field. A person never sees it; a bot that
     * fills every input does — a non-empty value files the message as spam.
     */
    honeypot: z.string().max(MAX_HONEYPOT_LENGTH),
    /** Milliseconds from the form opening to Send. */
    elapsedMs: z.number().int().min(0).max(MAX_ELAPSED_MS),
    /** `location.host` — the gateway rewrites the `Host` header. */
    host: SiteHostSchema,
    /** The page the form was sent from (its query string is dropped). */
    page: PagePathSchema,
  })
  .strict();
export type SiteMessageBody = z.infer<typeof SiteMessageBodySchema>;

/**
 * What the endpoint answers. Spam is answered `sent` too, so a bot learns
 * nothing about why its message went nowhere. `rate-limited` is the one
 * refusal a person may meet, with how long to wait.
 */
export const SiteMessageResponseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("sent") }).strict(),
  z
    .object({
      kind: z.literal("rate-limited"),
      retryAfterS: z.number().int().min(1),
    })
    .strict(),
]);
export type SiteMessageResponse = z.infer<typeof SiteMessageResponseSchema>;
