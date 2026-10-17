// The one hold model every updater shares: a release not to land yet, always
// with a reason and always with an expiry. Each updater keeps its holds where
// its inputs are declared (npm: the package.json `dependencyPolicy`, mise:
// `plugins/toolchain/core`, uv: its `core/`) and exposes them through
// `Updater.holds.read`; the bound, the matching and the expiry live here.

import { z } from "zod";
import type { OutdatedWaiting, Updater } from "./updater";

/** The longest a hold may be set for, from the day it is set or renewed. */
export const HOLD_MAX_DAYS = 90;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Releases of `names` not to land yet: one broken `version`, or everything
 * from `below` up. Always bounded: `until` is a day at most
 * {@link HOLD_MAX_DAYS} out when the hold is set (each updater's check, and
 * the runner before it plans), and the day after it the hold goes inert — the
 * updater proposes the move again and the gates decide. Keeping it longer is a
 * renewal: a new `until` and reason, in a reviewed diff.
 */
export const HoldSchema = z
  .object({
    names: z.array(z.string().min(1)).min(1),
    version: z.string().min(1).optional(),
    below: z.string().min(1).optional(),
    reason: z.string().min(1),
    /** Upstream issue or report URL, when the cause is upstream. */
    issue: z.string().url().optional(),
    until: z.string().regex(DAY, "a YYYY-MM-DD day"),
  })
  .strict()
  .refine((h) => (h.version === undefined) !== (h.below === undefined), {
    message: "a hold names exactly one of `version` or `below`",
  });
export type Hold = z.infer<typeof HoldSchema>;

/** `YYYY-MM-DD` of `now`, UTC — the day a hold's `until` is compared with. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Whether `hold` is honoured on `today`: through its `until` day, inclusive. */
export function holdActive(hold: Hold, today: string): boolean {
  return hold.until >= today;
}

/** The latest `until` a hold set or renewed on `today` may carry. */
export function latestUntil(today: string): string {
  const t = Date.parse(`${today}T00:00:00Z`) + HOLD_MAX_DAYS * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * The hold honoured on `today` that covers `name` at `version`, if any.
 * `compare` is the updater's own version order (negative when `a` is older),
 * which a `below` hold is measured with.
 */
export function heldBy(
  holds: readonly Hold[],
  name: string,
  version: string,
  today: string,
  compare: (a: string, b: string) => number,
): Hold | undefined {
  return holds.find(
    (h) =>
      holdActive(h, today) &&
      h.names.includes(name) &&
      (h.below === undefined
        ? h.version === version
        : compare(version, h.below) >= 0),
  );
}

/** What a held row reports: the hold's reason and the day it lapses. */
export function heldWaiting(hold: Hold): OutdatedWaiting {
  return { kind: "held", reason: hold.reason, until: hold.until };
}

/**
 * Every hold in `holds` set beyond {@link latestUntil} of `today`, as a
 * message naming `where` it is declared. Empty when all are bounded.
 */
export function holdProblems(
  holds: readonly Hold[],
  today: string,
  where: string,
): string[] {
  const bound = latestUntil(today);
  return holds
    .filter((h) => h.until > bound)
    .map(
      (h) =>
        `${where}: the hold on ${h.names.join(", ")} lasts until ${h.until}, past ${bound} — a hold is set for at most ${HOLD_MAX_DAYS} days; renew it when it lapses`,
    );
}

/**
 * Throw, naming every offender, when one of `updater`'s holds was set past its
 * bound. The runner and the detect job call it before asking the updater
 * anything, so an updater's holds are bounded whether or not a check of its
 * own reads them.
 */
export async function assertHoldsBounded(
  updater: Updater,
  root: string,
  now: Date,
): Promise<void> {
  const problems = holdProblems(
    await updater.holds.read(root),
    utcDay(now),
    updater.holds.file,
  );
  if (problems.length > 0)
    throw new Error(
      `${updater.id}: a hold is set past its ${HOLD_MAX_DAYS}-day bound:\n  ${problems.join("\n  ")}`,
    );
}
