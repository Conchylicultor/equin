import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { beginWait } from "@plugins/infra/plugins/runtime-profiler/core";
import {
  backoffPolicy,
  claimInstance,
  closeRun,
  openRun,
  pidAlive,
  releaseInstance,
  setState,
  type AttachOptions,
  type DaemonExit,
  type DaemonInstance,
  type DaemonStartCommon,
  type DaemonTransition,
  type SpawnedCode,
  type DetachedLaunch,
  type ProcessLaunch,
  type SupervisedDaemonInstance,
  type WorkerDaemonInstance,
  type WorkerLaunch,
} from "./registry";
import type { newDeclState } from "./registry";
import { PRODUCT_NAME } from "@plugins/framework/plugins/product-name/core";
import {
  inAppScope,
  unprobedScopeHost,
} from "@plugins/packages/plugins/systemd-scope/core";
import { holdPidFile, type HeldPidFile, type HeldRead } from "./pid-file-watch";

type DeclState = ReturnType<typeof newDeclState>;

/**
 * Where a detached launch gets its own scope: Linux, the child looking for the
 * user manager itself (no stat on this event loop, no fs in `server/`).
 */
function daemonScopeHost(): ReturnType<typeof unprobedScopeHost> {
  return unprobedScopeHost({
    platform: process.platform,
    uid: process.getuid?.() ?? -1,
  });
}

/** How long a stopped child gets after SIGTERM before SIGKILL. */
const STOP_KILL_AFTER_MS = 5_000;

/**
 * How long a process's exit waits for its stderr to close, so every line is
 * delivered before the exit's transition. The pipe closes with the child
 * unless a grandchild inherited it and lives on — a process we do not
 * control, hence a bound rather than an unbounded wait: past it the exit is
 * reported and the late lines still arrive, after it.
 */
const STDERR_DRAIN_AFTER_EXIT_MS = 1_000;
type InstanceRec = ReturnType<typeof claimInstance>;

/** What one incarnation looks like to the supervisor, whatever it runs on. */
interface Incarnation {
  pid: number | null;
  /** The code it was spawned to run (`SpawnedCode`), as launched. */
  code: SpawnedCode | null;
  /** Deliberate end: graceful step (if any), then kill / terminate. */
  stop(): Promise<void>;
}

/**
 * Spawn one incarnation. `onExit` is called exactly once when it ends, with a
 * reason a person reads ("exited with code 1", the worker's error) and the
 * process's exit status (`null` for a worker).
 */
type Spawner = (hooks: {
  onExit: (reason: string, exit: DaemonExit | null) => void;
  ready: () => void;
}) => Incarnation;

const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/;

/**
 * A process's code, read off its argv: the executable, and the module files
 * a Bun-style runtime loads from it (every absolute code-file argument). An
 * argv naming no such file runs code this process cannot point at (a
 * `python -m`, a native binary's own data) — `entries: null`.
 */
function processCode(argv: readonly string[]): SpawnedCode {
  const entries = argv
    .slice(1)
    .filter((a) => a.startsWith("/") && CODE_FILE.test(a));
  return {
    binary: argv[0] ?? null,
    entries: entries.length > 0 ? entries : null,
  };
}

/** A worker's code: its module, run on this process's own Bun. */
function workerCode(url: URL): SpawnedCode {
  return {
    binary: null,
    entries:
      url.protocol === "file:" ? [decodeURIComponent(url.pathname)] : null,
  };
}

function label(state: DeclState, rec: InstanceRec): string {
  const i = rec.info.instance;
  return `${state.spec.name}${i === null ? "" : ` (${i})`}`;
}

function defaultLog(line: string): void {
  console.error(`[daemon] ${line}`);
}

/**
 * The ONE supervision loop: spawn, watch for the exit, respawn with a doubling
 * backoff, and give up loudly after too many rapid deaths (unless the policy
 * says `giveUp: "never"`). Both arms with an exit event (process, worker) run
 * through it, so the policy cannot drift between them.
 */
function supervise(
  state: DeclState,
  rec: InstanceRec,
  common: DaemonStartCommon,
  spawn: Spawner,
  backoffOverride?: { minMs: number; maxMs: number },
): { stop(): Promise<void>; respawnNow(): "respawned" | "already-alive" } {
  const policy = backoffPolicy(state.spec.restart);
  const minMs = backoffOverride?.minMs ?? policy?.minMs ?? 0;
  const maxMs = backoffOverride?.maxMs ?? policy?.maxMs ?? 0;
  const log = common.onLog ?? defaultLog;
  const emit = (t: DaemonTransition): void => common.onState?.(t);

  let current: Incarnation | null = null;
  let stopping = false;
  let respawnTimer: ReturnType<typeof setTimeout> | null = null;
  let backoffMs = minMs;
  let rapidFailures = 0;
  let deaths = 0;
  let lastError: string | null = null;
  let spawnedAt = 0;
  let readyThisSpawn = false;

  const markHealthy = (): void => {
    rapidFailures = 0;
    deaths = 0;
    lastError = null;
    backoffMs = minMs;
  };

  const start = (): void => {
    spawnedAt = Date.now();
    readyThisSpawn = false;
    let ended = false;
    // `ready()` may be called inside `spawn` (a process's `onSpawn` that
    // finds its sign already there): the state it sets must land after the
    // pre-ready state below, not be overwritten by it.
    let spawning = true;
    const becomeRunning = (): void => {
      setState(state, rec, "running");
      emit({ state: "running", at: Date.now() });
    };
    const incarnation = spawn({
      onExit: (reason, exit) => {
        if (ended) return;
        ended = true;
        if (current === incarnation) current = null;
        onExit(reason, exit);
      },
      ready: () => {
        if (ended || readyThisSpawn) return;
        readyThisSpawn = true;
        markHealthy();
        if (!spawning) becomeRunning();
      },
    });
    spawning = false;
    current = incarnation;
    rec.info.pid = incarnation.pid;
    rec.info.spawnedAt = new Date(spawnedAt);
    rec.code = incarnation.code;
    openRun(state, rec);
    // A survival-healthy (or never-restarting) daemon is running once spawned;
    // a ready-healthy one waits for its signal.
    if (policy?.healthy !== "ready") {
      setState(state, rec, "running");
      if (rec.info.restarts === 0) emit({ state: "running", at: Date.now() });
    } else if (readyThisSpawn && !ended) {
      becomeRunning();
    } else {
      // Still `starting` (first spawn) or `respawning` until ready().
      setState(state, rec, rec.info.restarts === 0 ? "starting" : "respawning");
    }
  };

  const onExit = (reason: string, exit: DaemonExit | null): void => {
    rec.info.pid = null;
    rec.info.spawnedAt = null;
    rec.code = null;
    rec.info.lastExit = { at: new Date(), reason };
    if (stopping) return; // stop() closes the run itself
    lastError = reason;
    closeRun(state, rec, "failed", reason);
    if (policy === null) {
      setState(state, rec, "exited");
      emit({ state: "exited", at: Date.now(), lastError, exit });
      log(`${label(state, rec)} exited: ${reason}. It is not restarted.`);
      return;
    }
    const lived = Date.now() - spawnedAt;
    const rapid = lived < policy.rapidExitMs;
    // A survival-healthy spawn that outlived the rapid window was healthy.
    if (!rapid && policy.healthy === "survival") markHealthy();
    lastError = reason;
    rapidFailures = rapid ? rapidFailures + 1 : 0;
    deaths += 1;
    if (
      policy.giveUp !== "never" &&
      rapidFailures >= policy.giveUp.afterRapidFailures
    ) {
      setState(state, rec, "gave-up");
      emit({ state: "gave-up", at: Date.now(), deaths, lastError, exit });
      log(
        `${label(state, rec)} died ${String(policy.giveUp.afterRapidFailures)} times within ${String(policy.rapidExitMs)}ms of spawn — giving up. It is NOT running. Last error: ${reason}`,
      );
      return;
    }
    const inMs = backoffMs;
    setState(state, rec, "respawning");
    emit({
      state: "respawning",
      at: Date.now(),
      inMs,
      deaths,
      lastError,
      exit,
    });
    log(
      `${label(state, rec)} exited (${reason}) — respawning in ${String(inMs)}ms`,
    );
    respawnTimer = setTimeout(() => {
      respawnTimer = null;
      if (stopping) return;
      rec.info.restarts += 1;
      start();
    }, inMs);
    backoffMs = Math.min(backoffMs * 2, maxMs);
  };

  emit({ state: "starting", at: Date.now() });
  start();

  return {
    respawnNow() {
      if (stopping) {
        throw new Error(
          `[daemon] ${label(state, rec)}: respawnNow() after stop() — the instance is gone; start a new one`,
        );
      }
      if (current !== null) return "already-alive";
      if (respawnTimer !== null) {
        clearTimeout(respawnTimer);
        respawnTimer = null;
      }
      // Asked for on purpose (a wake, a Retry): what kept failing may be
      // fixed, so the next death waits `minMs` again, not the ceiling.
      backoffMs = minMs;
      rapidFailures = 0;
      log(`${label(state, rec)} respawned on request`);
      rec.info.restarts += 1;
      start();
      return "respawned";
    },
    async stop() {
      if (stopping) return;
      stopping = true;
      if (respawnTimer !== null) {
        clearTimeout(respawnTimer);
        respawnTimer = null;
      }
      const inc = current;
      current = null;
      if (inc !== null) await inc.stop();
      closeRun(state, rec, "succeeded", null);
      releaseInstance(state, rec);
      emit({ state: "stopped", at: Date.now() });
    },
  };
}

// ---------------------------------------------------------------------------
// Line pumps

/**
 * Drain a child's stream line by line for its whole life. Fire-and-forget: it
 * ends when the child exits and the stream closes — then `onEnd` runs (after
 * the last line; also when the read failed, whose error still surfaces).
 */
function pumpLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
  onEnd?: () => void,
): void {
  // eslint-disable-next-line detached-work-safety/no-untracked-detached-work -- drains a long-lived child's output for its whole lifetime: I/O-bound, not main-thread CPU; a bg span would stay open as long as the child lives.
  void (async () => {
    try {
      const decoder = new TextDecoder();
      let buffer = "";
      // Cast: the DOM lib's ReadableStream lacks the async-iterator declaration
      // Bun provides at runtime.
      for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) if (line.length > 0) onLine(line);
      }
      if (buffer.length > 0) onLine(buffer);
    } finally {
      onEnd?.();
    }
  })();
}

function exitReason(code: number | null, signal: string | null): string {
  if (signal !== null) return `killed by ${signal}`;
  return `exited with code ${String(code)}`;
}

// ---------------------------------------------------------------------------
// Arms

export function spawnProcessIn(
  state: DeclState,
  opts: ProcessLaunch,
): SupervisedDaemonInstance {
  // tsc requires `onSpawn` on a ready-healthy declaration's launch; a caller
  // holding the widened types gets the same refusal here, before any spawn.
  if (
    state.spec.restart.kind === "backoff" &&
    state.spec.restart.healthy === "ready" &&
    opts.onSpawn === undefined
  ) {
    throw new Error(
      `[daemon] ${state.spec.name}: a \`healthy: "ready"\` process launch needs \`onSpawn\` — it is the only way the process arm can say ready`,
    );
  }
  const rec = claimInstance(state, opts.instance, "process", null);
  const sup = supervise(state, rec, opts, ({ onExit, ready }) => {
    const argv = typeof opts.argv === "function" ? opts.argv() : opts.argv;
    const onLine = opts.onStderrLine;
    // The exit's transition comes after the last stderr line: an exit seen
    // while stderr is still open waits for its end (or the drain bound).
    let stderrOpen = false;
    let pendingExit: (() => void) | null = null;
    let drainBound: ReturnType<typeof setTimeout> | null = null;
    const flushExit = (): void => {
      if (drainBound !== null) clearTimeout(drainBound);
      drainBound = null;
      const report = pendingExit;
      pendingExit = null;
      report?.();
    };
    const proc = Bun.spawn(argv, {
      cwd: opts.cwd,
      env: opts.env,
      stdin: "ignore",
      stdout: "ignore",
      stderr: onLine === undefined ? "ignore" : "pipe",
      onExit: (_p, code, signalCode) => {
        const exit: DaemonExit = {
          code: signalCode === null ? code : null,
          signal: signalCode === null ? null : String(signalCode),
        };
        pendingExit = () => {
          onExit(exitReason(exit.code, exit.signal), exit);
        };
        if (!stderrOpen) {
          flushExit();
          return;
        }
        drainBound = setTimeout(flushExit, STDERR_DRAIN_AFTER_EXIT_MS);
      },
    });
    if (onLine !== undefined && proc.stderr instanceof ReadableStream) {
      stderrOpen = true;
      pumpLines(proc.stderr, onLine, () => {
        stderrOpen = false;
        flushExit();
      });
    }
    opts.onSpawn?.({ pid: proc.pid, ready });
    return {
      pid: proc.pid,
      code: processCode(argv),
      async stop() {
        proc.kill();
        // SIGKILL a child that ignores SIGTERM, so a stop always ends.
        const escalate = setTimeout(
          () => proc.kill("SIGKILL"),
          STOP_KILL_AFTER_MS,
        );
        await proc.exited;
        clearTimeout(escalate);
      },
    };
  });
  // Assigned onto the handle, not spread: its `pid` / `state` are getters.
  return Object.assign(instanceHandle(state, rec, sup.stop), {
    respawnNow: sup.respawnNow,
  });
}

export function spawnWorkerIn(
  state: DeclState,
  opts: WorkerLaunch,
): WorkerDaemonInstance {
  const rec = claimInstance(state, opts.instance, "worker", null);
  let worker: Worker | null = null;
  const sup = supervise(
    state,
    rec,
    opts,
    ({ onExit, ready }) => {
      // The environment AS IT IS NOW, unless the launch names one: a Bun
      // Worker given none sees only the environment this process STARTED with
      // (measured, Bun 1.4.4), never what its entry point declared since — the
      // data root's layout, which a backend's `bin/` declares in-process
      // (infra/paths CLAUDE.md, § The data root).
      const w = new Worker(opts.url, {
        ...(opts.argv ? { argv: opts.argv } : {}),
        env: opts.env ?? currentEnv(),
      });
      worker = w;
      let lastError: string | null = null;
      w.onmessage = (event: MessageEvent) => {
        opts.onMessage(event.data, { ready });
      };
      w.addEventListener("error", (event: ErrorEvent) => {
        lastError = event.message;
        opts.onError?.(event.message);
      });
      // Bun fires `close` when the worker ends for any reason — the one
      // supervision point.
      w.addEventListener("close", () => {
        if (worker === w) worker = null;
        onExit(lastError ?? "worker exited", null);
      });
      opts.onSpawn?.(w);
      return {
        pid: null,
        code: workerCode(opts.url),
        async stop() {
          if (opts.stop) await opts.stop(w);
          w.terminate();
        },
      };
    },
    opts.backoff,
  );
  const handle = instanceHandle(state, rec, sup.stop);
  return {
    get name() {
      return handle.name;
    },
    get instance() {
      return handle.instance;
    },
    get pid() {
      return handle.pid;
    },
    get state() {
      return handle.state;
    },
    stop: handle.stop,
    respawnNow: sup.respawnNow,
    postMessage(message: unknown) {
      worker?.postMessage(message);
    },
    awaitReply<T>(reply: Promise<T>): Promise<T> {
      // The worker's time, not the caller's: an `io` wait like a git child's
      // (`git:<subcommand>`) — shown while pending, charged as it settles,
      // and filed against the worker (`wait worker:<name>`) when slow.
      const end = beginWait(`worker:${handle.name}`, "io");
      return reply.finally(end);
    },
  };
}

/**
 * Pid-file liveness. The pid file is watched (`holdPidFile`): each change of
 * it is read off the thread and pushed here, so a transition fires when the
 * file moves, not when someone looks. A get (`instance.pid` / `.state`, the
 * catalog) judges the HELD read again with a `kill(0)` — memory and one
 * syscall, never the disk — so a process that dies leaving its file behind
 * is seen there (no event exists for a process this backend is not the
 * parent of, and nothing polls). A get that finds nothing alive also asks
 * for a fresh read, async: the watch can miss a write (see `holdPidFile`),
 * and the next look must not trust a read the watch never refreshed.
 *
 * Before the first read lands the instance stays `starting`: its liveness
 * is not known yet. Each pid it sees is an incarnation: a new pid is a
 * restart, a dead one an exit.
 *
 * A detached launch's exit is final (its owner relaunches it as a new
 * instance; its watch is released then); an attached process may come back
 * under a new pid (launchd restarting the gateway), so it is followed past an
 * exit.
 */
function followPidFile(
  state: DeclState,
  rec: InstanceRec,
  pidFile: AppPath,
  emit: (t: DaemonTransition) => void,
  opts: {
    /** Whether a not-yet-seen process may still be coming up, per that read. */
    stillBooting: (held: HeldRead) => boolean;
    /**
     * Why the launch failed before its process appeared (a failed
     * bootstrap), as of that read — `null` when it did not, or when the read
     * cannot tell yet.
     */
    failedEarly?: (held: HeldRead) => string | null;
  },
): HeldPidFile {
  const final = rec.info.arm === "detached";
  let lastPid: number | null = null;
  const exit = (reason: string): void => {
    rec.info.lastExit = { at: new Date(), reason };
    rec.info.pid = null;
    rec.info.spawnedAt = null;
    if (rec.run === null) openRun(state, rec);
    closeRun(state, rec, "failed", reason);
    setState(state, rec, "exited");
    // Not the process's parent: no exit status to report.
    emit({ state: "exited", at: Date.now(), lastError: reason, exit: null });
    // Nothing can follow a final exit: stop watching.
    if (final) held.release();
  };
  const judge = (): void => {
    if (final && rec.info.state === "exited") return;
    const current = held.current();
    if (current === null) return; // not read yet: still `starting`
    const { read } = current;
    if (read.kind === "pid" && read.pid !== lastPid && pidAlive(read.pid)) {
      // A pid we have not followed yet, and it is alive: a new incarnation.
      if (rec.info.pid !== null) {
        rec.info.lastExit = {
          at: new Date(),
          reason: `replaced by pid ${String(read.pid)}`,
        };
        closeRun(state, rec, "succeeded", null);
      }
      if (lastPid !== null) rec.info.restarts += 1;
      lastPid = read.pid;
      rec.info.pid = read.pid;
      rec.info.spawnedAt = new Date();
      if (rec.run === null) openRun(state, rec);
      setState(state, rec, "running");
      emit({ state: "running", at: Date.now() });
      return;
    }
    if (rec.info.state === "exited") return;
    if (rec.info.pid !== null) {
      if (
        read.kind === "pid" &&
        read.pid === rec.info.pid &&
        pidAlive(read.pid)
      ) {
        return; // still the same live process
      }
      exit(
        read.kind === "absent"
          ? `pid file ${pidFile} is gone`
          : read.kind === "unreadable"
            ? `pid file ${pidFile} reads "${read.text}"`
            : `pid ${String(rec.info.pid)} is gone`,
      );
      return;
    }
    // Never seen alive yet.
    const failed = opts.failedEarly?.(current) ?? null;
    if (failed !== null && read.kind !== "pid") {
      // The long-lived process never appeared, and now never will.
      exit(failed);
      return;
    }
    if (opts.stillBooting(current)) return;
    exit(
      read.kind === "pid"
        ? `pid ${String(read.pid)} in ${pidFile} is not running`
        : read.kind === "unreadable"
          ? `pid file ${pidFile} reads "${read.text}"`
          : `no pid file at ${pidFile}`,
    );
  };
  // Its first read lands after an await, so `held` is assigned before
  // `judge` can run.
  const held = holdPidFile(pidFile, judge);
  // A get: judge the held read, and when nothing is alive (not seen yet, or
  // gone and still followed) ask for a fresh one — never from `judge` itself,
  // which every read runs: that would be a read loop.
  rec.observe = () => {
    judge();
    const s = rec.info.state;
    if (s === "starting" || (s === "exited" && !final)) held.refresh();
  };
  return held;
}

/** Where a detached launch's bootstrap is, for the pid-file follower. */
type Bootstrap =
  | { kind: "running" }
  /**
   * Exited after the read numbered `afterSeq` started: only a later read
   * saw what it wrote before exiting.
   */
  | { kind: "exited"; afterSeq: number; failure: string | null };

export function launchDetachedIn(
  state: DeclState,
  opts: DetachedLaunch,
): DaemonInstance {
  const rec = claimInstance(state, opts.instance, "detached", opts.pidFile);
  const emit = (t: DaemonTransition): void => opts.onState?.(t);
  let bootstrap: Bootstrap = { kind: "running" };
  emit({ state: "starting", at: Date.now() });
  openRun(state, rec);
  setState(state, rec, "starting");
  // A missing pid file is "booting" while the bootstrap runs — and until a
  // read that started after its exit lands, since an older read cannot have
  // seen what it wrote last. After that, the process it started must have
  // written one.
  const held = followPidFile(state, rec, opts.pidFile, emit, {
    stillBooting: ({ seq }) =>
      bootstrap.kind === "running" || seq <= bootstrap.afterSeq,
    failedEarly: ({ seq }) =>
      bootstrap.kind === "exited" && seq > bootstrap.afterSeq
        ? bootstrap.failure
        : null,
  });
  // A process that outlives its backend is not part of what serves: on a host
  // with a systemd user manager it runs in a scope of its own (a `daemon`
  // scope, packages/systemd-scope), never in the gateway's unit. systemd-oomd
  // kills a whole leaf cgroup, so an agent or a browser host left in the
  // gateway's unit was killed WITH the gateway, Postgres and every backend
  // (research/2026-11-19-global-oomd-serving-set.md). `systemd-run --scope`
  // execs the command: same pid, stdio and held descriptors.
  const launch = inAppScope(daemonScopeHost(), {
    argv: opts.argv,
    env: opts.env,
    kind: "daemon",
    label: `${state.spec.name}-${opts.instance ?? "default"}-${Date.now().toString(36)}`,
    description: `${PRODUCT_NAME} ${state.spec.name}${opts.instance === undefined ? "" : ` ${opts.instance}`}`,
  });
  const proc = Bun.spawn(launch.argv, {
    detached: true,
    env: launch.env,
    cwd: opts.cwd,
    // fds 0–2, then each held descriptor as 3, 4, … (`holdFds`).
    stdio: [
      "ignore",
      opts.outputFd?.fd ??
        (opts.onOutputLine === undefined ? "ignore" : "pipe"),
      opts.outputFd?.fd ??
        (opts.onOutputLine === undefined ? "ignore" : "pipe"),
      ...(opts.holdFds ?? []).map((h) => h.fd),
    ],
    onExit: (_p, code, signalCode) => {
      bootstrap = {
        kind: "exited",
        afterSeq: held.issued(),
        // A failed bootstrap: the long-lived process may never appear.
        failure:
          code === 0
            ? null
            : `bootstrap ${exitReason(code, signalCode === null ? null : String(signalCode))}`,
      };
      // Read the file again, after the exit: that read decides.
      held.refresh();
    },
  });
  const onLine = opts.onOutputLine;
  if (onLine !== undefined) {
    if (proc.stdout instanceof ReadableStream)
      pumpLines(proc.stdout, (l) => onLine(l, "stdout"));
    if (proc.stderr instanceof ReadableStream)
      pumpLines(proc.stderr, (l) => onLine(l, "stderr"));
  }
  return instanceHandle(state, rec, () => {
    // The owner tears the detached stack down (it knows how); this drops the
    // record.
    held.release();
    closeRun(state, rec, "succeeded", null);
    releaseInstance(state, rec);
    emit({ state: "stopped", at: Date.now() });
    return Promise.resolve();
  });
}

export function attachIn(
  state: DeclState,
  opts: AttachOptions,
): DaemonInstance {
  const rec = claimInstance(state, opts.instance, "attached", opts.pidFile);
  const emit = (t: DaemonTransition): void => opts.onState?.(t);
  emit({ state: "starting", at: Date.now() });
  setState(state, rec, "starting");
  // `starting` until the first read lands. Attached before the process
  // exists (the gateway writes its pid file a moment after it spawns the
  // backend), a missing file reads as starting, not as dead.
  const held = followPidFile(state, rec, opts.pidFile, emit, {
    stillBooting: ({ read }) => read.kind === "absent",
  });
  return instanceHandle(state, rec, () => {
    held.release();
    closeRun(state, rec, "succeeded", null);
    releaseInstance(state, rec);
    emit({ state: "stopped", at: Date.now() });
    return Promise.resolve();
  });
}

function instanceHandle(
  state: DeclState,
  rec: InstanceRec,
  stop: () => Promise<void>,
): DaemonInstance {
  rec.stop = stop;
  return {
    name: state.spec.name,
    instance: rec.info.instance,
    get pid() {
      rec.observe?.();
      return rec.info.pid;
    },
    get state() {
      rec.observe?.();
      return rec.info.state;
    },
    stop,
  };
}

function currentEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) env[name] = value;
  }
  return env;
}
