import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";

/**
 * The harness injects a `total_tokens_reminder` attachment repeatedly through a
 * session, each carrying one number wrapped in prose:
 * `<total_tokens>15000000 tokens left</total_tokens>`.
 *
 * That number is a **work allowance handed to the agent**, not a measurement of
 * the conversation: the harness writes it into the model's own prompt so the
 * model can judge how much room it has, re-anchors it to the full value at the
 * start of every user request, and pads it far above what any real request
 * spends. Read as "left" it is therefore a constant — the readings sit within a
 * fraction of a percent of the ceiling, and every new request puts them back on
 * it.
 *
 * What the series does carry is the harness's own charge accounting, which
 * counts work no other row in the transcript can account for (a subagent's or a
 * workflow's output is charged here but recorded in its own transcript). So
 * this folds the whole series into the one reading that moves: the total
 * charged, summed across the re-anchors.
 *
 * As transcript ROWS the reminders are pure noise — dozens of near-identical
 * lines whose number barely moves — so the plugin hides them too.
 */

export const TOTAL_TOKENS_SUBTYPE = "total_tokens_reminder";

/** A parsed reminder payload: either the number, or the text we could not read. */
export type ParsedBudget =
  { ok: true; remaining: number } | { ok: false; raw: string };

// Tolerates thousands separators and stray whitespace so a cosmetic change to
// the harness's wording degrades to "no reading" rather than a wrong number.
const REMAINING_RE =
  /<total_tokens>\s*([\d,_ ]*\d)\s*tokens left\s*<\/total_tokens>/i;

export function parseBudgetText(text: string): ParsedBudget {
  const match = REMAINING_RE.exec(text);
  if (!match?.[1]) return { ok: false, raw: text };
  const remaining = Number(match[1].replace(/[,_ ]/g, ""));
  if (!Number.isFinite(remaining)) return { ok: false, raw: text };
  return { ok: true, remaining };
}

/** Read a reminder attachment (typed `unknown` on the event) into a budget. */
export function parseBudgetAttachment(attachment: unknown): ParsedBudget {
  if (typeof attachment !== "object" || attachment === null) {
    return { ok: false, raw: String(attachment) };
  }
  const text = (attachment as { text?: unknown }).text;
  if (typeof text !== "string") return { ok: false, raw: String(attachment) };
  return parseBudgetText(text);
}

type AttachmentEvent = Extract<JsonlEvent, { kind: "attachment" }>;

export function isTotalTokensReminder(
  event: JsonlEvent,
): event is AttachmentEvent {
  return event.kind === "attachment" && event.subtype === TOTAL_TOKENS_SUBTYPE;
}

export interface BudgetStatus {
  /**
   * Everything charged against the allowance across this stretch: the sum of
   * the DROPS between consecutive readings, never `first - last`. The harness
   * re-anchors the allowance in full on each new request, so `first - last`
   * would forget every request but the one in progress — and read as zero the
   * moment a request has only just started.
   */
  spent: number;
  /** The part of `spent` charged since the last re-anchor. */
  spentThisRequest: number;
  /**
   * How many requests this stretch covers: the opening reading, plus one for
   * each re-anchor after it.
   */
  requests: number;
  /**
   * The allowance a request starts from: the largest reading seen. Derived
   * rather than assumed, because the harness never states the ceiling except by
   * handing it out — and a transcript can start mid-request, where the largest
   * reading is all there is to go on.
   */
  allowance: number;
}

/**
 * Fold every budget reminder in this stretch of transcript into one reading.
 * `null` when the stretch holds no readable reminder — nothing to report yet,
 * which the stat renders as nothing at all.
 */
export function readBudget(events: JsonlEvent[]): BudgetStatus | null {
  let previous: number | null = null;
  let allowance = 0;
  let spent = 0;
  let spentThisRequest = 0;
  let requests = 0;

  for (const event of events) {
    if (!isTotalTokensReminder(event)) continue;
    const parsed = parseBudgetAttachment(event.attachment);
    if (!parsed.ok) continue;

    if (previous === null) {
      requests = 1;
    } else if (parsed.remaining > previous) {
      // Back up: the allowance was re-anchored, which the harness does at the
      // start of a user request and nowhere else. A new request has spent
      // nothing yet, but the conversation's total keeps everything before it.
      requests += 1;
      spentThisRequest = 0;
    } else {
      const drop = previous - parsed.remaining;
      spent += drop;
      spentThisRequest += drop;
    }

    previous = parsed.remaining;
    if (parsed.remaining > allowance) allowance = parsed.remaining;
  }

  if (previous === null) return null;
  return { spent, spentThisRequest, requests, allowance };
}
