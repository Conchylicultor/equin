import { z } from "zod";

/**
 * The installer's event stream, protocol v1 — what install.sh writes, one JSON
 * object per line, on the file descriptor it is handed (`--events-fd`), and
 * what every renderer (the installer window's page, later the terminal view)
 * draws. install.sh writes it by hand (its `ev` function); this schema is the
 * one definition, and the `--dry-run` stream test holds the bash emitter to it.
 *
 * Messages live in the events: every user-facing string (a step's label, a
 * log line) is produced by the step engine, never by a renderer.
 *
 * Design: research/2026-11-17-global-installer-window.md §1. This is the
 * spike's subset (plan, step, log, done, exit); progress, action, wait,
 * notice and pause come with the later tasks.
 */

/** The protocol's major version; a renderer refuses any other. */
export const INSTALL_PROTOCOL_VERSION = 1;

/**
 * install.sh's top-level steps, in run order — a closed set, so a renderer
 * and the script cannot disagree on what a step id means.
 */
const INSTALL_STEP_IDS = [
  "tools",
  "mise",
  "clone",
  "toolchain",
  "start",
  "build",
] as const;
export const InstallStepId = z.enum(INSTALL_STEP_IDS);
export type InstallStepId = z.infer<typeof InstallStepId>;

/** How the stream is being drawn. */
export const InstallMode = z.enum(["window", "interactive", "plain"]);
export type InstallMode = z.infer<typeof InstallMode>;

const base = {
  v: z.literal(INSTALL_PROTOCOL_VERSION),
  /** When the event was written: an ISO-8601 UTC instant. */
  t: z.iso.datetime(),
};

export const PlanStep = z.strictObject({
  id: InstallStepId,
  /** What the step does, in the user's words (the installer message rules). */
  label: z.string().min(1),
  /** Its median duration on a clean install, or null when none is measured yet — never a guess. */
  est_s: z.number().nonnegative().nullable(),
  optional: z.boolean().optional(),
});
export type PlanStep = z.infer<typeof PlanStep>;

export const InstallEvent = z.discriminatedUnion("type", [
  /** First event: what will run. Steps already done follow as `step skipped`. */
  z.strictObject({
    ...base,
    type: z.literal("plan"),
    /** The release being installed, or null for a checkout / main's tip. */
    release: z.string().nullable(),
    /** `<os>-<arch>`, lower case (`darwin-arm64`, `linux-x86_64`). */
    platform: z.string().min(1),
    mode: InstallMode,
    steps: z.array(PlanStep).min(1),
  }),
  z.strictObject({
    ...base,
    type: z.literal("step"),
    id: InstallStepId,
    state: z.enum(["start", "done", "skipped", "failed"]),
    /** How long the step ran (done / failed). */
    ms: z.number().int().nonnegative().optional(),
  }),
  /** One line of output: a step's child output, or the script's own (step null). */
  z.strictObject({
    ...base,
    type: z.literal("log"),
    step: InstallStepId.nullable(),
    stream: z.enum(["out", "err"]),
    line: z.string(),
  }),
  /** The install finished: equin is running at `url`. */
  z.strictObject({
    ...base,
    type: z.literal("done"),
    url: z.url(),
    ms: z.number().int().nonnegative(),
  }),
  /** Last event: the script's exit status. */
  z.strictObject({
    ...base,
    type: z.literal("exit"),
    code: z.number().int(),
  }),
]);
export type InstallEvent = z.infer<typeof InstallEvent>;

/**
 * One line of the stream, parsed: the event, or why the line is not one —
 * a renderer shows a protocol error loudly rather than skipping the line.
 */
export function parseInstallEventLine(
  line: string,
): { ok: true; event: InstallEvent } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return { ok: false, error: `not JSON: ${err.message}` };
  }
  const parsed = InstallEvent.safeParse(json);
  if (!parsed.success)
    return { ok: false, error: z.prettifyError(parsed.error) };
  return { ok: true, event: parsed.data };
}
