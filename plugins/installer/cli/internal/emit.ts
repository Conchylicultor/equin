import { constants, openSync } from "node:fs";
import { writeAllSync } from "@plugins/packages/plugins/blocking-write/machine";
import {
  envName,
  readEnv,
} from "@plugins/infra/plugins/launcher/plugins/env-names/core";
// Types only: this module runs in `bun install`'s progress filter, before
// node_modules exists, so it may load no npm package — and the core barrel
// loads zod.
import type {
  BuildSubStepId,
  InstallEventBody,
  InstallStepId,
  InstallTopStepId,
  ProgressUnit,
  WaitHolder,
  WaitOn,
} from "@plugins/installer/core";

/**
 * How a `./equin` command reports itself to the install that runs it as one
 * of its steps (installer/core, protocol v1).
 *
 * install.sh hands its event hub's FIFO to the commands it runs as steps
 * (`EQUIN_INSTALL_EVENTS`, with the step id in `EQUIN_INSTALL_STEP`). A
 * command opens it BY PATH, so the fd is its own (close-on-exec): nothing it
 * spawns — a daemon least of all — inherits the install's event stream and
 * keeps it open after the install ends. Outside an install neither variable
 * is set and every function here is a no-op.
 *
 * Every event is written in one `write` under PIPE_BUF (512 bytes on macOS):
 * install.sh writes its own events to the same FIFO at the same time, and a
 * write that size is never interleaved with another.
 */

/** The largest write the kernel keeps whole beside other writers (macOS). */
const PIPE_BUF = 512;

/** The sub-steps in run order (`BUILD_SUB_STEP_IDS` in installer/core, which this module may not load). */
const SUB_STEP_ORDER = [
  "build.database",
  "build.deps",
  "build.codegen",
  "build.interface",
  "build.deploy",
] as const satisfies readonly BuildSubStepId[];
// A sub-step added to core and not here is a type error (`satisfies` above
// rejects the other direction).
type MissingSubStep = Exclude<BuildSubStepId, (typeof SUB_STEP_ORDER)[number]>;
const everySubStepOrdered: [MissingSubStep] extends [never] ? true : never =
  true;
void everySubStepOrdered;

const TOP_STEPS: readonly string[] = [
  "tools",
  "mise",
  "clone",
  "toolchain",
  "start",
  "build",
] satisfies readonly InstallTopStepId[];

type Sink = { fd: number; step: InstallTopStepId };
let sink: Sink | null | undefined;

/** The install's FIFO, opened on first use; null outside an install. */
function openSink(): Sink | null {
  if (sink !== undefined) return sink;
  const path = readEnv("INSTALL_EVENTS");
  if (path === undefined || path === "") return (sink = null);
  const step = readEnv("INSTALL_STEP");
  if (step === undefined || !TOP_STEPS.includes(step))
    throw new Error(
      `${envName("INSTALL_EVENTS")} is set but ${envName("INSTALL_STEP")} is ${JSON.stringify(step)}, not one of the install's steps (${TOP_STEPS.join(", ")})`,
    );
  // Non-blocking open: a FIFO nobody reads would otherwise hang the open for
  // ever; here it throws ENXIO (the install's hub is gone), loudly.
  const fd = openSync(path, constants.O_WRONLY | constants.O_NONBLOCK);
  return (sink = { fd, step: step as InstallTopStepId });
}

/** True while this process runs as a step of an install. */
export function installEventsOn(): boolean {
  return openSink() !== null;
}

/** Write one event to the install, stamped with `v` and `t`. No-op outside an install. */
export function emitInstallEvent(event: InstallEventBody): void {
  const out = openSink();
  if (out === null) return;
  const line = `${JSON.stringify({ v: 1, t: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), ...event })}\n`;
  if (Buffer.byteLength(line) > PIPE_BUF)
    throw new Error(
      `install event over ${PIPE_BUF} bytes (it could interleave with another writer's): ${line.slice(0, 200)}`,
    );
  writeAllSync(out.fd, line);
}

// ── Sub-steps ────────────────────────────────────────────────────────────────
// The build's sub-steps run one after another: entering one ends the one
// before it. A span tagged with an EARLIER sub-step than the current one (a
// codegen span after the migrations started) stays in the current one — the
// install's view only moves forward.

let current: { id: BuildSubStepId; at: number } | null = null;
const entered = new Set<BuildSubStepId>();

/** The step a report from this process is filed under: the sub-step running now, else the process's own step. */
function reportingStep(): InstallStepId | null {
  const out = openSink();
  if (out === null) return null;
  return current?.id ?? out.step;
}

/** A span tagged `id` started: enter it, unless the build is already past it. */
export function enterBuildSubStep(id: BuildSubStepId): void {
  if (!installEventsOn()) return;
  if (current !== null) {
    if (SUB_STEP_ORDER.indexOf(id) <= SUB_STEP_ORDER.indexOf(current.id))
      return;
    endCurrent("done");
  }
  // A sub-step the build jumped over (none of its spans ran) is said to be
  // skipped, never left pending.
  for (const skipped of SUB_STEP_ORDER.slice(0, SUB_STEP_ORDER.indexOf(id)))
    if (!entered.has(skipped)) {
      entered.add(skipped);
      emitInstallEvent({ type: "step", id: skipped, state: "skipped" });
    }
  entered.add(id);
  current = { id, at: performance.now() };
  lastProgress = null;
  emitInstallEvent({ type: "step", id, state: "start" });
}

function endCurrent(state: "done" | "failed"): void {
  if (current === null) return;
  emitInstallEvent({
    type: "step",
    id: current.id,
    state,
    ms: Math.round(performance.now() - current.at),
  });
  current = null;
}

/**
 * The build ended: its last sub-step is done (or failed). On success every
 * sub-step it never entered is said to be skipped.
 */
export function finishBuildSubSteps(ok: boolean): void {
  if (!installEventsOn()) return;
  endCurrent(ok ? "done" : "failed");
  if (!ok) return;
  for (const id of SUB_STEP_ORDER)
    if (!entered.has(id)) {
      entered.add(id);
      emitInstallEvent({ type: "step", id, state: "skipped" });
    }
}

// ── Progress and waits ───────────────────────────────────────────────────────

/** At most this often per step: a renderer redraws on each, a count moves faster. */
const PROGRESS_EVERY_MS = 250;
let lastProgress: { at: number; done: number } | null = null;

/**
 * How far the step running now is, as the tool doing it counts. Rate-bound
 * (one event per 250 ms); the last count (done = total) always goes out.
 */
export function reportInstallProgress(
  done: number,
  total: number | null,
  unit: ProgressUnit,
): void {
  const id = reportingStep();
  if (id === null) return;
  const now = performance.now();
  const final = total !== null && done >= total;
  if (
    lastProgress !== null &&
    !final &&
    (done === lastProgress.done || now - lastProgress.at < PROGRESS_EVERY_MS)
  )
    return;
  lastProgress = { at: now, done };
  emitInstallEvent({
    type: "progress",
    id,
    done,
    total: total === null ? null : Math.max(total, done),
    unit,
  });
}

/** The step stopped to wait on something (`start`), or resumed (`end`). */
export function reportInstallWait(
  state: "start" | "end",
  on: WaitOn,
  holder?: WaitHolder,
): void {
  const step = reportingStep();
  if (step === null) return;
  emitInstallEvent({
    type: "wait",
    step,
    state,
    on,
    ...(holder === undefined ? {} : { holder }),
  });
}
