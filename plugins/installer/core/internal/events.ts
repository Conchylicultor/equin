import { z } from "zod";

/**
 * The installer's event stream, protocol v1 — what the install writes, one
 * JSON object per line, and what every renderer (the installer window's page,
 * install.sh's own terminal view) draws. install.sh writes its events by hand
 * (its `ev` function); `./equin` writes its own (`emitInstallEvent`, the
 * installer `deps` barrel) while it runs as one of the install's steps. This
 * schema is the one definition: the `--dry-run` stream test holds the bash
 * emitter to it, the TS emitter is typed by it.
 *
 * Messages live in the events: every user-facing string (a step's label, what
 * it is doing, a log line) is produced by the step engine, never by a renderer.
 *
 * Design: research/2026-11-17-global-installer-window.md §1.
 */

/** The protocol's major version; a renderer refuses any other. */
export const INSTALL_PROTOCOL_VERSION = 1;

/** install.sh's top-level steps, in run order. */
const TOP_STEP_IDS = [
  "tools",
  "mise",
  "clone",
  "toolchain",
  "start",
  "build",
] as const;
export const InstallTopStepId = z.enum(TOP_STEP_IDS);
export type InstallTopStepId = z.infer<typeof InstallTopStepId>;

/**
 * The sub-steps of the `build` step, in run order: what `./equin build`
 * reports of itself during an install. Each is declared by the build's own
 * profiler spans (`SpanOptions.installStep`, op-runtime), never by a span's
 * name — and the `installer:build-sub-steps-declared` check fails when one of
 * them is declared by no span, so a renamed or removed span cannot silently
 * drop a sub-step from the install's view.
 */
export const BUILD_SUB_STEP_IDS = [
  /** Postgres and this checkout's database are there (the build waits for them). */
  "build.database",
  /** The checkout's file set and its npm packages (`bun install`). */
  "build.deps",
  /** Registries, manifests, migrations, docs — every generated file (and the build steps run beside them). */
  "build.codegen",
  /** The web interface: one artifact per plugin, then the composed dist. */
  "build.interface",
  /** The backend restarted on the new build and answering. */
  "build.deploy",
] as const;
export const BuildSubStepId = z.enum(BUILD_SUB_STEP_IDS);
export type BuildSubStepId = z.infer<typeof BuildSubStepId>;

/**
 * Every step id an event may name — a closed set, so a renderer and the step
 * engine cannot disagree on what a step id means.
 */
export const INSTALL_STEP_IDS = [
  ...TOP_STEP_IDS,
  ...BUILD_SUB_STEP_IDS,
] as const;
export const InstallStepId = z.enum(INSTALL_STEP_IDS);
export type InstallStepId = z.infer<typeof InstallStepId>;

/**
 * The groups the window's step count is made of ("Step 2 of 5"): what a
 * person sees as one stage of the install. A top-level step belongs to one.
 */
const INSTALL_GROUP_IDS = [
  "prepare",
  "download",
  "tools",
  "services",
  "build",
] as const;
export const InstallGroupId = z.enum(INSTALL_GROUP_IDS);
export type InstallGroupId = z.infer<typeof InstallGroupId>;

/** How the stream is being drawn. */
export const InstallMode = z.enum(["window", "interactive", "plain"]);
export type InstallMode = z.infer<typeof InstallMode>;

/** What a progress count counts. `%` is a percentage (total 100). */
export const ProgressUnit = z.enum(["crates", "plugins", "packages", "%"]);
export type ProgressUnit = z.infer<typeof ProgressUnit>;

/** What a step is waiting on (a wait is not work: no estimate covers it). */
export const WaitOn = z.enum([
  /** The machine's build slot (the host CPU grant), held by other work. */
  "host-grant",
  /** A lock another run of the same work holds (this checkout's build lock). */
  "lock",
  /** Apple's own installer dialog, which the person has to click through. */
  "apple-installer",
  /** A password prompt. */
  "password",
]);
export type WaitOn = z.infer<typeof WaitOn>;

const base = {
  v: z.literal(INSTALL_PROTOCOL_VERSION),
  /** When the event was written: an ISO-8601 UTC instant. */
  t: z.iso.datetime(),
};

/**
 * A step's median duration on a clean install, in seconds, or null when none
 * is measured yet — never a guess (`core/estimates.json`).
 */
const EstSeconds = z.number().nonnegative().nullable();

export const PlanSubStep = z.strictObject({
  id: BuildSubStepId,
  /** What the sub-step does, imperative ("Compile native modules"). */
  label: z.string().min(1),
  /** The same, as it happens ("Compiling native modules"). */
  doing: z.string().min(1),
  est_s: EstSeconds,
});
export type PlanSubStep = z.infer<typeof PlanSubStep>;

export const PlanStep = z.strictObject({
  id: InstallTopStepId,
  /** What the step does, in the user's words (the installer message rules). */
  label: z.string().min(1),
  /** The same, as it happens ("Downloading equin"). */
  doing: z.string().min(1),
  group: InstallGroupId,
  /** The whole step's median (its sub-steps' sum when it has any). */
  est_s: EstSeconds,
  optional: z.boolean().optional(),
  /** The steps it is made of, in run order, each reported on its own. */
  substeps: z.array(PlanSubStep).min(1).optional(),
});
export type PlanStep = z.infer<typeof PlanStep>;

export const PlanGroup = z.strictObject({
  id: InstallGroupId,
  label: z.string().min(1),
});
export type PlanGroup = z.infer<typeof PlanGroup>;

/** Who holds what a step waits on, when the step engine knows. */
export const WaitHolder = z.strictObject({
  /** The holder's op id (`./equin ops`), when it is an op. */
  op: z.string().min(1),
  /** What kind of work it is (build, check, test, …). */
  kind: z.string().min(1),
  /** When it started: an ISO-8601 instant. */
  startedAt: z.iso.datetime(),
});
export type WaitHolder = z.infer<typeof WaitHolder>;

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
    /** The groups the steps belong to, in run order. */
    groups: z.array(PlanGroup).min(1),
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
  /**
   * How far the step running now is, counted by the tool doing it (cargo's
   * crates, the artifact builder's plugins, bun's packages, git's and
   * softwareupdate's percentages). `total` is null when the tool has not said
   * yet how much there is.
   */
  z.strictObject({
    ...base,
    type: z.literal("progress"),
    id: InstallStepId,
    done: z.number().int().nonnegative(),
    total: z.number().int().positive().nullable(),
    unit: ProgressUnit,
  }),
  /**
   * The step stopped working to wait on something (`start`) or resumed
   * (`end`). A renderer shows the wait instead of counting it down.
   */
  z.strictObject({
    ...base,
    type: z.literal("wait"),
    step: InstallStepId,
    state: z.enum(["start", "end"]),
    on: WaitOn,
    holder: WaitHolder.optional(),
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

/** An event as an emitter hands it over: the envelope (`v`, `t`) is stamped on write. */
export type InstallEventBody = InstallEvent extends infer E
  ? E extends InstallEvent
    ? Omit<E, "v" | "t">
    : never
  : never;

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
