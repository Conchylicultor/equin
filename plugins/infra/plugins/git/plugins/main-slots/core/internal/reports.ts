import { z } from "zod";
import { SLOT_HOLDER_KINDS } from "@plugins/infra/plugins/git/plugins/main-slots/plugins/boot-lease/core";

const HolderSchema = z.object({
  pid: z.number().int(),
  kind: z.enum(SLOT_HOLDER_KINDS),
  mode: z.enum(["shared", "exclusive"]),
  acquiredAt: z.string(),
  label: z.string().nullable(),
});

/**
 * The report kind a build files when it found no free slot and as many
 * slots draining as the leak limit allows: it waits for the oldest draining
 * one instead of making another — draining slots piling up mean processes
 * outlive their apps' switches (a leak, not a busy pool).
 */
export const SLOTS_EXHAUSTED_REPORT_KIND = "main-slots-exhausted";

/** Its payload: every draining slot with its live holders as found. */
export const SlotsExhaustedPayloadSchema = z.object({
  /** The leak limit: the most draining slots a build makes room beside. */
  limit: z.number().int().positive(),
  /** The slot the build then waited on (the oldest draining one). */
  waitedOn: z.string(),
  /**
   * How long the build had been waiting when this was filed: 0 when it
   * started to, then again every ~10 min while it still waits
   * (`EXHAUSTED_REFILE_MS`) — a stalled main deploy stays visible.
   */
  waitingMs: z.number().nonnegative(),
  slots: z.array(
    z.object({
      slot: z.string(),
      /** When it stopped serving (`null`: not stamped yet). */
      unservedAt: z.string().nullable(),
      holders: z.array(HolderSchema),
    }),
  ),
});
export type SlotsExhaustedPayload = z.infer<typeof SlotsExhaustedPayloadSchema>;

/**
 * The report kind filed per holder that kept a slot past its switch by more
 * than the drain threshold (`main-slots` config `drainReportAfterSec`) —
 * captured at release (a drain record), or found still holding at reclaim.
 * Fingerprinted by (kind, label): one row per job, its occurrences counted.
 */
export const DRAIN_SLOW_REPORT_KIND = "main-slot-drain-slow";

export const DrainSlowPayloadSchema = z.object({
  kind: z.enum(SLOT_HOLDER_KINDS),
  label: z.string().nullable(),
  pid: z.number().int(),
  heldPastSwitchMs: z.number(),
  thresholdMs: z.number(),
  slot: z.string(),
  commit: z.string().nullable(),
  /** `true`: found still holding at reclaim; `false`: released that late. */
  stillHolding: z.boolean(),
});
export type DrainSlowPayload = z.infer<typeof DrainSlowPayloadSchema>;

/** One row per (holder kind, label): the job to make faster, or stop outliving its app. */
export function drainSlowFingerprint(
  d: Pick<DrainSlowPayload, "kind" | "label">,
): string {
  return `${DRAIN_SLOW_REPORT_KIND}:${d.kind}:${d.label ?? "-"}`;
}

/** The one-line message a drain-slow report carries. */
export function drainSlowMessage(d: DrainSlowPayload): string {
  const who = `${d.kind}${d.label === null ? "" : ` ${d.label}`} (pid ${d.pid})`;
  const s = Math.round(d.heldPastSwitchMs / 1000);
  return d.stillHolding
    ? `${who} still holds main slot ${d.slot} ${s} s after its app switched away`
    : `${who} held main slot ${d.slot} ${s} s after its app switched away`;
}
