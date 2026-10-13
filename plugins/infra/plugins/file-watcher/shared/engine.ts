import type * as parcel from "@parcel/watcher";
import { readdirSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { createCoalescer } from "@plugins/packages/plugins/coalesce/core";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
// Pure-JS wrapper: this import loads NO native code — `wrapper.js` only defines
// functions that close over a `binding` passed in at call time. Safe to import
// at module top-level (the native `.node` addon is still loaded lazily below).
import { createWrapper } from "@parcel/watcher/wrapper";

// `@parcel/watcher` is loaded LAZILY (dynamic import inside createFileWatcher),
// never at module top-level. It pulls in a native `.node` addon that a static
// import would evaluate the instant ANY module transitively imports this file —
// including barrels (e.g. config_v2/server) that merely re-export an unrelated
// symbol. In a `bun build`/`--compile` bundle that native load throws (addons
// aren't bundleable), and the throw aborts the importing barrel's module-init
// PART-WAY, leaving its other exports (e.g. `ConfigV2`) undefined — which then
// surfaces far away as "ConfigV2.Register is undefined". Deferring the load to
// the point a watcher is actually started keeps the import side-effect-free, so
// a release that never starts a watcher never touches the addon, and one that
// does fails loudly at the call site (not during an unrelated barrel's init).
//
// In a self-contained release `bun --compile` cannot embed the native addon, so
// the launcher vendors it on disk and points `SINGULARITY_PARCEL_WATCHER_NODE`
// at the absolute path of the `watcher.node` binding. When that env var is set,
// `getParcelWatcher()` dlopens the vendored binding directly and wraps it with
// parcel's own `createWrapper`, yielding the identical public API. This single
// loader is the only sanctioned entry point for `@parcel/watcher`; all consumers
// must route through it so the release vendoring path is honored.
/**
 * parcel's options as its binding really accepts them. The published
 * `BackendType` leaves out `"kqueue"`, but the darwin binding compiles that
 * backend in and `subscribe` honours it (measured: one event per append to a
 * file held open, where `fs-events` reports only the close). Corrected here, at
 * the one sanctioned loader, rather than cast at a call site.
 */
type ParcelOptions = Omit<parcel.Options, "backend"> & {
  backend?: parcel.BackendType | "kqueue";
};

/** The `@parcel/watcher` API with {@link ParcelOptions} on `subscribe`. */
export type ParcelWatcherApi = Omit<typeof parcel, "subscribe"> & {
  subscribe(
    dir: string,
    fn: parcel.SubscribeCallback,
    opts?: ParcelOptions,
  ): Promise<parcel.AsyncSubscription>;
};

let parcelWatcherPromise: Promise<ParcelWatcherApi> | null = null;
export function getParcelWatcher(): Promise<ParcelWatcherApi> {
  parcelWatcherPromise ??= (async () => {
    const nodePath = process.env.SINGULARITY_PARCEL_WATCHER_NODE;
    if (nodePath) {
      // Release: the native addon isn't bundled into the compiled binary.
      // dlopen the vendored binding from disk and wrap it with parcel's own
      // wrapper, yielding the identical public API.
      const { createRequire } = await import("node:module");
      const requireFn = createRequire(import.meta.url);
      const binding = requireFn(nodePath); // absolute path → no base-dir resolution needed
      return createWrapper(binding);
    }
    return import("@parcel/watcher"); // dev / non-compiled: unchanged
  })();
  return parcelWatcherPromise;
}

/**
 * What a watch calls with a batch of changes. RETURN the work's promise (never
 * detach it with `void`): the watch runs at most one reaction at a time per
 * subscriber and folds every batch that lands meanwhile into ONE trailing call
 * (`packages/coalesce`), so a fast-changing folder against slow work stays
 * bounded — one running plus one pending — and the last batch is always
 * answered by a run that started after it. A sync reaction (`notify()`) runs
 * inline, as before. `watcher-safety/no-detached-watch-reaction` rejects the
 * detached spelling.
 */
export type WatchReaction<E> = (events: E[]) => void | Promise<unknown>;

/** A reconcile tick's reaction — coalesced like {@link WatchReaction}. */
export type WatchReconcile = () => void | Promise<unknown>;

interface FileWatcherBaseOptions {
  dirs: string[];
  onChange: WatchReaction<parcel.Event>;
  debounceMs?: number;
  ceilingMs?: number;
  extensions?: string[];
  ignore?: string[];
  /**
   * Report every write to a file that another process still holds open — not
   * only the moment it closes it.
   *
   * macOS FSEvents, parcel's default backend there, reports a content change
   * when the writer CLOSES its descriptor, not on each `write(2)`. A long-lived
   * writer (a detached child whose stdout is a file) therefore produces one
   * event at open and one at exit, and nothing in between. `true` selects
   * parcel's kqueue backend on darwin, whose `EVFILT_VNODE` fires per write;
   * inotify (Linux) already reports every write, so elsewhere it changes nothing.
   *
   * The cost is why this is opt-in: kqueue holds one descriptor per file under
   * each watched dir, for as long as the watcher lives. Only point it at a small
   * directory with a known bound — {@link WRITES_WHILE_OPEN_MAX_ENTRIES} is
   * enforced at subscribe time.
   */
  writesWhileOpen?: boolean;
  /**
   * Label for the `bg` span each dispatch (`onChange` / `onReconcile`) runs
   * under, so a watcher callback's synchronous main-thread cost is attributed to
   * `watch:<name>` in the profiler instead of vanishing. Defaults to the first
   * watched dir's basename.
   */
  name?: string;
}

/**
 * The periodic re-check, which EXISTS ONLY when its own callback is supplied.
 *
 * A reconcile tick is not a change — nothing on disk moved, the timer merely
 * came round. It used to fall back to `onChange([])`, so every consumer that
 * read no events (the common shape: `onChange: () => rebuild()`) was told
 * "something changed" every 30s forever. The prototypes gallery cache-busted its
 * iframes on that tick and reloaded every open mock, losing whatever state the
 * author had built up on screen.
 *
 * So the two signals are now different callbacks, and the tick has no spelling
 * that reaches `onChange`: pass `onReconcile` and get a timer, pass nothing and
 * get none. `reconcileMs` without `onReconcile` is a type error rather than a
 * silently dead knob.
 */
type FileWatcherReconcileOptions =
  | {
      /** Called on the timer to re-derive state a dropped fsevent could have missed. */
      onReconcile: WatchReconcile;
      /** How often to reconcile. Default 30s. */
      reconcileMs?: number;
    }
  | { onReconcile?: undefined; reconcileMs?: undefined };

export type FileWatcherOptions = FileWatcherBaseOptions &
  FileWatcherReconcileOptions;

/**
 * The most entries a `writesWhileOpen` dir may hold when the watcher starts.
 * kqueue costs one descriptor per entry, so a watcher pointed at a real tree
 * must fail at the call site rather than exhaust the process's descriptors.
 */
export const WRITES_WHILE_OPEN_MAX_ENTRIES = 5_000;

/**
 * Throw if `dir` holds more than {@link WRITES_WHILE_OPEN_MAX_ENTRIES} entries,
 * counted recursively. Stops walking at the first entry past the ceiling, so a
 * huge tree costs no more than the ceiling to reject.
 */
function assertKqueueSized(dir: string): void {
  let count = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      count += 1;
      if (count > WRITES_WHILE_OPEN_MAX_ENTRIES) {
        throw new Error(
          `[file-watcher] writesWhileOpen on ${dir}: more than ` +
            `${WRITES_WHILE_OPEN_MAX_ENTRIES} entries. The kqueue backend holds ` +
            `one descriptor per file, so this option is only for small, bounded ` +
            `directories.`,
        );
      }
      if (entry.isDirectory()) stack.push(join(current, entry.name));
    }
  }
}

export interface FileWatcher {
  stop(): Promise<void>;
  /** Batches folded into a pending reaction instead of costing a run. */
  folded(): number;
}

/**
 * The native backend a watcher runs on, as parcel picks it for this platform:
 * FSEvents on darwin (kqueue when `writesWhileOpen`), inotify on Linux,
 * ReadDirectoryChangesW on Windows, and parcel's own default elsewhere. The one
 * statement of that choice — the engine subscribes with it and the Background
 * activity catalog reports it.
 */
export type WatcherBackend =
  "fs-events" | "kqueue" | "inotify" | "windows" | "platform-default";

export function watcherBackend(writesWhileOpen: boolean): WatcherBackend {
  const platform = process.platform;
  if (platform === "darwin") return writesWhileOpen ? "kqueue" : "fs-events";
  if (platform === "linux") return "inotify";
  if (platform === "win32") return "windows";
  return "platform-default";
}

export async function createFileWatcher(
  opts: FileWatcherOptions,
): Promise<FileWatcher> {
  const {
    dirs,
    onChange,
    onReconcile,
    debounceMs = 100,
    ceilingMs = 1000,
    reconcileMs = 30_000,
    extensions,
    ignore,
    writesWhileOpen = false,
    name = basename(dirs[0] ?? "file-watcher"),
  } = opts;

  const subscriptions: parcel.AsyncSubscription[] = [];
  let pending: parcel.Event[] = [];
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let ceilingTimer: ReturnType<typeof setTimeout> | null = null;
  let lastFlushAt = 0;
  let reconcileTimer: ReturnType<typeof setInterval> | null = null;
  // One reaction at a time; batches landing mid-run fold into one trailing
  // call. The `bg` span covers the reaction's awaited work, not only its
  // synchronous body.
  const changes = createCoalescer<parcel.Event>({
    run: (events) => runTracked(`watch:${name}`, () => onChange(events)),
  });
  const reconciles =
    onReconcile === undefined
      ? null
      : createCoalescer({
          run: () => runTracked(`watch:${name}:reconcile`, () => onReconcile()),
        });

  function flush(): void {
    lastFlushAt = Date.now();
    if (ceilingTimer) {
      clearTimeout(ceilingTimer);
      ceilingTimer = null;
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    const events = pending;
    pending = [];
    changes.trigger(events);
  }

  function schedule(): void {
    if (debounceTimer) return;
    const since = Date.now() - lastFlushAt;
    const delay =
      since >= ceilingMs ? debounceMs : Math.min(debounceMs, ceilingMs - since);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      flush();
    }, delay);

    if (!ceilingTimer) {
      ceilingTimer = setTimeout(() => {
        ceilingTimer = null;
        if (debounceTimer) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
          flush();
        }
      }, ceilingMs);
    }
  }

  const useKqueue = watcherBackend(writesWhileOpen) === "kqueue";
  const parcelOptions: ParcelOptions | undefined =
    ignore || useKqueue
      ? {
          ...(ignore ? { ignore } : {}),
          ...(useKqueue ? { backend: "kqueue" as const } : {}),
        }
      : undefined;

  const parcelWatcher = await getParcelWatcher();

  for (const dir of dirs) {
    if (useKqueue) assertKqueueSized(dir);
    try {
      const sub = await parcelWatcher.subscribe(
        dir,
        (err, events) => {
          if (err) {
            console.error(`[file-watcher] error on ${dir}`, err);
            return;
          }
          const filtered = extensions
            ? events.filter((e) => extensions.includes(extname(e.path)))
            : events;
          if (filtered.length === 0) return;

          if (debounceMs === 0) {
            changes.trigger(filtered);
          } else {
            pending.push(...filtered);
            schedule();
          }
        },
        parcelOptions,
      );
      subscriptions.push(sub);
    } catch (err: unknown) {
      console.error(`[file-watcher] failed to subscribe to ${dir}`, err);
      throw err;
    }
  }

  if (reconciles !== null) {
    reconcileTimer = setInterval(() => reconciles.trigger(), reconcileMs);
  }

  return {
    folded: () => changes.stats().folded,
    async stop(): Promise<void> {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (ceilingTimer) {
        clearTimeout(ceilingTimer);
        ceilingTimer = null;
      }
      if (reconcileTimer) {
        clearInterval(reconcileTimer);
        reconcileTimer = null;
      }
      pending = [];
      await Promise.all(subscriptions.map((s) => s.unsubscribe()));
      subscriptions.length = 0;
    },
  };
}
