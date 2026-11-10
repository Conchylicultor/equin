import { z } from "zod";
import {
  CrashLineSchema,
  CrashTailSchema,
} from "@plugins/debug/plugins/backend-crash/core";

// The jsonb payload of a `main-deploy-failed` report. Written by the GATEWAY
// (Go, gateway/main_deploy.go `mainDeployFailed`) into the report outbox when
// main's convergence run (`./equin build --allow-main --converge`) itself
// fails — so this schema is a cross-language contract:
// gateway/testdata/main-deploy-failed-entry.json is what the Go writer
// produces, and kind.test.ts parses it with this schema. Strict: a field the Go
// writer adds must be added here too.
export const MainDeployFailedPayloadSchema = z.strictObject({
  /** The run's exit status; `null` when a signal ended it. */
  exitCode: z.number().int().nullable(),
  /** The signal that ended it (`SIGKILL`), `null` for an exit. */
  signal: z.string().nullable(),
  /** The run could not be started at all (exec failed); then no exit status. */
  spawnError: CrashLineSchema.nullable(),
  /** The edges that started this run, oldest first (`ref advanced`, `gateway boot`, …). */
  causes: z.array(CrashLineSchema).max(16),
  /** The last lines the run printed, oldest first. */
  tail: CrashTailSchema,
  /** Main's checkout the run ran in, and the log it printed to. */
  checkout: z.string(),
  log: z.string(),
  /** Epoch ms. */
  startedAt: z.number(),
  endedAt: z.number(),
});
export type MainDeployFailedPayload = z.infer<
  typeof MainDeployFailedPayloadSchema
>;

/** One line: `main's deploy run failed (exit 1) — started by ref advanced`. */
export function describeMainDeployFailed(d: MainDeployFailedPayload): string {
  const how =
    d.spawnError !== null
      ? "could not start"
      : d.signal !== null
        ? `was killed (${d.signal})`
        : `failed (exit ${d.exitCode})`;
  const cause =
    d.causes.length > 0 ? ` — started by ${d.causes.join(", ")}` : "";
  return `main's deploy run ${how}${cause}`;
}
