import { createKeyedMutex } from "@plugins/packages/plugins/keyed-mutex/core";
import { listMessages } from "@plugins/apps/plugins/mail/plugins/gmail-api/server";
import type { GmailMessage } from "@plugins/apps/plugins/mail/plugins/gmail-api/core";
import {
  mailAccountIdKind,
  type MailAccountId,
} from "@plugins/apps/plugins/mail/plugins/mail-core/core";
import { GmailTokenUnavailableError } from "@plugins/apps/plugins/mail/plugins/mail-core/core";
import { requireGmailToken } from "@plugins/apps/plugins/mail/plugins/mail-core/server";
import {
  mailSearch,
  type MailSearchHit,
  type MailSearchQuery,
} from "../../core";
import { markMessagesWithAttachments, upsertMessageEnvelope } from "./store";
import { fetchEnvelopes } from "./fetch-envelopes";

// On-demand server-side search — the escape hatch for the bounded window. The
// backfill/delta only mirror envelopes `newer_than:${BACKFILL_WINDOW_DAYS}d`, so
// older mail simply isn't in the local mirror. A search takes an arbitrary Gmail
// query and answers Gmail's ranked THREADS (`mail.search`, `search-value.ts`),
// while FOLDING every matching envelope it sees into the same Postgres mirror via
// the idempotent `upsertMessageEnvelope` — so the reader shows each hit as a live
// `mail.threads` row. Bodies still hydrate lazily on first open.
//
// Gmail pages its answer by an opaque, forward-only `pageToken`, which has no
// position to cut a key-range page at. So each question's answer is held here,
// in Gmail's order, as far as a page has asked: a hit's `rank` is its position in
// it — a key any page can cut at. A page past the held hits walks the token chain
// further.
//
// The answer is held per ROUND, not per question: the question carries a
// `round` the reader mints for each search it starts (`MailSearchQuery`), so
// typing the same query again is a new tuple and asks Gmail afresh — the held
// answer never outlives the search that asked it (the value's `fixed`
// freshness is true per round). Bounded by `MAX_QUESTIONS` rounds (least
// recently read dropped first) and `MAX_HITS` per round. A later page whose
// round was dropped is refused `expired` rather than re-ranked: a fresh walk of
// Gmail could rank a different thread at the cut, and the reader would repeat
// or skip threads silently.

/** Messages per Gmail `messages.list` page. */
const GMAIL_PAGE = 50;
/** The most hits one question holds: its answer ends there. */
const MAX_HITS = 1000;
/** Rounds held at once; the least recently read is dropped first. */
const MAX_QUESTIONS = 32;
const RANK_DIGITS = 6;

interface SearchAnswer {
  /** Ranked, one per thread, in Gmail's order. */
  hits: MailSearchHit[];
  seen: Set<string>;
  /** Gmail's token for the next page; `null` once the answer is complete. */
  nextPageToken: string | undefined | null;
  /** Whether the first page's attachment flags were marked. */
  attachmentsMarked: boolean;
}

const answers = new Map<string, SearchAnswer>();
const growing = createKeyedMutex();

function questionKey(q: MailSearchQuery): string {
  return JSON.stringify([q.accountId, q.q, q.round]);
}

/**
 * The round's held answer. Only a first page (`after === null`) may start one:
 * a later page of a round no longer held is refused `expired`.
 */
function answerFor(key: string, after: string | null): SearchAnswer {
  const held = answers.get(key);
  if (held) {
    // Most recently read last, so the first key is the one to drop.
    answers.delete(key);
    answers.set(key, held);
    return held;
  }
  if (after !== null) {
    throw mailSearch.refuse(
      "expired",
      "These search results expired — search again.",
    );
  }
  const fresh: SearchAnswer = {
    hits: [],
    seen: new Set(),
    nextPageToken: undefined,
    attachmentsMarked: false,
  };
  answers.set(key, fresh);
  while (answers.size > MAX_QUESTIONS) {
    const oldest = answers.keys().next().value;
    if (oldest === undefined) break;
    answers.delete(oldest);
  }
  return fresh;
}

const rankOf = (index: number): string =>
  String(index).padStart(RANK_DIGITS, "0");

/** The hits a page starting after `after` needs held: through `after`, plus `limit`. */
function heldNeeded(after: string | null, limit: number): number {
  if (after === null) return limit;
  if (!/^[0-9]+$/.test(after)) {
    throw mailSearch.refuse("invalid-cut", `not a search rank: ${after}`);
  }
  return Number(after) + 1 + limit;
}

async function gmailToken(): Promise<string> {
  try {
    return (await requireGmailToken()).accessToken;
  } catch (err) {
    if (err instanceof GmailTokenUnavailableError) {
      throw mailSearch.refuse(
        "not-connected",
        "Connect Gmail to search your mailbox.",
      );
    }
    throw err;
  }
}

/** The epoch-ms a Gmail message was received, or -1 when Gmail did not say. */
const receivedAt = (m: GmailMessage): number =>
  m.internalDate === undefined ? -1 : Number(m.internalDate);

/**
 * Read Gmail's next page of `q` into `answer`: mirror every matching envelope
 * (metadata-only, 404-tolerant), then append each thread not seen yet, ranked
 * where it first appears, represented by its newest matched message of the page.
 */
async function readNextPage(
  answer: SearchAnswer,
  q: MailSearchQuery,
  accountId: MailAccountId,
): Promise<void> {
  const token = await gmailToken();
  const list = await listMessages(token, {
    q: q.q,
    pageToken: answer.nextPageToken ?? undefined,
    maxResults: GMAIL_PAGE,
  });
  const refs = list.messages ?? [];
  const ids = refs.map((m) => m.id);
  const { fetched } =
    ids.length === 0 ? { fetched: [] } : await fetchEnvelopes(token, ids);
  for (const m of fetched) {
    await upsertMessageEnvelope(accountId, m);
  }

  // Mark attachment-bearing results with Gmail's authoritative `has:attachment`
  // (matches the paperclip). One extra id-only list page for the same query,
  // intersected with the first page's ids — metadata-only, no body fetch. First
  // page only: `has:attachment`'s first page spans a far wider recency range than
  // a query page, so it reliably covers its attachment bearers; deeper pages'
  // flags fill on open (the sync CLAUDE.md's documented gap).
  if (!answer.attachmentsMarked && ids.length > 0) {
    const attachList = await listMessages(token, {
      q: `${q.q} has:attachment`,
      maxResults: 100,
    });
    const attachIds = new Set((attachList.messages ?? []).map((m) => m.id));
    await markMessagesWithAttachments(
      accountId,
      ids.filter((id) => attachIds.has(id)),
    );
  }
  answer.attachmentsMarked = true;

  // Thread order is Gmail's (first appearance in `refs`); a message that
  // 404'd never landed in the mirror, so it represents nothing.
  const byId = new Map(fetched.map((m) => [m.id, m]));
  const newest = new Map<string, GmailMessage>();
  for (const ref of refs) {
    const m = byId.get(ref.id);
    if (!m) continue;
    const held = newest.get(m.threadId);
    if (!held || receivedAt(m) > receivedAt(held)) newest.set(m.threadId, m);
  }
  for (const [threadId, m] of newest) {
    if (answer.seen.has(threadId) || answer.hits.length >= MAX_HITS) continue;
    answer.seen.add(threadId);
    answer.hits.push({
      id: threadId,
      rank: rankOf(answer.hits.length),
      messageId: m.id,
    });
  }
  answer.nextPageToken =
    answer.hits.length >= MAX_HITS ? null : (list.nextPageToken ?? null);
}

/**
 * The round's held answer to `q`, read from Gmail as far as a page needs `needed` hits
 * (or the answer ends). Growth of one question is serialized, so two pages
 * asking at once read each Gmail page once.
 */
export async function searchHits(
  q: MailSearchQuery,
  after: string | null,
  limit: number,
): Promise<readonly MailSearchHit[]> {
  const needed = heldNeeded(after, limit);
  const key = questionKey(q);
  const accountId = mailAccountIdKind.key(q.accountId);
  return growing.run(key, async () => {
    const answer = answerFor(key, after);
    while (answer.hits.length < needed && answer.nextPageToken !== null) {
      await readNextPage(answer, q, accountId);
    }
    return answer.hits;
  });
}
