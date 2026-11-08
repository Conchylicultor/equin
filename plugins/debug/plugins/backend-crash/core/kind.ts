import { z } from "zod";
import { formatDuration } from "@plugins/fields/plugins/duration/core";

/**
 * How many stderr lines the gateway keeps of a dead process (gateway
 * `crashTailLines`): Bun's crash block is ~20 lines, plus what it said before.
 */
export const CRASH_TAIL_LINES = 60;

/**
 * The longest tail line, in UTF-8 bytes, before the gateway cuts it (gateway
 * `crashLineMaxBytes`, plus its ` …[cut]` suffix). A JS string's length never
 * exceeds its UTF-8 byte count, so it bounds `.length` too.
 */
export const CRASH_LINE_MAX_BYTES = 4096;
const CUT_SUFFIX_BYTES = 9;

// The jsonb payload of a `backend-crash` report. Written by the GATEWAY (Go,
// gateway/crash_report.go `backendCrash`) into the report outbox, so this
// schema is a cross-language contract: gateway/testdata/backend-crash-entry.json
// is what the Go writer produces, and kind.test.ts parses it with this schema.
// The row's own `worktree` column is main's (main drains the outbox), so the
// dead backend's worktree lives here and in the fingerprint.
// Strict: a field the Go writer adds must be added here too (kind.test.ts
// parses the golden), never silently dropped.
export const BackendCrashPayloadSchema = z.strictObject({
  worktree: z.string(),
  pid: z.number().int(),
  /** The signal's name, e.g. `SIGSEGV`. */
  signal: z.string(),
  signalNumber: z.number().int(),
  coreDumped: z.boolean(),
  /** Epoch ms the gateway spawned it. */
  startedAt: z.number(),
  /** Epoch ms the gateway saw it die. */
  exitedAt: z.number(),
  /** Its binary's name — what macOS names its crash report by. */
  executable: z.string(),
  /** Its last stderr lines, oldest first. */
  stderrTail: z
    .array(z.string().max(CRASH_LINE_MAX_BYTES + CUT_SUFFIX_BYTES))
    .max(CRASH_TAIL_LINES),
  /** The stderr pipe reached EOF: the tail is the end of what it wrote. */
  stderrComplete: z.boolean(),
});
export type BackendCrashPayload = z.infer<typeof BackendCrashPayloadSchema>;

/** What Bun's crash handler printed, read off the tail. */
export interface BunPanic {
  /** `panic: Segmentation fault at address 0x28`, or null. */
  panic: string | null;
  /** The `https://bun.report/…` link that encodes the stack, or null. */
  reportUrl: string | null;
}

export function bunPanicOf(d: BackendCrashPayload): BunPanic {
  let panic: string | null = null;
  let reportUrl: string | null = null;
  for (const raw of d.stderrTail) {
    const line = raw.trim();
    if (panic === null && line.startsWith("panic:")) panic = line;
    const url = /https:\/\/bun\.report\/\S+/.exec(line);
    if (url) reportUrl = url[0];
  }
  return { panic, reportUrl };
}

/** How long the process ran. */
export function uptimeOf(d: BackendCrashPayload): string {
  return formatDuration(d.exitedAt - d.startedAt);
}

/** One line: `main died by SIGSEGV after 1h 04m — panic: …`. */
export function describeBackendCrash(d: BackendCrashPayload): string {
  const { panic } = bunPanicOf(d);
  const head = `${d.worktree} died by ${d.signal} after ${uptimeOf(d)}`;
  return panic === null ? head : `${head} — ${panic}`;
}

/**
 * Where macOS's ReportCrash writes the symbolized crash report of a process
 * named `executable` (darwin): `<dir>/<executable>-<YYYY-MM-DD-HHMMSS>.ips`,
 * stamped with the local time of the crash, moved to `Retired/` once it has
 * been read. Unlike bun.report — which decodes only frames in Bun's own binary
 * and prints every other one (a native addon, JIT code) as unknown — it names
 * the image and symbol of every frame of every thread.
 */
export function macCrashReportGlob(d: BackendCrashPayload): string {
  return `~/Library/Logs/DiagnosticReports{,/Retired}/${d.executable}-*.ips`;
}
