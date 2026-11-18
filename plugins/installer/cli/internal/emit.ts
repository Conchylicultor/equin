import {
  constants,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { readFileSync } from "@plugins/packages/plugins/timed-fs/core";
import { adoptFd, type OwnedFd } from "@plugins/packages/plugins/owned-fd/core";
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
  INSTALL_PROTOCOL_VERSION,
  InstallEventBody,
  InstallStepId,
  InstallTopStepId,
  NoticeState,
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
  writeAllSync(out.fd, eventLine(event));
}

/** The version every event is written with: the core's, held equal by tsc (the value can't be imported here). */
const PROTOCOL_VERSION: typeof INSTALL_PROTOCOL_VERSION = 2;

/** One event as its line: stamped with `v` and `t`, and whole under PIPE_BUF. */
function eventLine(event: InstallEventBody): string {
  const line = `${JSON.stringify({ v: PROTOCOL_VERSION, t: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), ...event })}\n`;
  if (Buffer.byteLength(line) > PIPE_BUF)
    throw new Error(
      `install event over ${PIPE_BUF} bytes (it could interleave with another writer's): ${line.slice(0, 200)}`,
    );
  return line;
}

// ── Sub-steps ────────────────────────────────────────────────────────────────
// The build's sub-steps run one after another: entering one ends the one
// before it. A span tagged with an EARLIER sub-step than the current one (a
// codegen span after the migrations started) stays in the current one — the
// install's view only moves forward. Tracked whether or not anyone listens: a
// follower that attaches mid-build is told what already happened.

// Times are wall-clock (Date.now()): a follower's request carries the instant
// its step started, from another process.
type SubStepState =
  | { state: "running"; at: number }
  | { state: "done" | "failed"; at: number; end: number }
  | { state: "skipped" };
const subSteps = new Map<BuildSubStepId, SubStepState>();
let current: BuildSubStepId | null = null;

/** The step a report from this process is filed under: the sub-step running now, else the process's own step. */
function reportingStep(): InstallStepId | null {
  const out = openSink();
  if (out === null) return null;
  return current ?? out.step;
}

/** Whether anyone hears this process's sub-steps and progress: its own install, or one following it. */
function heard(): boolean {
  return openSink() !== null || followerFd() !== null;
}

/** A sub-step event, to this process's install and to a follower. */
function sendSubStep(event: InstallEventBody): void {
  emitInstallEvent(event);
  toFollower(event);
}

/** A span tagged `id` started: enter it, unless the build is already past it. */
export function enterBuildSubStep(id: BuildSubStepId): void {
  if (openSink() === null && followFile === null) return;
  // A follower that asked meanwhile is told what happened so far first.
  followerFd();
  if (current !== null) {
    if (SUB_STEP_ORDER.indexOf(id) <= SUB_STEP_ORDER.indexOf(current)) return;
    endCurrent("done");
  }
  // A sub-step the build jumped over (none of its spans ran) is said to be
  // skipped, never left pending.
  for (const skipped of SUB_STEP_ORDER.slice(0, SUB_STEP_ORDER.indexOf(id)))
    if (!subSteps.has(skipped)) {
      subSteps.set(skipped, { state: "skipped" });
      sendSubStep({ type: "step", id: skipped, state: "skipped" });
    }
  subSteps.set(id, { state: "running", at: Date.now() });
  current = id;
  lastProgress = null;
  sendSubStep({ type: "step", id, state: "start" });
}

function endCurrent(state: "done" | "failed"): void {
  if (current === null) return;
  const running = subSteps.get(current);
  const end = Date.now();
  const at = running?.state === "running" ? running.at : end;
  subSteps.set(current, { state, at, end });
  sendSubStep({ type: "step", id: current, state, ms: workedMs(at, end) });
  current = null;
}

/**
 * The build ended: its last sub-step is done (or failed). On success every
 * sub-step it never entered is said to be skipped.
 */
export function finishBuildSubSteps(ok: boolean): void {
  if (openSink() === null && followFile === null) return;
  followerFd();
  endCurrent(ok ? "done" : "failed");
  if (ok)
    for (const id of SUB_STEP_ORDER)
      if (!subSteps.has(id)) {
        subSteps.set(id, { state: "skipped" });
        sendSubStep({ type: "step", id, state: "skipped" });
      }
  // Nothing more to tell a follower: let it go.
  dropFollower();
}

// ── Following: an install's build step watching this build ──────────────────
// A fresh install's background service deploys main itself (its first boot's
// convergence run), and the install's build step is the same convergence run:
// it waits for the service's. While it waits it asks to FOLLOW main's build —
// a follow request (`InstallFollowRequest`) at a path main's build knows —
// and the build reports to that install's stream what it would report as the
// step itself: its sub-steps (those already behind it first) and its counts.
// The install's step then shows main's build as its own work, not a wait.

/** What an install's waiting build step publishes to be told of main's build. */
interface InstallFollowRequest {
  /** The install's event FIFO (its `EQUIN_INSTALL_EVENTS`). */
  events: string;
  /** The waiting process: a request whose process is gone is stale. */
  pid: number;
  /**
   * When the install's build step started waiting (epoch ms): the part of a
   * sub-step that ran before it is the earlier steps' time, never the build
   * step's. Absent in a request written before it existed — one left behind
   * by an install killed mid-build: stale, never followed (and never a
   * throw, which would fail every later build of main).
   */
  since?: number;
  /** Stamped by the build that took the request: the waiter then knows its build step was shown. */
  followedBy?: number;
}

let followFile: string | null = null;
let follower: OwnedFd | null = null;
/** The attached follower's `since`: its step's time starts there. */
let followerSince: number | null = null;

/**
 * How long a sub-step that ran from `at` to `end` worked for the step it is
 * reported under: for a follower, only the part after its step started — a
 * service's build that began during the install's start step reports its
 * database sub-step (done before the install's build step began) as 0, not
 * as the minute it took under start.
 */
function workedMs(at: number, end: number): number {
  return Math.max(0, Math.round(end - Math.max(at, followerSince ?? at)));
}

/**
 * Let an install follow this build: `file` is where a waiting install step
 * publishes its request (main's `worktreeArtifacts.installFollow`). Called by
 * main's build before its first span; a build that is itself an install's
 * step (its own `EQUIN_INSTALL_EVENTS`) is never followed.
 */
export function followableBy(file: string): void {
  if (openSink() !== null) return;
  followFile = file;
}

/**
 * Ask main's build to be followed (see above): writes the request, and
 * returns the call that withdraws it — answering whether a build took it
 * (and so already showed the step its sub-steps). A no-op outside an install.
 */
export function requestFollow(file: string): () => { followed: boolean } {
  const events = readEnv("INSTALL_EVENTS");
  if (events === undefined || events === "") return () => ({ followed: false });
  const request: InstallFollowRequest = {
    events,
    pid: process.pid,
    since: Date.now(),
  };
  // A fresh install's main namespace may have no dir yet (its first deploy is
  // what makes it).
  mkdirSync(dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify(request));
  return () => {
    const read = readRequest(file);
    rmSync(file, { force: true });
    return {
      followed:
        read !== null &&
        read.pid === process.pid &&
        read.followedBy !== undefined,
    };
  };
}

function writeFileAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

function readRequest(file: string): InstallFollowRequest | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const parsed: unknown = JSON.parse(text);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as InstallFollowRequest).events !== "string" ||
    typeof (parsed as InstallFollowRequest).pid !== "number"
  )
    throw new Error(
      `${file} is not an install follow request: ${text.slice(0, 200)}`,
    );
  return parsed as InstallFollowRequest;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((err as NodeJS.ErrnoException).code === "EPERM") return true;
    throw err;
  }
}

function attachedFd(): number | null {
  return follower?.fd ?? null;
}

/** The follower's FIFO, attaching to a pending request first; null when none follows. */
function followerFd(): number | null {
  if (follower !== null) return follower.fd;
  if (followFile === null) return null;
  const request = readRequest(followFile);
  if (
    request === null ||
    request.since === undefined ||
    request.followedBy !== undefined ||
    !alive(request.pid)
  )
    return null;
  let fd: number;
  try {
    fd = openSync(request.events, constants.O_WRONLY | constants.O_NONBLOCK);
  } catch (err) {
    // The install's hub is gone (no reader: ENXIO) or its run dir is: the
    // request is stale, and there is nobody to tell.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENXIO" || code === "ENOENT") return null;
    throw err;
  }
  follower = adoptFd(fd);
  followerSince = request.since;
  writeFileAtomic(
    followFile,
    JSON.stringify({ ...request, followedBy: process.pid }),
  );
  catchUp();
  // The catch-up may have found the install gone (and dropped it).
  return attachedFd();
}

/**
 * What a follower that attached mid-build missed: the wait it was in is over
 * (this build is its step's work now), then every sub-step so far, in order.
 */
function catchUp(): void {
  toFollower({ type: "wait", step: FOLLOWED_STEP, state: "end", on: "lock" });
  for (const id of SUB_STEP_ORDER) {
    const s = subSteps.get(id);
    if (s === undefined) continue;
    if (s.state === "skipped") {
      toFollower({ type: "step", id, state: "skipped" });
      continue;
    }
    toFollower({ type: "step", id, state: "start" });
    if (s.state !== "running")
      toFollower({
        type: "step",
        id,
        state: s.state,
        ms: workedMs(s.at, s.end),
      });
  }
}

/** The step a follower shows this build as. */
const FOLLOWED_STEP = "build" satisfies InstallTopStepId;

function toFollower(event: InstallEventBody): void {
  const fd = attachedFd();
  if (fd === null) return;
  // One write, never waited out: an event is under PIPE_BUF, so the FIFO
  // takes it whole or not at all. This build is main's deploy — a follower
  // whose reader stopped draining (EAGAIN) or went away (EPIPE) is let go,
  // never waited for.
  try {
    writeSync(fd, eventLine(event));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EPIPE" && code !== "EAGAIN") throw err;
    console.error(
      `[installer] stopped reporting to the install following this build (${code})`,
    );
    dropFollower();
  }
}

function dropFollower(): void {
  const held = follower;
  follower = null;
  followerSince = null;
  held?.close();
  followFile = null;
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
  if (openSink() === null && followFile === null) return;
  const now = performance.now();
  const final = total !== null && done >= total;
  if (
    lastProgress !== null &&
    !final &&
    (done === lastProgress.done || now - lastProgress.at < PROGRESS_EVERY_MS)
  )
    return;
  lastProgress = { at: now, done };
  if (!heard()) return;
  const counted = {
    done,
    total: total === null ? null : Math.max(total, done),
    unit,
  };
  const own = reportingStep();
  if (own !== null) emitInstallEvent({ type: "progress", id: own, ...counted });
  toFollower({ type: "progress", id: current ?? FOLLOWED_STEP, ...counted });
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

// ── Pauses and notices ───────────────────────────────────────────────────────

/**
 * Something is wrong but the step goes on (a stall): the install's views show
 * it, with Fix with Claude and Report issue, until `reportInstallResolved`.
 * One event under PIPE_BUF, so keep the words short.
 */
export function reportInstallStall(pause: {
  title: string;
  text: string;
  evidence: string[];
}): void {
  const step = reportingStep();
  if (step === null) return;
  emitInstallEvent({
    type: "pause",
    step,
    kind: "stall",
    ...pause,
    blocking: false,
    optional: false,
    manual: null,
  });
}

/** The stall reported last is over: the step is moving again. */
export function reportInstallResolved(): void {
  if (reportingStep() === null) return;
  emitInstallEvent({ type: "resolved", how: "progress" });
}

/**
 * An optional part the install went on without (or what became of it): the
 * window's banner while the install runs, and its done screen's Add it now.
 */
export function reportInstallNotice(notice: {
  id: string;
  state: NoticeState;
  title: string;
  text: string;
  without: string;
}): void {
  if (reportingStep() === null) return;
  emitInstallEvent({ type: "notice", ...notice });
}

// ── A step's own diagnosis ───────────────────────────────────────────────────

/**
 * A step command's own diagnosis of why it fails, for the pause install.sh
 * shows when the step exits non-zero (its `diagnose` reads it before its
 * generic "didn't finish"). The command knows what failed in the user's terms
 * — an optional part it could not add — where install.sh only sees an exit
 * status. `title` / `text` follow the installer message rules (build them
 * from an `InstallerNotice`); `leaveOut` names the optional parts a Skip
 * leaves out: install.sh then records the Skip (a `notice`) and runs the step
 * again with them in `EQUIN_INSTALL_LEFT_OUT` (`installLeftOut`). Written to the file install.sh
 * names in `EQUIN_INSTALL_DIAGNOSIS`, one `key<TAB>value` per line; outside
 * an install, a no-op.
 */
export function reportInstallDiagnosis(diagnosis: {
  title: string;
  text: string;
  /**
   * The optional parts a Skip leaves out, with what they are to the person
   * (`without`, "the equin icon in your menu bar") and what leaving them out
   * means (`later`: what still works, how to add them later) — install.sh
   * sends both as the `notice` that records the Skip, so the done screen
   * names every part left out.
   */
  leaveOut: { ids: readonly string[]; without: string; later: string } | null;
  evidence: readonly string[];
}): void {
  const path = readEnv("INSTALL_DIAGNOSIS");
  if (path === undefined || path === "") return;
  const one = (v: string) => v.replace(/[\t\r\n]+/g, " ").trim();
  const leaveOut = diagnosis.leaveOut;
  const lines = [
    `title\t${one(diagnosis.title)}`,
    `text\t${one(diagnosis.text)}`,
    ...(leaveOut === null
      ? []
      : [
          `leave-out\t${leaveOut.ids.map(one).join(",")}`,
          `without\t${one(leaveOut.without)}`,
          `later\t${one(leaveOut.later)}`,
        ]),
    ...diagnosis.evidence
      .flatMap((e) => e.split("\n"))
      .map(one)
      .filter((e) => e !== "")
      .map((e) => `evidence\t${e}`),
  ];
  writeFileSync(path, `${lines.join("\n")}\n`);
}

/** The optional parts the person skipped during this install (`EQUIN_INSTALL_LEFT_OUT`). */
export function installLeftOut(): string[] {
  const raw = readEnv("INSTALL_LEFT_OUT") ?? "";
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "");
}
