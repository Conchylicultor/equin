// The one hold model every updater shares: a release not to land yet, always
// with a reason and always with a review deadline. Each updater keeps its holds
// where its inputs are declared (npm: the package.json `dependencyPolicy`, mise:
// `plugins/toolchain/core`, uv: its `core/`) and exposes them through
// `Updater.holds.read`; the bound, the matching and the review state live here.
//
// A hold is never released by the calendar: it blocks its releases until a
// diff deletes it. Its `reviewBy` is when someone must look again — past it the
// hold is LAPSED, and the upgrade cannot finish until every lapsed hold is
// lifted or renewed (research/2026-10-17-global-deps-bounded-holds-every-updater-v2.md).

import { z } from "zod";
import type { OutdatedWaiting, Updater } from "./updater";

/** The longest a hold may go unreviewed, from the day it is set or renewed. */
export const HOLD_MAX_DAYS = 90;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Releases of `names` not to land: one broken `version`, or everything from
 * `below` up. Honoured until a diff deletes it. `reviewBy` is a day at most
 * {@link HOLD_MAX_DAYS} out when the hold is set or renewed (each updater's
 * check, and the runner before it plans); once it passes the hold is lapsed
 * and the next upgrade must review it — lift it, or renew it with a new
 * `reviewBy` and a reason saying what was checked.
 */
export const HoldSchema = z
  .object({
    names: z.array(z.string().min(1)).min(1),
    version: z.string().min(1).optional(),
    below: z.string().min(1).optional(),
    reason: z.string().min(1),
    /** Upstream issue or report URL, when the cause is upstream. */
    issue: z.string().url().optional(),
    reviewBy: z.string().regex(DAY, "a YYYY-MM-DD day"),
  })
  .strict()
  .refine((h) => (h.version === undefined) !== (h.below === undefined), {
    message: "a hold names exactly one of `version` or `below`",
  });
export type Hold = z.infer<typeof HoldSchema>;

/** `YYYY-MM-DD` of `now`, UTC — the day a hold's `reviewBy` is compared with. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** `active` through its `reviewBy` day, inclusive; `lapsed` after it. */
export type HoldState = "active" | "lapsed";

export function holdState(hold: Hold, today: string): HoldState {
  return hold.reviewBy >= today ? "active" : "lapsed";
}

/** The holds whose review is overdue on `today`. */
export function lapsedHolds(holds: readonly Hold[], today: string): Hold[] {
  return holds.filter((h) => holdState(h, today) === "lapsed");
}

/** The latest `reviewBy` a hold set or renewed on `today` may carry. */
export function latestReviewBy(today: string): string {
  const t = Date.parse(`${today}T00:00:00Z`) + HOLD_MAX_DAYS * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * The hold covering `name` at `version`, if any — lapsed or not: only deleting
 * a hold releases what it holds. `compare` is the updater's own version order
 * (negative when `a` is older), which a `below` hold is measured with.
 */
export function heldBy(
  holds: readonly Hold[],
  name: string,
  version: string,
  compare: (a: string, b: string) => number,
): Hold | undefined {
  return holds.find(
    (h) =>
      h.names.includes(name) &&
      (h.below === undefined
        ? h.version === version
        : compare(version, h.below) >= 0),
  );
}

/** What a held row reports: the hold's reason, its review day, and whether that has passed. */
export function heldWaiting(
  hold: Hold,
  today: string,
): Extract<OutdatedWaiting, { kind: "held" }> {
  return {
    kind: "held",
    reason: hold.reason,
    reviewBy: hold.reviewBy,
    lapsed: holdState(hold, today) === "lapsed",
  };
}

/** One hold as a line of text: what it holds, why, and its review day. */
export function describeHold(hold: Hold): string {
  const what =
    hold.version !== undefined
      ? `${hold.names.join(", ")} ${hold.version}`
      : `${hold.names.join(", ")} ${hold.below} and up`;
  return `${what} (review by ${hold.reviewBy}): ${hold.reason}${hold.issue === undefined ? "" : ` — ${hold.issue}`}`;
}

/**
 * Every hold in `holds` set beyond {@link latestReviewBy} of `today`, as a
 * message naming `where` it is declared. Empty when all are bounded. A lapsed
 * hold is not a problem here — reviewing it is the upgrade's work, never a
 * reason to fail an unrelated push.
 */
export function holdProblems(
  holds: readonly Hold[],
  today: string,
  where: string,
): string[] {
  const bound = latestReviewBy(today);
  return holds
    .filter((h) => h.reviewBy > bound)
    .map(
      (h) =>
        `${where}: the hold on ${h.names.join(", ")} is next reviewed ${h.reviewBy}, past ${bound} — a hold goes at most ${HOLD_MAX_DAYS} days unreviewed`,
    );
}

/**
 * `updater`'s lapsed holds on `now`'s day, after refusing (throwing, naming
 * every offender) any hold set past its bound. The runner and the detect job
 * call it before asking the updater anything, so every updater's holds are
 * bounded and reviewed whether or not a check of its own reads them.
 */
export async function reviewableHolds(
  updater: Updater,
  root: string,
  now: Date,
): Promise<Hold[]> {
  const holds = await updater.holds.read(root);
  const today = utcDay(now);
  const problems = holdProblems(holds, today, updater.holds.file);
  if (problems.length > 0)
    throw new Error(
      `${updater.id}: a hold is set past its ${HOLD_MAX_DAYS}-day bound:\n  ${problems.join("\n  ")}`,
    );
  return lapsedHolds(holds, today);
}
