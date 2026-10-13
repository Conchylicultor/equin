import type * as parcel from "@parcel/watcher";
import {
  RECENT_RUNS_MAX,
  type BackgroundRun,
  type BackgroundScope,
} from "@plugins/infra/plugins/background/plugins/catalog/core";
import {
  createFileWatcher,
  watcherBackend,
  type FileWatcher,
  type FileWatcherOptions,
  type WatchReaction,
  type WatchReconcile,
  type WatcherBackend,
} from "./engine";

/** One filesystem change, as the engine delivers it. */
export type FileChangeEvent = parcel.Event;

/**
 * What an author declares, once, at module scope: the watcher's identity and
 * its static policy — the same for every instance it opens.
 */
export interface FileWatcherSpec {
  /** Stable code name, unique per process (`config_v2.config-files`). */
  name: string;
  /** One present-tense sentence a person reads: what it notices and why. */
  description: string;
  /** Only report paths with one of these extensions (`[".jsonc"]`). */
  extensions?: string[];
  /** Globs / paths parcel ignores. */
  ignore?: string[];
  /** Batch changes for this long (default 100 ms; 0 = dispatch each event). */
  debounceMs?: number;
  /** Flush a batch at least this often while changes keep coming (default 1 s). */
  ceilingMs?: number;
  /**
   * Report every write to a file another process holds open (kqueue on
   * darwin — one descriptor per file, dirs capped at
   * `WRITES_WHILE_OPEN_MAX_ENTRIES`). See the engine's `writesWhileOpen`.
   */
  writesWhileOpen?: boolean;
  /**
   * Re-derive state a dropped fsevent could have missed, every this many ms.
   * Declaring it makes `onReconcile` REQUIRED on every `start()`; leaving it
   * out makes `onReconcile` a type error there. A tick is not a change — it
   * never reaches `onChange`.
   */
  reconcileMs?: number;
}

/** Per-instance input to `start()`: what to watch and what to call. */
export type FileWatcherStartOptions<Reconciles extends boolean> = {
  /** The directories this instance watches (recursively). */
  dirs: string[];
  /**
   * How the catalog names this instance (`conv-123`, a worktree name). Omit
   * for a watcher that only ever has one instance.
   */
  label?: string;
  /**
   * The filesystem said these paths moved. Return the work's promise: one
   * reaction runs at a time, and batches landing meanwhile fold into one
   * trailing call (see {@link WatchReaction}).
   */
  onChange: WatchReaction<FileChangeEvent>;
} & (Reconciles extends true
  ? {
      /** The declared reconcile tick came round. Coalesced like `onChange`. */
      onReconcile: WatchReconcile;
    }
  : { onReconcile?: never });

/** Whether a spec declares a reconcile (`reconcileMs` present). */
export type ReconcilesOf<R> = R extends number ? true : false;

/** A declared watcher: mount it in `register: [...]`, then `start()` instances. */
export interface FileWatcherDecl<Reconciles extends boolean = boolean> {
  readonly name: string;
  readonly _kind: "file-watcher";
  readonly _factory: "defineFileWatcher";
  readonly _doc: { label: string; detail: string };
  register(): void;
  /**
   * Open one instance. Throws if the declaration was never registered (it
   * would watch without appearing in the catalog) or if its runtime says it
   * must not run here (`mainOnly` off main).
   */
  start(opts: FileWatcherStartOptions<Reconciles>): Promise<FileWatcher>;
}

/** How a runtime hosts watchers: where they run and who declared them. */
export interface FileWatcherRuntime {
  scope: BackgroundScope;
  /** Whether this process may open an instance. */
  runsHere: boolean;
  /** The plugin declaring it, read inside `register()` (null when unknown). */
  declaredIn: () => string | null;
  /**
   * After a failed dispatch is recorded: make it loud. The server rethrows —
   * the engine's span rejects into an unhandled rejection the reports plugin
   * files, exactly as before the run was recorded.
   */
  onFailure: (name: string, err: unknown) => void;
}

/** One open instance, as the catalog shows it. */
export interface FileWatcherInstanceInfo {
  label: string | null;
  dirs: string[];
  openedAt: Date;
  /**
   * Change batches that landed while a reaction was running and were folded
   * into the one pending reaction instead of costing a run of their own.
   */
  foldedBatches: number;
}

/** The latest batch `onChange` was handed. */
export interface FileWatcherBatch {
  at: Date;
  eventCount: number;
  /** The first few paths of the batch, at most {@link BATCH_SAMPLE_MAX}. */
  samplePaths: string[];
}

/** A declaration's state in this process, read by the catalog arm. */
export interface FileWatcherSnapshot {
  name: string;
  description: string;
  declaredIn: string | null;
  scope: BackgroundScope;
  runsHere: boolean;
  backend: WatcherBackend;
  reconcileMs: number | null;
  instances: FileWatcherInstanceInfo[];
  lastBatch: FileWatcherBatch | null;
  /** Newest first, at most RECENT_RUNS_MAX. */
  recentRuns: BackgroundRun[];
  runs: number;
  failures: number;
  lastSuccessAt: Date | null;
}

export const BATCH_SAMPLE_MAX = 5;

interface DeclState {
  spec: FileWatcherSpec;
  runtime: FileWatcherRuntime;
  declaredIn: string | null;
  instances: Map<number, FileWatcherInstanceInfo>;
  lastBatch: FileWatcherBatch | null;
  ring: BackgroundRun[];
  runs: number;
  failures: number;
  lastSuccessAt: Date | null;
  lastNotifiedAt: number;
}

// Registered declarations, per process. Bounded by the declared set.
const declarations = new Map<string, DeclState>();
const listeners = new Set<(name: string) => void>();
let nextInstanceId = 1;

// A watcher on a hot directory (the transcript watcher dispatches every event)
// must not push the catalog per event: a change is announced when a run's
// outcome differs from the previous one, when an instance opens or closes, and
// otherwise at most once a minute per declaration — the timer's rule.
const QUIET_NOTIFY_MS = 60_000;

/**
 * Subscribe to "a declaration's catalog entry changed" (an instance opened or
 * closed, a run's outcome flipped, or a quiet minute of runs passed). Returns
 * the unsubscribe.
 */
export function onWatcherActivity(
  listener: (name: string) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function announce(name: string): void {
  for (const l of listeners) l(name);
}

export function defineFileWatcherIn<R extends number | undefined = undefined>(
  spec: FileWatcherSpec & { reconcileMs?: R },
  runtime: FileWatcherRuntime,
): FileWatcherDecl<ReconcilesOf<R>> {
  if (spec.description.trim() === "") {
    throw new Error(
      `[file-watcher] ${spec.name}: description is required — one sentence saying what it notices and why`,
    );
  }
  if (spec.reconcileMs !== undefined && !(spec.reconcileMs > 0)) {
    throw new Error(`[file-watcher] ${spec.name}: reconcileMs must be > 0`);
  }
  const state: DeclState = {
    spec,
    runtime,
    declaredIn: null,
    instances: new Map(),
    lastBatch: null,
    ring: [],
    runs: 0,
    failures: 0,
    lastSuccessAt: null,
    lastNotifiedAt: 0,
  };

  return {
    name: spec.name,
    _kind: "file-watcher",
    _factory: "defineFileWatcher",
    _doc: { label: spec.name, detail: spec.description },
    register() {
      if (declarations.has(spec.name)) {
        throw new Error(`[file-watcher] duplicate watcher name: ${spec.name}`);
      }
      state.declaredIn = runtime.declaredIn();
      declarations.set(spec.name, state);
    },
    async start(startOpts) {
      // One reading of the options whatever the declaration's reconcile arm:
      // the conditional type has done its job at the call site.
      const opts = startOpts as FileWatcherStartOptions<boolean>;
      if (declarations.get(spec.name) !== state) {
        throw new Error(
          `[file-watcher] ${spec.name} started before it was registered — mount it in its plugin's \`register: [...]\` so it appears in Background activity`,
        );
      }
      if (!runtime.runsHere) {
        throw new Error(
          `[file-watcher] ${spec.name} is declared main-only and cannot start in this backend`,
        );
      }
      const { onChange } = opts;
      const { onReconcile } = opts;
      const common = {
        dirs: opts.dirs,
        name: spec.name,
        extensions: spec.extensions,
        ignore: spec.ignore,
        debounceMs: spec.debounceMs,
        ceilingMs: spec.ceilingMs,
        writesWhileOpen: spec.writesWhileOpen,
        onChange: (events: FileChangeEvent[]) => {
          noteBatch(state, events);
          return dispatch(state, () => onChange(events));
        },
      };
      const engineOpts: FileWatcherOptions =
        onReconcile !== undefined && spec.reconcileMs !== undefined
          ? {
              ...common,
              reconcileMs: spec.reconcileMs,
              onReconcile: () => dispatch(state, onReconcile),
            }
          : common;
      const watcher = await createFileWatcher(engineOpts);

      const id = nextInstanceId++;
      const info = {
        label: opts.label ?? null,
        dirs: [...opts.dirs],
        openedAt: new Date(),
      };
      state.instances.set(id, {
        ...info,
        get foldedBatches() {
          return watcher.folded();
        },
      });
      announce(spec.name);
      let stopped = false;
      return {
        folded: () => watcher.folded(),
        async stop() {
          if (!stopped) {
            stopped = true;
            state.instances.delete(id);
            announce(spec.name);
          }
          await watcher.stop();
        },
      };
    },
  };
}

function noteBatch(state: DeclState, events: FileChangeEvent[]): void {
  const samplePaths: string[] = [];
  for (const e of events) {
    if (samplePaths.length >= BATCH_SAMPLE_MAX) break;
    samplePaths.push(e.path);
  }
  state.lastBatch = { at: new Date(), eventCount: events.length, samplePaths };
}

/**
 * Run one handler dispatch as a recorded run. A handler that returns a promise
 * is timed until it settles — and that promise is handed back, so the engine's
 * coalescer holds the next batch until it does. A throw (sync or async) is
 * recorded as failed, then handed to the runtime's `onFailure` (the server
 * rethrows it).
 */
function dispatch(
  state: DeclState,
  handler: () => void | Promise<unknown>,
): void | Promise<void> {
  const startedAt = new Date();
  const t0 = performance.now();
  const finish = (error: unknown, failed: boolean): void => {
    record(state, {
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      outcome: failed ? "failed" : "succeeded",
      durationMs: Math.round((performance.now() - t0) * 10) / 10,
      error: failed ? errorText(error) : null,
    });
  };
  let result: unknown;
  try {
    result = handler();
  } catch (err) {
    finish(err, true);
    state.runtime.onFailure(state.spec.name, err);
    return;
  }
  if (isThenable(result)) {
    // The handler returned async work; its settling is the run's end. On the
    // server `onFailure` rethrows into the returned chain, which the engine's
    // coalescer surfaces as the same unhandled rejection it was before.
    return Promise.resolve(
      result.then(
        () => finish(null, false),
        (err: unknown) => {
          finish(err, true);
          state.runtime.onFailure(state.spec.name, err);
        },
      ),
    );
  }
  finish(null, false);
}

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { then?: unknown }).then === "function"
  );
}

function record(state: DeclState, run: BackgroundRun): void {
  const previous = state.ring[0];
  state.ring.unshift(run);
  if (state.ring.length > RECENT_RUNS_MAX) state.ring.length = RECENT_RUNS_MAX;
  state.runs += 1;
  if (run.outcome === "failed") state.failures += 1;
  else state.lastSuccessAt = new Date(run.finishedAt ?? run.startedAt);
  const now = Date.now();
  if (
    previous === undefined ||
    previous.outcome !== run.outcome ||
    now - state.lastNotifiedAt >= QUIET_NOTIFY_MS
  ) {
    state.lastNotifiedAt = now;
    announce(state.spec.name);
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Every registered declaration's state in this process. */
export function listFileWatchers(): FileWatcherSnapshot[] {
  return [...declarations.values()].map((s) => ({
    name: s.spec.name,
    description: s.spec.description,
    declaredIn: s.declaredIn,
    scope: s.runtime.scope,
    runsHere: s.runtime.runsHere,
    backend: watcherBackend(s.spec.writesWhileOpen ?? false),
    reconcileMs: s.spec.reconcileMs ?? null,
    // Spread: a snapshot reads each instance's live fold count now.
    instances: [...s.instances.values()].map((i) => ({ ...i })),
    lastBatch: s.lastBatch,
    recentRuns: [...s.ring],
    runs: s.runs,
    failures: s.failures,
    lastSuccessAt: s.lastSuccessAt,
  }));
}

/** One declaration's recent runs, newest first. Throws on an unknown name. */
export async function fileWatcherRecentRuns(
  name: string,
): Promise<BackgroundRun[]> {
  const s = declarations.get(name);
  if (s === undefined) {
    throw new Error(`[file-watcher] no watcher named "${name}" is registered`);
  }
  return [...s.ring];
}
