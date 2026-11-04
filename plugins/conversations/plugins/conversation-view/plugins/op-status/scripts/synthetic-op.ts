/**
 * A synthetic op for the op-status e2es (`../e2e/op-status-waits.ts`,
 * `../e2e/op-sleep.ts`): a real process that drives the REAL writers — the flocked liveness marker
 * (`markWorktreeOpStart`) and the op-log profiler (`createOpProfiler`) — through
 * a scripted life, one step per write of a control file, so the e2e can assert
 * what the banner and chip show at each state. A separate process because the
 * e2e runtime may not import `server` barrels, and because killing it is the
 * honest way to test a death. (Steps used to be signals; a child spawned from
 * the Playwright-driving e2e process never saw SIGUSR2, and Bun crashes on
 * SIGUSR1 — so the driver writes `<dir>/control.json` instead, which this
 * process watches.)
 *
 *   run   --slug <ns> --op-id <id> --dir <dir>
 *     on start   : publish the marker, `requested`, two requeues, then
 *                  `wait-start duress-valve` (reason "cluster-onset: loadRatio",
 *                  cycle 2)                                     → ready.json {step:0}
 *     control ≥ 1: `wait-end cleared` + `granted`               → ready.json {step:1}
 *     control ≥ 2: `completed success`, then release the marker → ready.json {step:2}, exit 0
 *     SIGKILL    : dies holding the marker, no terminal — the kernel drops the lock
 *
 *   run-asleep --slug <ns> --op-id <id> --dir <dir> [--asleep-ms <n>]
 *     An op that SLEPT, without sleeping the machine: its events are written
 *     raw (through the real `appendOpLog`), backdated, and carry sleep stamps
 *     from a fake boot whose clock jumps by `n` ms (default 2 h) between the
 *     grant and the next event, with the wake instant inside that gap — so the
 *     fold places the nap exactly. The fake boot never matches the machine's
 *     real clock, so no reader derives a live tail on top.
 *     on start   : publish the marker; `requested` at now − (n + 10 min),
 *                  `granted` 1 min later, then — `n` asleep later —
 *                  `wait-start host-grant` 30 s ago, woken 5 min before it
 *                                                              → ready.json {step:0}
 *     control ≥ 1: `wait-end acquired` + `completed success` (the summary's
 *                  sleeps folded from the same events), release → ready.json {step:1}, exit 0
 *
 *   close --op-id <id>
 *     Append the reconciler's own `completed{by:"reconciler"}` for an op the
 *     log still has in flight — the stand-in for main's reconciler, used ONLY
 *     for cleanup when main does not run it yet. Refuses a live or unknown op.
 *
 * The branch is `e2e-synthetic` so the rows are recognisable in the history.
 */
import { watch, writeFileSync } from "node:fs";
import {
  existsSync,
  readFileSync,
} from "@plugins/packages/plugins/timed-fs/core";
import { join } from "node:path";
import {
  appendOpLog,
  createOpProfiler,
  readOpStates,
  readSleepNow,
} from "@plugins/debug/plugins/profiling/plugins/op-log/server";
import {
  applyOpEvent,
  orphanedOps,
  reconcilerCompletedEvent,
  type OpEvent,
  type OpFoldState,
  type SleepStamp,
} from "@plugins/debug/plugins/profiling/plugins/op-log/core";
import {
  markWorktreeOpStart,
  probeWorktreeOp,
} from "@plugins/infra/plugins/worktree/server";

const BRANCH = "e2e-synthetic";
/** How long a run may sit un-advanced before it gives up on its driver. */
const MAX_LIFE_MS = 10 * 60_000;

/** `--name`'s value, or `fallback` when absent. */
function optionalFlag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

function flag(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (!v) {
    console.error(`synthetic-op: --${name} is required`);
    process.exit(2);
  }
  return v;
}

async function close(): Promise<void> {
  const opId = flag("op-id");
  const state = readOpStates().get(opId);
  if (!state) {
    // The driver's cleanup calls this for every op it started, including one
    // that died before its first event: there is nothing to close.
    console.log(
      `synthetic-op close: ${opId} is not in the op log — nothing to close`,
    );
    return;
  }
  const slug = state.identity?.opSlug;
  if (slug && (await probeWorktreeOp(slug, opId)) === "live")
    throw new Error(`synthetic-op close: ${opId} is still running`);
  const [orphan] = orphanedOps([state]);
  if (!orphan) {
    console.log(`synthetic-op close: ${opId} is already closed`);
    return;
  }
  appendOpLog(reconcilerCompletedEvent(orphan, Date.now(), readSleepNow()));
  console.log(
    `synthetic-op close: appended the reconciler terminal for ${opId}`,
  );
}

/**
 * The driver protocol both run modes share: `ready.json` says which step this
 * process has performed, and the driver's whole-file rename of `control.json`
 * asks for the next one. `perform(step)` does step `step` (1, 2, …) and
 * returns `true` when it was the last — the process then exits 0. A driver
 * that never advances us hits `onGiveUp` after MAX_LIFE_MS: a deadline, not a
 * poll, so a held marker is never left behind forever.
 */
function driven(
  dir: string,
  perform: (step: number) => boolean,
  onGiveUp: () => void,
): void {
  const readyFile = join(dir, "ready.json");
  const controlFile = join(dir, "control.json");
  const say = (step: number) =>
    writeFileSync(readyFile, JSON.stringify({ step, pid: process.pid }));
  const lifetime = setTimeout(() => {
    console.error("synthetic-op: never advanced — giving up");
    onGiveUp();
    process.exit(1);
  }, MAX_LIFE_MS);

  let step = 0;
  const advanceTo = (wanted: number): void => {
    while (step < wanted) {
      step++;
      const last = perform(step);
      say(step);
      if (last) {
        clearTimeout(lifetime);
        watcher.close();
        process.exit(0);
      }
    }
  };
  const readControl = (): number => {
    if (!existsSync(controlFile)) return 0;
    const text = readFileSync(controlFile, "utf8");
    // The driver writes the file whole via rename, so a read is never torn.
    return (JSON.parse(text) as { step: number }).step;
  };
  // Push-based: the driver's rename of control.json wakes this watcher.
  const watcher = watch(dir, () => advanceTo(readControl()));
  say(0);
  advanceTo(readControl());
}

function run(): void {
  const slug = flag("slug");
  const opId = flag("op-id");
  const dir = flag("dir");

  const marker = markWorktreeOpStart(slug, "build", opId);
  const profiler = createOpProfiler("build", {
    opId,
    branch: BRANCH,
    opSlug: slug,
    lane: "background",
    buildId: null,
  });
  profiler.markRequested();
  profiler.requeue();
  profiler.requeue();
  profiler.waitStart("duress-valve", "cluster-onset: loadRatio");

  driven(
    dir,
    (step) => {
      if (step === 1) {
        profiler.waitEnd("cleared");
        profiler.markGranted();
        return false;
      }
      // The terminal BEFORE the release — the ordering every op command keeps.
      profiler.complete("success");
      profiler.write();
      marker.release();
      return true;
    },
    () => {
      profiler.complete("failed");
      profiler.write();
      marker.release();
    },
  );
}

/** One event's own fields, per kind — `emit` stamps the envelope. */
type Body = DistributiveOmit<
  OpEvent,
  "v" | "opId" | "seq" | "at" | "t" | "sleep"
>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/** The fake boot `run-asleep` stamps — never the machine's real one. */
const FAKE_BOOT = "e2e-synthetic-boot";
const MINUTE = 60_000;

function runAsleep(): void {
  const slug = flag("slug");
  const opId = flag("op-id");
  const dir = flag("dir");
  const asleepMs = Number(optionalFlag("asleep-ms", String(2 * 60 * MINUTE)));
  if (!Number.isFinite(asleepMs) || asleepMs <= 0) {
    console.error("synthetic-op: --asleep-ms must be a positive number");
    process.exit(2);
  }

  const marker = markWorktreeOpStart(slug, "build", opId);
  const now = Date.now();
  const requestedMs = now - asleepMs - 10 * MINUTE;
  const grantedMs = requestedMs + MINUTE;
  const waitAtMs = now - 30_000;
  const wakeAtMs = waitAtMs - 5 * MINUTE;
  const baseAsleep = 1_000_000;

  // Every event goes to the real log AND through the real reducer, so the
  // terminal's summary carries exactly the sleeps (and wall-placed waits) the
  // fold derived from these same lines.
  let seq = 0;
  let state: OpFoldState | undefined;
  const emit = (atMs: number, sleep: SleepStamp, body: Body): OpEvent => {
    seq++;
    const event = {
      v: 2,
      opId,
      seq,
      at: new Date(atMs).toISOString(),
      // The monotonic clock pauses while asleep: wall offset minus the sleep
      // since `requested`.
      t: atMs - requestedMs - (sleep.asleepMs - baseAsleep),
      sleep,
      ...body,
    } as OpEvent;
    state = applyOpEvent(state, event);
    appendOpLog(event);
    return event;
  };
  const awake: SleepStamp = { boot: FAKE_BOOT, asleepMs: baseAsleep };
  const woke: SleepStamp = {
    boot: FAKE_BOOT,
    asleepMs: baseAsleep + asleepMs,
    wakeAtMs,
  };
  const identity = {
    kind: "build" as const,
    opSlug: slug,
    branch: BRANCH,
    conversationId: null,
    lane: "background" as const,
    mode: null,
    buildId: null,
  };

  emit(requestedMs, awake, {
    e: "requested",
    ...identity,
    pid: process.pid,
  });
  emit(grantedMs, awake, { e: "granted" });
  const waitStart = emit(waitAtMs, woke, {
    e: "wait-start",
    wait: "host-grant",
    reason: null,
    cycle: 0,
  });

  const finish = (outcome: "success" | "failed"): void => {
    const endMs = Date.now();
    const endT = endMs - requestedMs - asleepMs;
    emit(endMs, woke, {
      e: "wait-end",
      wait: "host-grant",
      startMs: waitStart.t,
      durationMs: Math.max(0, endT - waitStart.t),
      result: "acquired",
      reason: null,
      cycle: 0,
    });
    const folded = state;
    if (!folded) throw new Error("synthetic-op: no fold state");
    emit(endMs, woke, {
      e: "completed",
      by: "self",
      summary: {
        ...identity,
        pid: process.pid,
        requestedAt: new Date(requestedMs).toISOString(),
        grantedAt: new Date(grantedMs).toISOString(),
        completedAt: new Date(endMs).toISOString(),
        waits: folded.waits,
        holdMs: endMs - grantedMs,
        totalMs: endMs - requestedMs,
        outcome,
        interrupted: false,
        steps: [],
        sleeps: folded.sleeps,
      },
    });
    marker.release();
  };

  driven(
    dir,
    () => {
      // The terminal BEFORE the release — the ordering every op command keeps.
      finish("success");
      return true;
    },
    () => finish("failed"),
  );
}

const mode = process.argv[2];
if (mode === "run") run();
else if (mode === "run-asleep") runAsleep();
else if (mode === "close") await close();
else {
  console.error("usage: synthetic-op.ts run|run-asleep|close …");
  process.exit(2);
}
