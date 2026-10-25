import { z } from "zod";

/** Resend's send endpoint (https://resend.com/docs/api-reference/emails/send-email). */
export const RESEND_EMAILS_URL = "https://api.resend.com/emails";

/** One plain-text email. `from` is `Name <address>` on a domain verified in Resend. */
export interface ResendEmail {
  from: string;
  to: string;
  /** Where a reply goes — the person the email is about, not the sender. */
  replyTo: string;
  subject: string;
  text: string;
}

/**
 * What Resend answered. A failure is the provider's own words (`error`) and the
 * HTTP status, never an empty id: the caller decides whether to retry.
 */
export type ResendSendResult =
  { ok: true; id: string } | { ok: false; status: number; error: string };

const SentSchema = z.object({ id: z.string().min(1) });
/** Resend's error body: `{ statusCode, name, message }`. */
const ErrorSchema = z.object({
  name: z.string().optional(),
  message: z.string(),
});

/** How much of an unparseable body is kept in `error`. */
const BODY_HEAD_CHARS = 300;

/**
 * Map one HTTP answer to a result. A 2xx without an id, or an error body that
 * is not Resend's shape, is still a failure — named with the head of the body —
 * so nothing reads as sent unless Resend said so.
 */
export function parseResendResponse(
  status: number,
  body: string,
): ResendSendResult {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return {
      ok: false,
      status,
      error: `Not JSON: ${body.slice(0, BODY_HEAD_CHARS)}`,
    };
  }
  if (status >= 200 && status < 300) {
    const sent = SentSchema.safeParse(json);
    return sent.success
      ? { ok: true, id: sent.data.id }
      : {
          ok: false,
          status,
          error: `Answered ${status} without an email id: ${body.slice(0, BODY_HEAD_CHARS)}`,
        };
  }
  const failed = ErrorSchema.safeParse(json);
  return {
    ok: false,
    status,
    error: failed.success
      ? failed.data.name
        ? `${failed.data.name}: ${failed.data.message}`
        : failed.data.message
      : body.slice(0, BODY_HEAD_CHARS),
  };
}

/** The request body Resend expects, in its own field names. */
export function resendRequestBody(email: ResendEmail): string {
  return JSON.stringify({
    from: email.from,
    to: [email.to],
    reply_to: email.replyTo,
    subject: email.subject,
    text: email.text,
  });
}

/**
 * Send one email through Resend. One request, no retry — retrying is the
 * caller's (a job's) policy. No answer at all (DNS, connection, `signal`)
 * throws fetch's own error; an answer is always a {@link ResendSendResult}.
 */
export async function sendEmail(
  apiKey: string,
  email: ResendEmail,
  opts: { signal?: AbortSignal } = {},
): Promise<ResendSendResult> {
  const res = await fetch(RESEND_EMAILS_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: resendRequestBody(email),
    signal: opts.signal,
  });
  return parseResendResponse(res.status, await res.text());
}
