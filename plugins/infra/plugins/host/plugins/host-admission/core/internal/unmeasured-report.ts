import { z } from "zod";

/**
 * The report kind string, spelled once: `reports/fleet-memory-unmeasured`
 * registers its `ReportKind` under it and the grant acquire files under it.
 * The kind's data lives here, its registration there: host-admission sits
 * below `reports` (which reaches it through config and live state), so it
 * may name the kind but never import the reports engine.
 */
export const FLEET_MEMORY_UNMEASURED_KIND = "fleet-memory-unmeasured";

/**
 * One `cpu` grant acquire that found nothing measuring the machine: why, what
 * it was admitted on instead, and who it was.
 */
export const FleetMemoryUnmeasuredPayloadSchema = z.object({
  /** `absent`: no reading was ever written; `stale`: the last one is past its lease. */
  cause: z.enum(["absent", "stale"]),
  /** How old the last reading was (`stale`), or null (`absent`). */
  ageMs: z.number().nullable(),
  /** The window admitted on meanwhile (host-admission's `unmeasuredWindow`). */
  slots: z.number().int(),
  /** The acquiring lane. */
  lane: z.enum(["interactive", "background"]),
  pid: z.number().int(),
  /** The process's command line, abridged — which build / check / test acquired. */
  command: z.string(),
});
export type FleetMemoryUnmeasuredPayload = z.infer<
  typeof FleetMemoryUnmeasuredPayloadSchema
>;

/** One row per cause: each unmeasured acquire bumps its count. */
export function fleetMemoryUnmeasuredFingerprint(
  d: FleetMemoryUnmeasuredPayload,
): string {
  return `${FLEET_MEMORY_UNMEASURED_KIND}:${d.cause}`;
}

/** The one-line summary — the report row's `message` and the acquire's own log line. */
export function fleetMemoryUnmeasuredMessage(
  d: Pick<FleetMemoryUnmeasuredPayload, "cause" | "ageMs" | "slots">,
): string {
  const why =
    d.cause === "absent"
      ? "no fleet memory reading was ever written"
      : `the fleet memory reading is ${Math.round((d.ageMs ?? 0) / 1000)} s old`;
  return (
    `cpu grant admission is unmeasured (${why}: main's owner sampler is not running) — ` +
    `admitting on the ${d.slots}-slot floor until a reading lands`
  );
}
