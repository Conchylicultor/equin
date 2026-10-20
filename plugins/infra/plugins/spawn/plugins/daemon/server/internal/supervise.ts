import {
  backoffPolicy,
  claimInstance,
  closeRun,
  openRun,
  pidAlive,
  readPidFile,
  releaseInstance,
  setState,
  type AttachOptions,
  type DaemonInstance,
  type DaemonStartCommon,
  type DaemonTransition,
  type PidFileRead,
  type DetachedLaunch,
  type ProcessLaunch,
  type WorkerDaemonInstance,
  type WorkerLaunch,
} from "./registry";
import type { newDeclState } from "./registry";

type DeclState = ReturnType<typeof newDeclState>;

/** How long a stopped child gets after SIGTERM before SIGKILL. */
const STOP_KILL_AFTER_MS = 5_000;
type InstanceRec = ReturnType<typeof claimInstance>;

/** What one incarnation looks like to the supervisor, whatever it runs on. */
interface Incarnation {
  pid: number | null;
  /** Deliberate end: graceful step (if any), then kill / terminate. */
  stop(): Promise<void>;
}

/**
 * Spawn one incarnation. `onExit` is called exactly once when it ends, with a
 * reason a person reads ("exited with code 1", the worker's error).
 */
type Spawner = (hooks: {
  onExit: (reason: string) => void;
  ready: () => void;
}) => Incarnation;

function label(state: DeclState, rec: InstanceRec): string {
  const i = rec.info.instance;
  return `${state.spec.name}${i === null ? "" : ` (${i})`}`;
}

function defaultLog(line: string): void {
  console.error(`[daemon] ${line}`);
}

/**
 * The ONE supervision loop: spawn, watch for the exit, respawn with a doubling
 * backoff, and give up loudly after too many rapid deaths. Both arms with an
 * exit event (process, worker) run through it, so the policy cannot drift
 * between them.
 */
function supervise(
  state: DeclState,
  rec: InstanceRec,
  common: DaemonStartCommon,
  spawn: Spawner,
  backoffOverride?: { minMs: number; maxMs: number },
): { stop(): Promise<void> } {
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
    const incarnation = spawn({
      onExit: (reason) => {
        if (ended) return;
        ended = true;
        if (current === incarnation) current = null;
        onExit(reason);
      },
      ready: () => {
        if (ended || readyThisSpawn) return;
        readyThisSpawn = true;
        markHealthy();
        setState(state, rec, "running");
        emit({ state: "running", at: Date.now() });
      },
    });
    current = incarnation;
    rec.info.pid = incarnation.pid;
    rec.info.spawnedAt = new Date(spawnedAt);
    openRun(state, rec);
    // A survival-healthy (or never-restarting) daemon is running once spawned;
    // a ready-healthy one waits for its signal.
    if (policy?.healthy !== "ready") {
      setState(state, rec, "running");
      if (rec.info.restarts === 0) emit({ state: "running", at: Date.now() });
    } else {
      // Still `starting` (first spawn) or `respawning` until ready().
      setState(state, rec, rec.info.restarts === 0 ? "starting" : "respawning");
    }
  };

  const onExit = (reason: string): void => {
    rec.info.pid = null;
    rec.info.spawnedAt = null;
    rec.info.lastExit = { at: new Date(), reason };
    if (stopping) return; // stop() closes the run itself
    lastError = reason;
    closeRun(state, rec, "failed", reason);
    if (policy === null) {
      setState(state, rec, "exited");
      emit({ state: "exited", at: Date.now(), lastError });
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
    if (rapidFailures >= policy.maxRapidFailures) {
      setState(state, rec, "gave-up");
      emit({ state: "gave-up", at: Date.now(), deaths, lastError });
      log(
        `${label(state, rec)} died ${String(policy.maxRapidFailures)} times within ${String(policy.rapidExitMs)}ms of spawn — giving up. It is NOT running. Last error: ${reason}`,
      );
      return;
    }
    const inMs = backoffMs;
    setState(state, rec, "respawning");
    emit({ state: "respawning", at: Date.now(), inMs, deaths, lastError });
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
 * ends when the child exits and the stream closes.
 */
function pumpLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): void {
  // eslint-disable-next-line detached-work-safety/no-untracked-detached-work -- drains a long-lived child's output for its whole lifetime: I/O-bound, not main-thread CPU; a bg span would stay open as long as the child lives.
  void (async () => {
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
): DaemonInstance {
  const rec = claimInstance(state, opts.instance, "process", null);
  const sup = supervise(state, rec, opts, ({ onExit }) => {
    const argv = typeof opts.argv === "function" ? opts.argv() : opts.argv;
    const proc = Bun.spawn(argv, {
      cwd: opts.cwd,
      env: opts.env,
      stdin: "ignore",
      stdout: "ignore",
      stderr: opts.onStderrLine === undefined ? "ignore" : "pipe",
      onExit: (_p, code, signalCode) => {
        onExit(
          exitReason(code, signalCode === null ? null : String(signalCode)),
        );
      },
    });
    const onLine = opts.onStderrLine;
    if (onLine !== undefined && proc.stderr instanceof ReadableStream) {
      pumpLines(proc.stderr, onLine);
    }
    return {
      pid: proc.pid,
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
  return instanceHandle(state, rec, sup.stop);
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
      const w = new Worker(opts.url, {
        ...(opts.argv ? { argv: opts.argv } : {}),
        ...(opts.env ? { env: opts.env } : {}),
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
        onExit(lastError ?? "worker exited");
      });
      opts.onSpawn?.(w);
      return {
        pid: null,
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
    postMessage(message: unknown) {
      worker?.postMessage(message);
    },
  };
}

/**
 * Pid-file liveness, read when the catalog asks (no event exists for a
 * process this backend is not the parent of, and nothing polls). Each pid it
 * sees is an incarnation: a new pid is a restart, a dead one an exit.
 *
 * A detached launch's exit is final (its owner relaunches it as a new
 * instance); an attached process may come back under a new pid (launchd
 * restarting the gateway), so it is followed past an exit.
 */
function followPidFile(
  state: DeclState,
  rec: InstanceRec,
  pidFile: string,
  emit: (t: DaemonTransition) => void,
  /** Whether a not-yet-seen process may still be coming up. */
  stillBooting: (read: PidFileRead) => boolean,
): () => void {
  let lastPid: number | null = null;
  const exit = (reason: string): void => {
    rec.info.lastExit = { at: new Date(), reason };
    rec.info.pid = null;
    rec.info.spawnedAt = null;
    if (rec.run === null) openRun(state, rec);
    closeRun(state, rec, "failed", reason);
    setState(state, rec, "exited");
    emit({ state: "exited", at: Date.now(), lastError: reason });
  };
  return () => {
    const final = rec.info.arm === "detached";
    if (final && rec.info.state === "exited") return;
    const read = readPidFile(pidFile);
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
    if (stillBooting(read)) return;
    exit(
      read.kind === "pid"
        ? `pid ${String(read.pid)} in ${pidFile} is not running`
        : read.kind === "unreadable"
          ? `pid file ${pidFile} reads "${read.text}"`
          : `no pid file at ${pidFile}`,
    );
  };
}

export function launchDetachedIn(
  state: DeclState,
  opts: DetachedLaunch,
): DaemonInstance {
  const rec = claimInstance(state, opts.instance, "detached", opts.pidFile);
  const emit = (t: DaemonTransition): void => opts.onState?.(t);
  let bootstrapRunning = true;
  const stdio =
    opts.outputFd !== undefined
      ? opts.outputFd
      : opts.onOutputLine === undefined
        ? "ignore"
        : "pipe";
  const proc = Bun.spawn(opts.argv, {
    detached: true,
    env: opts.env,
    cwd: opts.cwd,
    stdin: "ignore",
    stdout: stdio,
    stderr: stdio,
    onExit: (_p, code, signalCode) => {
      bootstrapRunning = false;
      if (code !== 0) {
        const reason = `bootstrap ${exitReason(code, signalCode === null ? null : String(signalCode))}`;
        // A failed bootstrap: the long-lived process may never appear.
        if (rec.info.pid === null && readPidFile(opts.pidFile).kind !== "pid") {
          rec.info.lastExit = { at: new Date(), reason };
          if (rec.run === null) openRun(state, rec);
          closeRun(state, rec, "failed", reason);
          setState(state, rec, "exited");
          emit({ state: "exited", at: Date.now(), lastError: reason });
          return;
        }
      }
      rec.observe?.();
    },
  });
  const onLine = opts.onOutputLine;
  if (onLine !== undefined) {
    if (proc.stdout instanceof ReadableStream)
      pumpLines(proc.stdout, (l) => onLine(l, "stdout"));
    if (proc.stderr instanceof ReadableStream)
      pumpLines(proc.stderr, (l) => onLine(l, "stderr"));
  }
  emit({ state: "starting", at: Date.now() });
  openRun(state, rec);
  setState(state, rec, "starting");
  // A missing pid file is "booting" while the bootstrap runs; after it
  // exits cleanly the process it started must have written one.
  rec.observe = followPidFile(
    state,
    rec,
    opts.pidFile,
    emit,
    () => bootstrapRunning,
  );
  return instanceHandle(state, rec, () => {
    // The owner tears the detached stack down (it knows how); this drops the
    // record.
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
  // Attached before the process exists (the gateway writes its pid file a
  // moment after it spawns the backend) reads as starting, not as dead.
  rec.observe = followPidFile(
    state,
    rec,
    opts.pidFile,
    emit,
    (read) => read.kind === "absent",
  );
  rec.observe();
  return instanceHandle(state, rec, () => {
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
