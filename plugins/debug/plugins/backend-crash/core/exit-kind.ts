import { z } from "zod";
import { formatDuration } from "@plugins/fields/plugins/duration/core";
import { CrashTailSchema } from "./kind";

// The jsonb payload of a `backend-exit` report: a backend that exited by CODE
// when nobody asked it to. Written by the GATEWAY (Go, gateway/exit_report.go
// `backendExit`) into the report outbox — a cross-language contract like
// `backend-crash`'s: gateway/testdata/backend-exit-entry.json is what the Go
// writer produces, and exit-kind.test.ts parses it with this schema. Strict: a
// field the Go writer adds must be added here too.
export const BackendExitPayloadSchema = z.strictObject({
  worktree: z.string(),
  pid: z.number().int(),
  exitCode: z.number().int(),
  /** Epoch ms the gateway spawned it. */
  startedAt: z.number(),
  /** Epoch ms the gateway saw it exit. */
  exitedAt: z.number(),
  /** Epoch ms it passed its readiness probe; null when it died booting. */
  readyAt: z.number().nullable(),
  /** Its binary's name. */
  executable: z.string(),
  /** Its last stderr lines, oldest first. */
  stderrTail: CrashTailSchema,
  /** The stderr pipe reached EOF: the tail is the end of what it wrote. */
  stderrComplete: z.boolean(),
});
export type BackendExitPayload = z.infer<typeof BackendExitPayloadSchema>;

/** `while booting, after 3.0s` or `5.0s after ready (8.0s up)`. */
export function exitPhaseOf(d: BackendExitPayload): string {
  const up = formatDuration(d.exitedAt - d.startedAt);
  return d.readyAt === null
    ? `while booting, after ${up}`
    : `${formatDuration(d.exitedAt - d.readyAt)} after ready (${up} up)`;
}

/**
 * The line of its stderr that most likely says why: the last `error:` /
 * `Error:` / `[process-crash]` line, or null.
 */
export function exitErrorLineOf(d: BackendExitPayload): string | null {
  for (let i = d.stderrTail.length - 1; i >= 0; i--) {
    const line = (d.stderrTail[i] ?? "").trim();
    if (/^(\[process-crash\]|error:|\w*Error:)/.test(line)) return line;
  }
  return null;
}

/** One line: `main exited with code 1 5.0s after ready (8.0s up)`. */
export function describeBackendExit(d: BackendExitPayload): string {
  return `${d.worktree} exited with code ${d.exitCode} ${exitPhaseOf(d)}`;
}
