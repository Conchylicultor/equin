import { z } from "zod";
import { formatDuration } from "@plugins/fields/plugins/duration/core";
import {
  CrashLineSchema,
  CrashTailSchema,
} from "@plugins/debug/plugins/backend-crash/core";

// The jsonb payload of a `service-down` report. Written by the GATEWAY (Go,
// gateway/service_report.go `serviceDown`) into the report outbox, so this
// schema is a cross-language contract: gateway/testdata/service-down-entry.json
// is what the Go writer produces, and kind.test.ts parses it with this schema.
// Strict: a field the Go writer adds must be added here too.
export const ServiceDownPayloadSchema = z.strictObject({
  /** The service's name in the supervisor's config (`postgres`, `pgbouncer`). */
  service: z.string(),
  /** What the watchdog dials, e.g. `unix /…/.s.PGSQL.5433`. */
  probe: z.string(),
  /** Why the probe failed: the dial's own error. */
  probeError: z.string(),
  /** Epoch ms the service last became running; null when never seen running. */
  upSince: z.number().nullable(),
  /** Epoch ms the probe failed. */
  detectedAt: z.number(),
  /** `recovered`: re-started and answering again; `crashed`: left down, unwatched. */
  outcome: z.enum(["recovered", "crashed"]),
  /** Epoch ms it answered again, or was marked crashed. */
  settledAt: z.number(),
  /** Why the re-start failed (one bounded line); null when it recovered. */
  restartError: CrashLineSchema.nullable(),
  /** The start command's output lines: did it start the daemon, or reattach? */
  restartOutput: CrashTailSchema,
  /** The service's own log channel. */
  logPath: z.string(),
  /** Its last lines as of the detection, oldest first. */
  logTail: CrashTailSchema,
  /** Why the log could not be read (logTail is then empty); null when read. */
  logTailError: z.string().nullable(),
});
export type ServiceDownPayload = z.infer<typeof ServiceDownPayloadSchema>;

/** How long it had been up when it stopped answering, or null when unknown. */
export function upTimeOf(d: ServiceDownPayload): string | null {
  return d.upSince === null ? null : formatDuration(d.detectedAt - d.upSince);
}

/** How long the outage lasted until it settled. */
export function outageOf(d: ServiceDownPayload): string {
  return formatDuration(d.settledAt - d.detectedAt);
}

/** One line: `postgres stopped answering after 3h 02m up; back after 4.2s`. */
export function describeServiceDown(d: ServiceDownPayload): string {
  const up = upTimeOf(d);
  const head = `${d.service} stopped answering${up === null ? "" : ` after ${up} up`}`;
  return d.outcome === "recovered"
    ? `${head}; re-started, back after ${outageOf(d)}`
    : `${head}; re-start failed, left down`;
}
