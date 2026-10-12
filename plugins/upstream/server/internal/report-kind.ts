import { z } from "zod";
import { ReportKind } from "@plugins/reports/server";
import type { ReportRow } from "@plugins/reports/server";
import {
  upstreamMergeInstructions,
  upstreamMergeTitle,
} from "../../shared/merge-prompt";

/** The kind string, named once and imported by whoever files one. */
export const UPSTREAM_UPDATES_KIND = "upstream-updates-available";

export const UpstreamUpdatesPayloadSchema = z.object({
  /** The remote the commits came from (`origin`, `upstream`). */
  remote: z.string(),
  /** That remote's URL, so the report says WHICH repo is ahead. */
  url: z.string(),
  /** The remote-tracking ref the count was measured against. */
  ref: z.string(),
  /** How many commits `main..<ref>` holds. Positive by construction — nothing
   * files this report when the answer is zero. */
  count: z.number().int().positive(),
  /** The newest of them, newest first; bounded by the reader, not by `count`. */
  newest: z.array(z.object({ sha: z.string(), subject: z.string() })),
});

export type UpstreamUpdatesPayload = z.infer<
  typeof UpstreamUpdatesPayloadSchema
>;

/**
 * The `upstream-updates-available` report kind: **the repo this checkout was
 * cloned from has commits you do not have.**
 *
 * It exists because a clone user has no other way to learn that. Everything
 * else in this app is local — worktrees branch off local `main`, main rebuilds
 * itself when that ref moves — so upstream could move for months in silence.
 *
 * **It files no task.** An update is not a failure and not an emergency; it is
 * news. Reports already mint an investigation task on demand, so the user gets
 * a row in the bell and an Investigate button, and the merge happens when they
 * decide it does. `renderTask` below is what that button hands the agent. (The
 * Upstream merges automation, when on, files the task itself.)
 *
 * Variant `info` for the same reason: nothing is broken.
 *
 * ### One row, forever
 *
 * The fingerprint is a CONSTANT. "You are behind upstream" is one standing
 * fact whose count rises, not a new problem per commit — and a fingerprint
 * derived from the newest sha would mint a fresh row and a fresh alert every
 * time upstream moves, which is exactly the cross-fingerprint fan-out the
 * reports ceiling exists to collapse (see `plugins/reports/CLAUDE.md`). So
 * every detection lands on the same row, and the upsert refreshes its payload:
 * the row always names today's count and today's newest commits.
 *
 * Read the row's own `count` column as "how many days running this has been
 * true", NOT as a number of commits — the commit count lives in the payload.
 *
 * The cooldown is a week. Without one the bell row would be read once and never
 * resurface, and a user who ignores a five-commit gap should hear about it
 * again when it is a hundred; with the job running daily, a week means the
 * standing fact re-rings occasionally rather than every morning.
 */
export const upstreamUpdatesKind = ReportKind({
  kind: UPSTREAM_UPDATES_KIND,
  schema: UpstreamUpdatesPayloadSchema,
  fingerprint: () => UPSTREAM_UPDATES_KIND,
  meta: {
    tag: "[upstream]",
    notif: "Updates available from upstream",
    variant: "info",
    // Seven days. The detection runs daily, so this re-arms the bell about once
    // a week: often enough that a growing gap comes back, rare enough that it
    // is never noise.
    notifCooldownMs: 7 * 24 * 60 * 60 * 1000,
  },
  renderTask: (row: ReportRow) => {
    const d = UpstreamUpdatesPayloadSchema.parse(row.data);
    return {
      title: upstreamUpdatesTitle(d),
      description: upstreamMergeInstructions(d),
    };
  },
});

/** The one-line summary, also used as the report's `message`. */
export function upstreamUpdatesTitle(d: UpstreamUpdatesPayload): string {
  return upstreamMergeTitle(d);
}
