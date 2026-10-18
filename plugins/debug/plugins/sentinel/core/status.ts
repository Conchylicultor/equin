import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import {
  DiskAlarmSchema,
  SentinelDownStatusSchema,
  SentinelVitalsRecordSchema,
  SentinelWatchSchema,
} from "@plugins/debug/plugins/sentinel/plugins/status-file/core";

// The machine watcher's (sentinel worker's) supervision status — what main's
// worker host knows about whether the watcher is actually running.
//
// Until 2026-09-16 the only trace of a dead watcher was one log line: the worker
// crashed at load for a day, builds kept piling onto a machine with ~70 MB free,
// and nothing on screen said the duress guard was gone. So the status is a
// value main holds, writes to a host-global file on every transition, and every
// backend serves as a live resource behind the health report's "Machine
// watcher" row. The status and the file's shapes live in the `status-file`
// leaf plugin (the build CLI reads the file too). Design:
// research/2026-09-16-global-sentinel-worker-identity-and-loud-death.md (Part 3).

/** The report kind filed once when main gives up respawning the watcher. */
export const SENTINEL_DOWN_KIND = "sentinel-down";

/**
 * The watcher's status as every backend reads it: the host-global status file,
 * plus whether the duress latch is up (and since when). The latch rides this
 * value rather than the per-tick vitals so the health row's summary — which
 * every tab computes all the time — learns of a trip without a 5 s stream.
 */
export const SentinelStatusValueSchema = z.object({
  watch: SentinelWatchSchema,
  /** The duress latch while its lease is fresh; `null` when the machine is not under duress. */
  duress: z.object({ since: z.number() }).nullable(),
  /**
   * The disk verdict from the running watcher's latest reading; `null` when
   * there is no current reading of the disk. Rides this value (re-pushed only
   * when the verdict changes) for the same reason the latch does.
   */
  disk: DiskAlarmSchema.nullable(),
});
export type SentinelStatusValue = z.infer<typeof SentinelStatusValueSchema>;

/**
 * A single small value (bounded by its schema), pushed when the status file or
 * the latch changes. No placeholder: until the first read lands the row is
 * `pending` (unknown), never a made-up "no status recorded".
 */
export const sentinelStatus = liveValue("sentinel.status", {
  schema: SentinelStatusValueSchema,
});

/**
 * The watcher's latest reading as every backend reads it from the vitals file.
 *
 * - `none` — no reading was ever written on this machine;
 * - `unreadable` — the file does not parse, with the reason;
 * - `recorded` — the reading, and `current`: whether it was written by the
 *   watcher the status file names as running now. A hot restart's old worker,
 *   or a leftover file from a main that is gone, is never shown as live.
 */
export const SentinelVitalsSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("unreadable"), reason: z.string() }),
  z.object({
    kind: z.literal("recorded"),
    vitals: SentinelVitalsRecordSchema,
    current: z.boolean(),
  }),
]);
export type SentinelVitals = z.infer<typeof SentinelVitalsSchema>;

/**
 * One small value (~500 bytes), pushed on every tick's write — subscribed only
 * by the row's glance and detail, so only while the health report is open. No
 * placeholder: until the first read lands it is `pending`, never `none`.
 */
export const sentinelVitals = liveValue("sentinel.vitals", {
  schema: SentinelVitalsSchema,
});

/** The `sentinel-down` report's payload. */
export const SentinelDownPayloadSchema = SentinelDownStatusSchema.omit({
  state: true,
});
export type SentinelDownPayload = z.infer<typeof SentinelDownPayloadSchema>;
