import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import {
  MailAttachmentSchema,
  mailAccountIdKind,
} from "@plugins/apps/plugins/mail/plugins/mail-core/core";

/**
 * Where one message's body stands in the local mirror:
 * - `fetching` — an envelope-only stub whose full body is being fetched from
 *   Gmail (a subscriber asked for it; the `mail.hydrate` job is filling it);
 * - `failed` — the last fetch failed, with why (Gmail refused, the connection
 *   is broken, …); a new subscriber or Retry asks again;
 * - `ready` — the body and its attachments, cached for good.
 *
 * Never an empty body standing in for one not fetched yet: "not fetched" is
 * its own state.
 */
export const MailMessageBodySchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("fetching") }),
  z.object({ state: z.literal("failed"), error: z.string() }),
  z.object({
    state: z.literal("ready"),
    bodyText: z.string().nullable(),
    bodyHtml: z.string().nullable(),
    attachments: z.array(MailAttachmentSchema),
  }),
]);
export type MailMessageBody = z.infer<typeof MailMessageBodySchema>;

/**
 * One message's body, read straight from the mirror (a `db` value with a pure
 * read loader). Subscribing to a message whose body is not cached yet asks the
 * `mail.hydrate` job to fetch it (the write); the job's write — the body, or
 * the failure — recomputes this value through the change feed. A message
 * outside the mirror is refused `missing`.
 */
export const mailMessageBody = liveValue("mail.message-body", {
  schema: MailMessageBodySchema,
  params: ["messageId"],
  refusals: ["missing"],
});

/** Thread ids a search page holds; `maxLimit` is the most a reader without a viewport keeps. */
const SEARCH_PAGE = 50;
const SEARCH_MAX = 300;

/**
 * The longest search a question carries: `LIVE_QUERY_MAX_BYTES` (2 KiB) bounds
 * the encoded question, and 400 characters stay under it even at 4 bytes per
 * character beside the account id.
 */
export const MAIL_SEARCH_MAX_CHARS = 400;

export const MailSearchQuerySchema = z.object({
  /** A Gmail search (`messages.list?q=`), already trimmed — never empty. */
  q: z.string().min(1).max(MAIL_SEARCH_MAX_CHARS),
  /**
   * The connected account the matches are mirrored under — the `mailAccount`
   * value's id, stated by the reader as the threads list states its scope.
   */
  accountId: z
    .string()
    .refine((id) => mailAccountIdKind.is(id), "not a mail account id"),
  /**
   * The search round: an opaque token the reader mints for every search it
   * starts (a new query, Search again), so the same query typed twice is two
   * tuples and the second asks Gmail afresh. The server holds a round's answer
   * while its pages are read, and never past it.
   */
  round: z.string().min(1).max(64),
});
export type MailSearchQuery = z.infer<typeof MailSearchQuerySchema>;

/**
 * One thread a search matched, in Gmail's order: `rank` is its zero-padded
 * position in the answer (the order key), `messageId` the newest matched
 * message of the thread (the one the reader opens).
 */
export const MailSearchHitSchema = z.object({
  id: z.string(),
  rank: z.string(),
  messageId: z.string(),
});
export type MailSearchHit = z.infer<typeof MailSearchHitSchema>;

const MAIL_SEARCH_REFUSALS = [
  "not-connected",
  "invalid-cut",
  "expired",
] as const;
/**
 * Why a search was refused: Gmail is not connected (no usable token), a forged
 * page cut, or a later page of a round the server no longer holds (`expired` —
 * the reader starts a new round).
 */
export type MailSearchRefusal = (typeof MAIL_SEARCH_REFUSALS)[number];

/**
 * On-demand server-side search, the escape hatch for the bounded sync window:
 * Gmail's ranked answer to one query, as THREAD ids, paged by rank. The
 * server walks Gmail's `pageToken` chain as far as a page asks and mirrors the
 * envelopes it sees into Postgres, so the reader shows each hit as a live
 * `mail.threads` row (`useLive(mailThreads, { ids })`) — read/starred flags
 * stay live there. A thread matching on two Gmail pages is one hit, ranked
 * where it first appeared.
 */
export const mailSearch = liveValue("mail.search", {
  query: MailSearchQuerySchema,
  paged: {
    item: MailSearchHitSchema,
    id: "id",
    key: { of: (hit) => [hit.rank], order: ["asc"] },
    limit: SEARCH_PAGE,
    maxLimit: SEARCH_MAX,
  },
  refusals: MAIL_SEARCH_REFUSALS,
});
