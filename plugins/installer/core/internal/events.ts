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

/**
 * The protocol's major version: what every emitter writes. A renderer reads
 * this version and the older ones it is a superset of
 * ({@link READABLE_PROTOCOL_VERSIONS}), and refuses any other.
 *
 * - 1: the first stream.
 * - 2: adds `doing` (what a step is doing now, when it names a phase of its
 *   own). A v1 stream is a valid v2 stream, so recorded v1 runs still read.
 */
export const INSTALL_PROTOCOL_VERSION = 2;

/** Every version a v{@link INSTALL_PROTOCOL_VERSION} reader reads: each a subset of this one. */
const READABLE_PROTOCOL_VERSIONS = [1, INSTALL_PROTOCOL_VERSION] as const;

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

/**
 * What a pause is, as the step engine diagnosed it (install.sh's `diagnose`,
 * the build's wait reporting). Each kind is a symptom confirmed by a fact; a
 * failure no rule confirms is `unknown`, and its message never guesses.
 */
export const PauseKind = z.enum([
  /** The app the install was started from runs it in a protected mode that stopped it. */
  "sandbox",
  /** Security software the organisation runs removed or blocked part of equin. */
  "security",
  /** The install is waiting on something that stopped making progress. */
  "stall",
  /** A step failed and no rule recognised why. */
  "unknown",
]);
export type PauseKind = z.infer<typeof PauseKind>;

/**
 * What the person can do about a pause besides Fix with Claude and Report
 * issue — a closed set, each one the step engine knows how to carry out.
 */
export const PauseManualId = z.enum([
  /** Write a `.command` that runs the install again, and open it in Terminal. */
  "continue-in-terminal",
  /** A ready-made message for the IT team, copied and saved beside the log. */
  "copy-it-request",
]);
export type PauseManualId = z.infer<typeof PauseManualId>;

/** How a decision answers a pause: what the person (or Claude) chose. */
export const PauseResolution = z.enum([
  /** The step runs again. */
  "retry",
  /** An optional step is left out. */
  "skip",
  /** The install gives up; running it again resumes. */
  "quit",
  /** A pause that did not stop the step (a stall) ended: the step is moving again. */
  "progress",
]);
export type PauseResolution = z.infer<typeof PauseResolution>;

/** Where Fix with Claude opened Claude. */
export const FixTarget = z.enum([
  /** The Claude app: the prompt is on the clipboard, to paste. */
  "app",
  /** Claude Code in a terminal, started with the prompt. */
  "cli",
]);
export type FixTarget = z.infer<typeof FixTarget>;

/** Where an optional part left out of the install stands. */
export const NoticeState = z.enum([
  /** Left out: the install went on without it. */
  "skipped",
  /** The setting that allows it is open; adding it again is the next click. */
  "settings-opened",
  /** Added after all. */
  "added",
]);
export type NoticeState = z.infer<typeof NoticeState>;

const base = {
  v: z.literal(READABLE_PROTOCOL_VERSIONS),
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
    /**
     * A `--dry-run`'s stream (scripted steps, nothing changed): its timings
     * are never a median's input. Absent on a real install.
     */
    dryRun: z.literal(true).optional(),
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
  /**
   * What the running step is doing now, when the step names a phase of its
   * own beyond the plan's `doing` — install.sh's `say` inside a step
   * ("Installing the system libraries the Chromium browser runs on (asks for
   * your password)"). In the user's words (the installer message rules). It
   * holds until the step's next `doing` or its end; a count reported before
   * it no longer describes the step.
   */
  z.strictObject({
    ...base,
    type: z.literal("doing"),
    step: InstallStepId,
    text: z.string().min(1),
  }),
  /** One line of output: a step's child output, or the script's own (step null). */
  z.strictObject({
    ...base,
    type: z.literal("log"),
    step: InstallStepId.nullable(),
    stream: z.enum(["out", "err"]),
    line: z.string(),
  }),
  /**
   * The install stopped on a problem it diagnosed (`blocking`: the step
   * failed and the script waits for a decision), or keeps going while it
   * says something is wrong (not blocking: a stall, which ends with
   * `resolved` once the step moves again). Every string follows the
   * installer message rules; `evidence` holds the raw lines (paths already
   * shown as `~`). A blocking pause, like the plan, is written while no step
   * runs, so it may exceed one atomic write.
   */
  z.strictObject({
    ...base,
    type: z.literal("pause"),
    /** The step it is about; null before any step runs (a check up front). */
    step: InstallStepId.nullable(),
    kind: PauseKind,
    title: z.string().min(1),
    text: z.string().min(1),
    evidence: z.array(z.string()),
    blocking: z.boolean(),
    /** Whether Skip is offered: the step can be left out. */
    optional: z.boolean(),
    manual: z
      .strictObject({ id: PauseManualId, label: z.string().min(1) })
      .nullable(),
  }),
  /** The pause open now ended, and how. */
  z.strictObject({
    ...base,
    type: z.literal("resolved"),
    how: PauseResolution,
  }),
  /**
   * Fix with Claude: Claude was opened with the problem and the log. The
   * install waits on, and goes on when Claude (or Try again) says so.
   */
  z.strictObject({
    ...base,
    type: z.literal("fixing"),
    target: FixTarget,
    /** The prompt is on the clipboard (the Claude app's way in). */
    clipboard: z.boolean(),
  }),
  /**
   * An optional part the install went on without (the login services macOS
   * refused to add), and later what became of it. `id` names what `./equin
   * start --only` adds back; `title` / `text` follow the message rules.
   */
  z.strictObject({
    ...base,
    type: z.literal("notice"),
    id: z.string().min(1),
    state: NoticeState,
    title: z.string().min(1),
    text: z.string().min(1),
    /** What the install went on without, as a person knows it ("the menu-bar icon and app shortcuts"). */
    without: z.string().min(1),
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
    /**
     * Why the install stopped, when it was not the install's own doing: the
     * terminal view ended under it, or the stream lost its reader (SIGPIPE).
     */
    cause: z.string().optional(),
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
