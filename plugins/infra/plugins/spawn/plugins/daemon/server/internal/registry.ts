import { readFileSync } from "node:fs";
import {
  RECENT_RUNS_MAX,
  type BackgroundRun,
  type BackgroundScope,
} from "@plugins/infra/plugins/background/plugins/catalog/core";

/**
 * When a daemon is started: once by its plugin as the backend boots, or only
 * when something asks for one (a release preview).
 */
export type DaemonStartedBy = "boot" | "on-demand";

/**
 * Which backends may run it. `host-singleton` is the one backend owning
 * host-wide work: main in dev, the lone backend of a compiled release.
 */
export type DaemonWhere = "every-worktree" | "main" | "host-singleton";

/**
 * What happens when an instance exits on its own.
 *
 * - `never` — it stays exited until its owner stops (or restarts) it.
 * - `backoff` — respawn after `minMs`, doubling to `maxMs`. An instance that
 *   dies within `rapidExitMs` of its spawn never got going; after
 *   `maxRapidFailures` such deaths in a row the supervisor gives up, loudly.
 *   `healthy` is what resets the counters: `ready` — the instance says so
 *   (`ctx.ready()`, a worker's ready frame); `survival` — it outlived
 *   `rapidExitMs`.
 */
export type DaemonRestart =
  | { kind: "never" }
  | {
      kind: "backoff";
      healthy: "ready" | "survival";
      minMs?: number;
      maxMs?: number;
      rapidExitMs?: number;
      maxRapidFailures?: number;
    };

export interface DaemonSpec<R extends DaemonRestart = DaemonRestart> {
  /** Stable code name, unique per process (`sentinel.sampler`). */
  name: string;
  /** One present-tense sentence a person reads: what it is and why it runs. */
  description: string;
  startedBy: DaemonStartedBy;
  where: DaemonWhere;
  restart: R;
}

/**
 * Where an instance is in its life.
 *
 * - `starting` — spawned, not yet ready (a `ready` daemon before its signal; a
 *   detached launch before its pid file appears).
 * - `running` — alive.
 * - `respawning` — died; the next spawn is scheduled.
 * - `gave-up` — died too fast too often; nothing will respawn it.
 * - `exited` — gone, and its restart policy is `never`.
 */
export type DaemonState =
  "starting" | "running" | "respawning" | "gave-up" | "exited";

/** One supervision transition, in order, as `onState` receives it. */
export type DaemonTransition =
  | { state: "starting"; at: number }
  | { state: "running"; at: number }
  | {
      state: "respawning";
      at: number;
      inMs: number;
      deaths: number;
      lastError: string | null;
    }
  | { state: "gave-up"; at: number; deaths: number; lastError: string | null }
  | { state: "exited"; at: number; lastError: string | null }
  | { state: "stopped"; at: number };

/** How an instance came to be — and so how its liveness is known. */
export type DaemonArm = "process" | "worker" | "detached" | "attached";

/** Options every start shares. */
export interface DaemonStartCommon {
  /**
   * How the catalog names this instance (a variant, a run id). Omit for a
   * daemon with one instance. A second live instance of the same key throws.
   */
  instance?: string;
  /** Every transition, starting with `starting`, ending with `stopped`. */
  onState?: (t: DaemonTransition) => void;
  /**
   * Where the supervisor's own lines go (a death, a respawn, a give-up).
   * Defaults to this process's stderr.
   */
  onLog?: (line: string) => void;
}

export interface ProcessLaunch extends DaemonStartCommon {
  /** The command; a function is called at each spawn (respawns included). */
  argv: string[] | (() => string[]);
  env?: Record<string, string | undefined>;
  cwd?: string;
  /**
   * Each stderr line, while it runs. Omitted → stderr is ignored. stdout is
   * always ignored: a daemon reports through files or channels, not a pipe
   * someone must keep draining.
   */
  onStderrLine?: (line: string) => void;
}

export interface WorkerLaunchContext {
  /** A `ready`-healthy daemon says its spawn came up: counters reset. */
  ready(): void;
}

export interface WorkerLaunch extends DaemonStartCommon {
  url: URL;
  argv?: string[];
  env?: Record<string, string>;
  /** Right after each spawn (respawns included): post the init frame here. */
  onSpawn?: (worker: Worker) => void;
  onMessage: (data: unknown, ctx: WorkerLaunchContext) => void;
  /** A worker `error` event; it is also kept as the instance's last error. */
  onError?: (message: string) => void;
  /**
   * The graceful half of `stop()` — say goodbye and wait for the ack. The
   * supervisor terminates the worker afterwards either way.
   */
  stop?: (worker: Worker) => Promise<void>;
  /** Respawn backoff bounds for this instance; a test shortens them. */
  backoff?: { minMs: number; maxMs: number };
}

/**
 * A detached start: either a bootstrap that starts the long-lived process and
 * exits (a release preview), or the long-lived process itself (an sdk agent),
 * which writes its own pid file. Either way it gets its own session and process
 * group, so a backend restart — which signals the backend's whole group — does
 * not reach it.
 */
export type DetachedLaunch = DaemonStartCommon & {
  argv: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
  /** Where the long-lived process writes its pid (first line). */
  pidFile: string;
} & (
    | {
        /** Each line the bootstrap prints, while it runs. */
        onOutputLine?: (line: string, stream: "stdout" | "stderr") => void;
        outputFd?: never;
      }
    | {
        /**
         * stdout and stderr both go to this open descriptor (a log file opened
         * for append) — for a process that outlives this backend, which no pipe
         * of ours could keep draining. The child gets its own duplicate; the
         * caller closes its copy once this returns.
         */
        outputFd: number;
        onOutputLine?: never;
      }
  );

export interface AttachOptions extends DaemonStartCommon {
  /** The pid file of a process this backend did not start but depends on. */
  pidFile: string;
}

/** A live instance: its state, and the one way to end it. */
export interface DaemonInstance {
  readonly name: string;
  readonly instance: string | null;
  /** The OS pid, when there is one (a worker is a thread: `null`). */
  readonly pid: number | null;
  readonly state: DaemonState;
  /**
   * End it: no respawn, the graceful stop (a worker's), then SIGTERM /
   * terminate, and drop it from the catalog. An `attach`ed instance is only
   * dropped — this backend did not start it, so it does not kill it.
   */
  stop(): Promise<void>;
}

export interface WorkerDaemonInstance extends DaemonInstance {
  /** Post to the current worker; a no-op between incarnations. */
  postMessage(message: unknown): void;
}

export interface DaemonDeclBase {
  readonly name: string;
  readonly _kind: "daemon";
  readonly _factory: "defineDaemon";
  readonly _doc: { label: string; detail: string };
  register(): void;
  /** Spawn a child process and supervise it. */
  spawnProcess(opts: ProcessLaunch): DaemonInstance;
  /** Spawn a Bun Worker thread and supervise it. */
  spawnWorker(opts: WorkerLaunch): WorkerDaemonInstance;
}

export interface UnsupervisedDeclExtras {
  /** Run a bootstrap that starts the process detached; follow its pid file. */
  launchDetached(opts: DetachedLaunch): DaemonInstance;
  /** Follow a process this backend did not start, by its pid file. */
  attach(opts: AttachOptions): DaemonInstance;
}

/**
 * A declared daemon. `launchDetached` / `attach` exist only on a
 * `restart: { kind: "never" }` declaration: nothing here can respawn a
 * process it did not parent.
 */
export type DaemonDecl<R extends DaemonRestart = DaemonRestart> =
  DaemonDeclBase &
    (R extends { kind: "never" } ? UnsupervisedDeclExtras : unknown);

/** How a runtime hosts daemons: where they run and who declared them. */
export interface DaemonRuntime {
  scope: BackgroundScope;
  /** Whether this process may start an instance. */
  readonly runsHere: boolean;
  /** The plugin declaring it, read inside `register()` (null when unknown). */
  declaredIn: () => string | null;
}

/** One instance, as the catalog shows it. */
export interface DaemonInstanceInfo {
  instance: string | null;
  arm: DaemonArm;
  state: DaemonState;
  pid: number | null;
  /** When it was first started (respawns keep it). */
  startedAt: Date;
  /** When the current incarnation was spawned (`null` while none is). */
  spawnedAt: Date | null;
  restarts: number;
  lastExit: { at: Date; reason: string } | null;
  pidFile: string | null;
}

/** A declaration's state in this process, read by the catalog arm. */
export interface DaemonSnapshot {
  name: string;
  description: string;
  declaredIn: string | null;
  scope: BackgroundScope;
  runsHere: boolean;
  startedBy: DaemonStartedBy;
  restart: DaemonRestart;
  instances: DaemonInstanceInfo[];
  /** Newest first, at most RECENT_RUNS_MAX. */
  recentRuns: BackgroundRun[];
  runs: number;
  failures: number;
  lastSuccessAt: Date | null;
}

export const DEFAULT_BACKOFF = {
  minMs: 1_000,
  maxMs: 30_000,
  rapidExitMs: 2_000,
  maxRapidFailures: 5,
} as const;

/** The policy with every default filled in (`null` for `never`). */
export function backoffPolicy(restart: DaemonRestart): {
  healthy: "ready" | "survival";
  minMs: number;
  maxMs: number;
  rapidExitMs: number;
  maxRapidFailures: number;
} | null {
  if (restart.kind === "never") return null;
  return {
    healthy: restart.healthy,
    minMs: restart.minMs ?? DEFAULT_BACKOFF.minMs,
    maxMs: restart.maxMs ?? DEFAULT_BACKOFF.maxMs,
    rapidExitMs: restart.rapidExitMs ?? DEFAULT_BACKOFF.rapidExitMs,
    maxRapidFailures:
      restart.maxRapidFailures ?? DEFAULT_BACKOFF.maxRapidFailures,
  };
}

// ---------------------------------------------------------------------------
// Registry

interface InstanceRec {
  key: string;
  info: DaemonInstanceInfo;
  /** The open run of the current incarnation. */
  run: BackgroundRun | null;
  /** Re-reads liveness that no event reports (pid-file arms). */
  observe: (() => void) | null;
}

interface DeclState {
  spec: DaemonSpec;
  runtime: DaemonRuntime;
  declaredIn: string | null;
  instances: Map<string, InstanceRec>;
  ring: BackgroundRun[];
  runs: number;
  failures: number;
  lastSuccessAt: Date | null;
}

// Registered declarations, per process. Bounded by the declared set.
const declarations = new Map<string, DeclState>();
const listeners = new Set<(name: string) => void>();

/**
 * Subscribe to "a declaration's catalog entry changed": an instance started,
 * changed state, or was stopped. Returns the unsubscribe. Transitions are rare
 * by construction (a respawn is at least a second apart), so nothing throttles.
 */
export function onDaemonActivity(listener: (name: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function announce(name: string): void {
  for (const l of listeners) l(name);
}

export function newDeclState(
  spec: DaemonSpec,
  runtime: DaemonRuntime,
): DeclState {
  if (spec.description.trim() === "") {
    throw new Error(
      `[daemon] ${spec.name}: description is required — one sentence saying what it is and why it runs`,
    );
  }
  return {
    spec,
    runtime,
    declaredIn: null,
    instances: new Map(),
    ring: [],
    runs: 0,
    failures: 0,
    lastSuccessAt: null,
  };
}

export function registerDecl(state: DeclState): void {
  const existing = declarations.get(state.spec.name);
  if (existing === state) return;
  if (existing !== undefined) {
    throw new Error(`[daemon] duplicate daemon name: ${state.spec.name}`);
  }
  state.declaredIn = state.runtime.declaredIn();
  declarations.set(state.spec.name, state);
}

/**
 * Claim an instance slot: throws if the declaration was never registered (it
 * would run without appearing in the catalog), if it must not run here, or if
 * the key is already live.
 */
export function claimInstance(
  state: DeclState,
  instance: string | undefined,
  arm: DaemonArm,
  pidFile: string | null,
): InstanceRec {
  const { name } = state.spec;
  if (declarations.get(name) !== state) {
    throw new Error(
      `[daemon] ${name} started before it was registered — mount it in its plugin's \`register: [...]\` so it appears in Background activity`,
    );
  }
  if (!state.runtime.runsHere) {
    throw new Error(
      `[daemon] ${name} is declared \`where: "${state.spec.where}"\` and cannot start in this backend`,
    );
  }
  const key = instance ?? "";
  if (state.instances.has(key)) {
    throw new Error(
      `[daemon] ${name}${instance === undefined ? "" : ` (${instance})`} is already running — stop it first`,
    );
  }
  const rec: InstanceRec = {
    key,
    info: {
      instance: instance ?? null,
      arm,
      state: "starting",
      pid: null,
      startedAt: new Date(),
      spawnedAt: null,
      restarts: 0,
      lastExit: null,
      pidFile,
    },
    run: null,
    observe: null,
  };
  state.instances.set(key, rec);
  return rec;
}

export function releaseInstance(state: DeclState, rec: InstanceRec): void {
  if (state.instances.get(rec.key) === rec) state.instances.delete(rec.key);
  announce(state.spec.name);
}

/** An incarnation began: open its run. */
export function openRun(state: DeclState, rec: InstanceRec): void {
  const run: BackgroundRun = {
    startedAt: new Date().toISOString(),
    finishedAt: null,
    outcome: "running",
    durationMs: null,
    error: null,
  };
  rec.run = run;
  state.ring.unshift(run);
  if (state.ring.length > RECENT_RUNS_MAX) state.ring.length = RECENT_RUNS_MAX;
  state.runs += 1;
}

/**
 * The incarnation ended. `succeeded` — it was stopped on purpose; `failed` —
 * it exited on its own (a daemon has no successful way to end by itself).
 */
export function closeRun(
  state: DeclState,
  rec: InstanceRec,
  outcome: "succeeded" | "failed",
  error: string | null,
): void {
  const run = rec.run;
  if (run === null) return;
  rec.run = null;
  const now = new Date();
  run.finishedAt = now.toISOString();
  run.outcome = outcome;
  run.durationMs = now.getTime() - new Date(run.startedAt).getTime();
  run.error = error;
  if (outcome === "failed") state.failures += 1;
  else state.lastSuccessAt = now;
}

export function setState(
  state: DeclState,
  rec: InstanceRec,
  next: DaemonState,
): void {
  rec.info.state = next;
  announce(state.spec.name);
}

/** Every registered declaration's state in this process. */
export function listDaemons(): DaemonSnapshot[] {
  return [...declarations.values()].map((s) => {
    for (const rec of s.instances.values()) rec.observe?.();
    return {
      name: s.spec.name,
      description: s.spec.description,
      declaredIn: s.declaredIn,
      scope: s.runtime.scope,
      runsHere: s.runtime.runsHere,
      startedBy: s.spec.startedBy,
      restart: s.spec.restart,
      instances: [...s.instances.values()].map((r) => ({ ...r.info })),
      recentRuns: s.ring.map((r) => ({ ...r })),
      runs: s.runs,
      failures: s.failures,
      lastSuccessAt: s.lastSuccessAt,
    };
  });
}

/** One declaration's recent runs, newest first. Throws on an unknown name. */
export async function daemonRecentRuns(name: string): Promise<BackgroundRun[]> {
  const s = declarations.get(name);
  if (s === undefined) {
    throw new Error(`[daemon] no daemon named "${name}" is registered`);
  }
  for (const rec of s.instances.values()) rec.observe?.();
  return s.ring.map((r) => ({ ...r }));
}

// ---------------------------------------------------------------------------
// Pid files

/**
 * The pid on a pid file's first line: `absent` when there is no file (yet),
 * `unreadable` when its first line is not a pid.
 */
export type PidFileRead =
  | { kind: "pid"; pid: number }
  | { kind: "absent" }
  | { kind: "unreadable"; text: string };

export function readPidFile(path: string): PidFileRead {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "absent" };
    }
    throw err;
  }
  const first = raw.split("\n", 1)[0]?.trim() ?? "";
  const pid = Number.parseInt(first, 10);
  return Number.isInteger(pid) && pid > 0
    ? { kind: "pid", pid }
    : { kind: "unreadable", text: first };
}

/** Whether a process exists (EPERM: it does, we just may not signal it). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") return true;
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw err;
  }
}
