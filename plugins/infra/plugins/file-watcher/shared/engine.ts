import type * as parcel from "@parcel/watcher";
import { type FSWatcher, watch as fsWatch } from "node:fs";
import { lstat, realpath, stat } from "@plugins/packages/plugins/timed-fs/core";
import { basename, dirname, extname, join } from "node:path";
import { readEnv } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import {
  createCoalescer,
  createKeyedCoalescer,
} from "@plugins/packages/plugins/coalesce/core";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import {
  createNewDirWatches,
  ignoreForSubdir,
  ignoreMatcher,
  type NewDirWatches,
} from "./new-dirs";
// Pure-JS wrapper: this import loads NO native code — `wrapper.js` only defines
// functions that close over a `binding` passed in at call time. Safe to import
// at module top-level (the native `.node` addon is still loaded lazily below).
import { createWrapper } from "@parcel/watcher/wrapper";
import { WatchedDirGoneError } from "./dir-gone";
import { followFiles } from "./follow-files";
import {
  createDeliveryLagProbe,
  type DeliveryLagHost,
  type DeliveryLagSample,
} from "./delivery-lag";
import { readSleepClock } from "@plugins/packages/plugins/sleep-clock/core";

export { WatchedDirGoneError } from "./dir-gone";

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
// the launcher vendors it on disk and points `EQUIN_PARCEL_WATCHER_NODE`
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
    const nodePath = readEnv("PARCEL_WATCHER_NODE");
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

/**
 * The native watch of `dir` reported an error (FSEvents dropped events, a
 * kqueue / Windows watch failed): events may have been lost, so anything below
 * `dir` may have changed unheard. Re-derive what the watch keeps fresh.
 * Coalesced per dir like {@link WatchReaction} — drops come in bursts, and a
 * burst costs one running plus one pending reaction, handed the latest error.
 *
 * This is the ONLY backstop for a missed event: there is no reconcile timer.
 * Which backends report a loss (macOS FSEvents does, Linux inotify's queue
 * overflow does not) is in this plugin's CLAUDE.md.
 */
export type WatchLost = (
  dir: string,
  error: unknown,
) => void | Promise<unknown>;

/** What every watch takes, whatever it watches. */
interface WatchOptionsBase {
  onChange: WatchReaction<parcel.Event>;
  /**
   * Called when a native watch errored and may have dropped events (the error
   * is still logged), and — with a {@link WatchedDirGoneError}, once — when a
   * `subtree` watch's dir (or a followed file's dir) itself went: its watch is
   * closed then (see `subscribeRoot`). Not called for a `children` watch: a
   * failing one already reports its dir gone (see `depth`).
   */
  onLost?: WatchLost;
  debounceMs?: number;
  ceilingMs?: number;
  /**
   * Label for the `bg` span each dispatch (`onChange` / `onLost`) runs
   * under, so a watcher callback's synchronous main-thread cost is attributed to
   * `watch:<name>` in the profiler instead of vanishing. Defaults to the first
   * watched path's basename.
   */
  name?: string;
  /**
   * How late the OS reported a write: the instance samples its batches as the
   * native watch delivers them — before the debounce, so a declared hold is
   * not in it — at most one every few seconds (see `delivery-lag.ts`), and
   * hands each sample here. Absent: nothing is measured.
   */
  onDeliveryLag?: (sample: DeliveryLagSample) => void;
}

/** A watch of directories: every change of what they hold. */
export interface DirWatchOptions extends WatchOptionsBase {
  dirs: string[];
  extensions?: string[];
  ignore?: string[];
  /** A directory is never followed per write — see {@link FileFollowOptions}. */
  writesWhileOpen?: false;
  /**
   * How deep each watched dir is heard. `"subtree"` (the default) is
   * parcel's native recursive watch: every path at any depth. `"children"` is
   * the dir's direct entries created, written, renamed or removed, and the
   * dir itself going (one `delete` of it), never a watch of everything below
   * it — so watching a huge folder (`~`, `/`) stays cheap. Live when `start`
   * resolves: on macOS its own FSEvents stream with every deeper path ignored
   * natively (`subscribeChildren`), elsewhere Bun's single-directory
   * `fs.watch` of it and of its parent (`watchChildren`). No `ignore` beside
   * it (a throw).
   */
  depth?: WatchDepth;
}

/**
 * A follow of named files: every write to each of them — including writes to
 * a file another process still holds open, not only the moment it closes it.
 *
 * macOS FSEvents, parcel's default backend there, reports a content change
 * when the writer CLOSES its descriptor, not on each `write(2)`. A long-lived
 * writer (a detached child whose stdout is a file) therefore produces one
 * event at open and one at exit, and nothing in between. A follow uses
 * parcel's kqueue backend on darwin, whose `EVFILT_VNODE` fires per write;
 * inotify (Linux) already reports every write.
 *
 * kqueue holds one descriptor per file it watches, so a follow takes the
 * FILES, never a directory: it holds one descriptor per named file plus one
 * per directory they sit in — the list its caller enumerated, never whatever a
 * directory has grown to. A file not there yet is heard from its creation.
 * Every follow of one directory in the process shares one native subscription
 * (`follow-files.ts`).
 */
export interface FileFollowOptions extends WatchOptionsBase {
  files: string[];
  writesWhileOpen: true;
}

export type FileWatcherOptions = DirWatchOptions | FileFollowOptions;

export interface FileWatcher {
  stop(): Promise<void>;
  /** Batches folded into a pending reaction instead of costing a run. */
  folded(): number;
  /**
   * Resolves once every event this watch had received when called has been
   * handed to `onChange` by a run that has settled — a batch still in its
   * debounce window is handed over now, not at the window's end. What a
   * consumer that remembers "the watch has told me everything up to here"
   * waits on (corpus-index's cursor checkpoint). Not a wait for quiet: a
   * batch arriving after the call is not waited for.
   */
  drained(): Promise<void>;
  /**
   * How many loss reports (dropped events, the dir gone) this watch has
   * received, counted when each arrives — before its `onLost` runs. Equal
   * readings bracket a stretch in which the watch dropped nothing.
   */
  losses(): number;
}

/**
 * The native backend a watcher runs on, as parcel picks it for this platform:
 * FSEvents on darwin (kqueue when `writesWhileOpen`), inotify on Linux,
 * ReadDirectoryChangesW on Windows, and parcel's own default elsewhere. The one
 * statement of that choice — the engine subscribes with it and the Background
 * activity catalog reports it.
 */
export type WatcherBackend =
  | "fs-events"
  | "kqueue"
  | "inotify"
  | "windows"
  | "platform-default"
  | "fs-watch";

/** How deep a watch hears each watched dir — see `depth` on the options. */
export type WatchDepth = "subtree" | "children";

export function watcherBackend(
  writesWhileOpen: boolean,
  depth: WatchDepth = "subtree",
): WatcherBackend {
  const platform = process.platform;
  if (depth === "children")
    return platform === "darwin" ? "fs-events" : "fs-watch";
  if (platform === "darwin") return writesWhileOpen ? "kqueue" : "fs-events";
  if (platform === "linux") return "inotify";
  if (platform === "win32") return "windows";
  return "platform-default";
}

export async function createFileWatcher(
  opts: FileWatcherOptions,
): Promise<FileWatcher> {
  const { onChange, onLost, debounceMs = 100, ceilingMs = 1000 } = opts;
  const name =
    opts.name ??
    basename(
      (opts.writesWhileOpen === true ? opts.files[0] : opts.dirs[0]) ??
        "file-watcher",
    );

  let pending: parcel.Event[] = [];
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let ceilingTimer: ReturnType<typeof setTimeout> | null = null;
  let lastFlushAt = 0;
  // One reaction at a time; batches landing mid-run fold into one trailing
  // call. The `bg` span covers the reaction's awaited work, not only its
  // synchronous body.
  const changes = createCoalescer<parcel.Event>({
    run: (events) => runTracked(`watch:${name}`, () => onChange(events)),
  });
  const losses =
    onLost === undefined
      ? null
      : createKeyedCoalescer<string, unknown>({
          run: (dir, errors) =>
            runTracked(`watch:${name}:lost`, () => onLost(dir, errors.at(-1))),
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

  /** Hand events to the reaction: at once, or batched by the debounce. */
  let stopped = false;
  const probe =
    opts.onDeliveryLag === undefined
      ? null
      : createDeliveryLagProbe(DELIVERY_LAG_HOST, opts.onDeliveryLag);
  const deliver = (events: parcel.Event[]): void => {
    if (stopped || events.length === 0) return;
    probe?.(events, Date.now());
    if (debounceMs === 0) {
      changes.trigger(events);
    } else {
      pending.push(...events);
      schedule();
    }
  };

  let lossCount = 0;
  const lost = (dir: string, error: unknown): void => {
    lossCount += 1;
    console.error(`[file-watcher] error on ${dir}`, error);
    losses?.trigger(dir, [error]);
  };

  const drained = async (): Promise<void> => {
    if (pending.length > 0) flush();
    await changes.settled();
  };

  const stopPipeline = (): void => {
    stopped = true;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (ceilingTimer) {
      clearTimeout(ceilingTimer);
      ceilingTimer = null;
    }
    pending = [];
  };

  if (opts.writesWhileOpen === true) {
    const parcelWatcher = await getParcelWatcher();
    const follow = await followFiles({
      files: opts.files,
      take: deliver,
      lost,
      subscribe: (dir, { ignore, onEvents, onGone }) =>
        subscribeRoot(parcelWatcher, dir, {
          onEvents,
          options: {
            ignore: [ignore],
            ...(watcherBackend(true) === "kqueue"
              ? { backend: "kqueue" as const }
              : {}),
          },
          onGone: () => onGone(),
        }),
    });
    return {
      folded: () => changes.stats().folded,
      drained,
      losses: () => lossCount,
      async stop(): Promise<void> {
        stopPipeline();
        await follow.stop();
      },
    };
  }

  const { dirs, extensions, ignore, depth = "subtree" } = opts;
  if (depth === "children" && ignore !== undefined) {
    throw new Error(
      `[file-watcher] ${name}: a children-depth watch takes no ignore`,
    );
  }
  const subscriptions: { unsubscribe(): Promise<void> }[] = [];
  const parcelOptions: ParcelOptions | undefined = ignore
    ? { ignore }
    : undefined;

  const take = (events: parcel.Event[]): void => {
    deliver(
      extensions
        ? events.filter((e) => extensions.includes(extname(e.path)))
        : events,
    );
  };

  const backend = watcherBackend(false, depth);
  const parcelWatcher =
    backend === "fs-watch" ? null : await getParcelWatcher();

  const matchers = new Map(dirs.map((d) => [d, ignoreMatcher(d, ignore)]));
  const ignoredUnder = (root: string): ((path: string) => boolean) => {
    const matcher = matchers.get(root);
    if (!matcher)
      throw new Error(`[file-watcher] ${name}: ${root} is not a watched dir`);
    return matcher;
  };

  // A backend that watches each directory on its own misses what a new
  // directory already held when it got to it — see `new-dirs.ts`.
  const newDirs: NewDirWatches | null =
    parcelWatcher !== null && backend === "inotify"
      ? createNewDirWatches({
          subscribe: (root, dir) =>
            parcelWatcher.subscribe(dir, handlerFor(root), {
              ...parcelOptions,
              ignore: ignoreForSubdir(root, ignore),
            }),
          ignored: (root, path) => ignoredUnder(root)(path),
          report: (_root, events) => take(events),
          fail: lost,
        })
      : null;

  /** One parcel subscription's callback, for a watch of `root` or a directory below it. */
  function handlerFor(root: string): parcel.SubscribeCallback {
    return parcelBatchHandler(
      (events) => {
        newDirs?.see(root, events);
        take(events);
      },
      (error) => lost(root, error),
    );
  }

  for (const dir of dirs) {
    try {
      const sub =
        parcelWatcher === null
          ? await watchChildren(dir, take)
          : depth === "children"
            ? await subscribeChildren(parcelWatcher, dir, take, (error) =>
                lost(dir, error),
              )
            : await subscribeRoot(parcelWatcher, dir, {
              onEvents: handlerFor(dir),
              options: parcelOptions,
              onGone: (gone) => {
                const i = subscriptions.indexOf(gone);
                if (i >= 0) subscriptions.splice(i, 1);
                lost(dir, new WatchedDirGoneError(dir));
              },
            });
      subscriptions.push(sub);
    } catch (err: unknown) {
      console.error(`[file-watcher] failed to subscribe to ${dir}`, err);
      throw err;
    }
  }

  return {
    folded: () => changes.stats().folded,
    drained,
    losses: () => lossCount,
    async stop(): Promise<void> {
      stopPipeline();
      await newDirs?.stop();
      await Promise.all(subscriptions.map((s) => s.unsubscribe()));
      subscriptions.length = 0;
    },
  };
}

/**
 * One parcel subscription of a watched root, closed the moment its root goes.
 *
 * Not tidiness — a parcel subscription whose root is gone is POISON: it hears
 * nothing more (not even a folder re-created at the path), raises no error, and
 * while it stays open every OTHER parcel subscription in the process hears
 * nothing either (measured on macOS FSEvents, @parcel/watcher 2.6.0: a watch
 * opened after it heard no write; unsubscribing the dead one brought every
 * watch back). So a root event whose dir really went (checked against the
 * inode, since FSEvents replays a moment from before the subscription and an
 * earlier incarnation's delete may arrive) unsubscribes at once and calls
 * `onGone`, after the batch that told us is delivered.
 */
async function subscribeRoot(
  parcelWatcher: ParcelWatcherApi,
  dir: string,
  opts: {
    onEvents: parcel.SubscribeCallback;
    options: ParcelOptions | undefined;
    onGone: (sub: { unsubscribe(): Promise<void> }) => void;
  },
): Promise<{ unsubscribe(): Promise<void> }> {
  const real = await realpath(dir);
  const ino = (await stat(real)).ino;
  let closed = false;
  const dirGone = async (): Promise<boolean> => {
    try {
      return (await stat(real)).ino !== ino;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return true;
      throw err;
    }
  };
  // One close, shared: a `stop()` racing the gone path awaits the same
  // unsubscribe rather than returning before it lands.
  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    closed = true;
    closing ??= native.then((sub) => sub.unsubscribe());
    return closing;
  };
  const handle = { unsubscribe: close };
  const native = parcelWatcher.subscribe(
    dir,
    (err, events) => {
      if (closed) return;
      opts.onEvents(err, events);
      if (!events.some((e) => e.path === real || e.path === dir)) return;
      // A stat that fails for any reason but absence rejects here, unhandled
      // — loud, never swallowed.
      void dirGone().then(async (gone) => {
        if (!gone || closed) return;
        await close();
        opts.onGone(handle);
      });
    },
    opts.options,
  );
  await native;
  return handle;
}

/**
 * The `"children"` depth on macOS: an FSEvents stream of `dir` alone, every
 * path below its direct entries ignored inside parcel (a relative path with a
 * `/` in it — dropped before parcel stats anything), its events at `dir`
 * itself withheld. FSEvents watches by path prefix, so this holds no
 * descriptor per entry and walks nothing, however big the folder.
 *
 * Why not Bun's `fs.watch` (what the other platforms use): it opens the
 * native watch on its own thread after returning, so a change landing just
 * after `start` resolved was never reported; and every directory watch of the
 * process shares ONE FSEvents stream that Bun restarts from "now" whenever
 * any of them opens or closes, so a live watch missed changes landing during
 * another's churn (measured, Bun 1.4.3: 72 of 300 writes missed). parcel
 * gives each subscription its own stream, started (`FSEventStreamStart`,
 * since now) before `subscribe` resolves: live at resolve, and no other
 * watch's open or close touches it.
 *
 * The dir going — removed, moved away, replaced (its inode changed) — is
 * reported once, as a `delete` of `dir` (the children contract), and its
 * stream closed at once (see `subscribeRoot`: a dead root deafens every other
 * parcel subscription). A native error (FSEvents dropped events) is a loss,
 * not the dir going: `lost`.
 */
async function subscribeChildren(
  parcelWatcher: ParcelWatcherApi,
  dir: string,
  onEvents: (events: parcel.Event[]) => void,
  lost: (error: Error) => void,
): Promise<{ unsubscribe(): Promise<void> }> {
  // FSEvents names real paths, and parcel matches its ignore against the dir
  // it was given: subscribe the real one, and name entries under `dir` as the
  // caller spelled it (a dir reached through a symlink included).
  const real = await realpath(dir);
  const entry = (e: parcel.Event): parcel.Event | null => {
    if (!e.path.startsWith(`${real}/`)) return null;
    const name = e.path.slice(real.length + 1);
    return name.includes("/") ? null : { ...e, path: join(dir, name) };
  };
  return subscribeRoot(parcelWatcher, real, {
    onEvents: parcelBatchHandler((events) => {
      const entries = events
        .map(entry)
        .filter((e): e is parcel.Event => e !== null);
      if (entries.length > 0) onEvents(entries);
    }, lost),
    options: { ignore: [/\//] },
    onGone: () => onEvents([{ type: "delete", path: dir }]),
  });
}

/**
 * What one parcel subscription does with a callback. parcel hands an error
 * WITH the rest of its batch — FSEvents flags a drop on one event among many —
 * so the events are delivered first and the loss reported after: dropping the
 * batch on error would lose exactly the events that WERE heard.
 */
export function parcelBatchHandler(
  take: (events: parcel.Event[]) => void,
  lost: (error: Error) => void,
): parcel.SubscribeCallback {
  return (err, events) => {
    take(events);
    if (err) lost(err);
  };
}

/** Whether `path` is there now; a missing (or no longer a dir's) entry is not. */
// A path that went, or that this account may not stat, between its event and
// the delivery-lag probe: nothing to read the lag on. Anything else throws.
const NOT_READABLE = new Set(["ENOENT", "ENOTDIR", "EACCES", "EPERM"]);

const DELIVERY_LAG_HOST: DeliveryLagHost = {
  async ctimeOf(path) {
    try {
      return (await lstat(path)).ctimeMs;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== undefined && NOT_READABLE.has(code)) return null;
      throw err;
    }
  },
  // Only the last wake is placed on the wall clock (`kern.waketime`); an
  // earlier sleep inside a lag of hours is not seen.
  wokeBetween(from, to) {
    const clock = readSleepClock();
    if (!clock.supported || clock.wakeAtMs === null) return false;
    return clock.wakeAtMs > from && clock.wakeAtMs <= to;
  },
};

async function entryExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw err;
  }
}

/**
 * The `"children"` depth off macOS: a single-directory `fs.watch` of `dir`,
 * its events turned into parcel's shape. `fs.watch` says only `rename` (an entry came or
 * went) or `change` (written) and a name, so a rename is classified by
 * looking: there now is a `create`, gone a `delete`.
 *
 * The dir itself going — removed, moved away, or replaced by another (its
 * inode changed) — is reported as a `delete` of `dir`, as is the watch
 * failing (it hears nothing from then on): the holder re-arms on it. The
 * dir's own watch cannot hear that — Bun's single-directory watch reports
 * nothing when its dir is removed or moved (measured on macOS: no event, no
 * error, no close) — so a second single-directory watch, of the PARENT, is
 * held beside it, listening only for entries named `basename(dir)`: the dir
 * going is a `rename` of an entry there, checked against the inode. `/` has
 * no parent and cannot go. Two directory handles per dir, never a watch of
 * the tree below either.
 *
 * Rejects when `dir` (or its parent) cannot be watched — `dir` missing —
 * holding nothing.
 */
async function watchChildren(
  dir: string,
  onEvents: (events: parcel.Event[]) => void,
): Promise<{ unsubscribe(): Promise<void> }> {
  const ino = (await stat(dir)).ino;
  let closed = false;
  let gone = false;
  const dirGone = async (): Promise<boolean> => {
    try {
      return (await stat(dir)).ino !== ino;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return true;
      throw err;
    }
  };
  const deliver = (events: parcel.Event[]): void => {
    if (!closed && events.length > 0) onEvents(events);
  };
  const reportGone = (events: parcel.Event[]): void => {
    if (gone) return;
    gone = true;
    events.push({ type: "delete", path: dir });
  };
  const checkGone = async (events: parcel.Event[]): Promise<void> => {
    if (await dirGone()) reportGone(events);
  };
  const classify = async (type: string, name: string | null): Promise<void> => {
    const events: parcel.Event[] = [];
    if (name !== null && name !== "") {
      const path = join(dir, name);
      if (type === "change") events.push({ type: "update", path });
      else {
        events.push({
          type: (await entryExists(path)) ? "create" : "delete",
          path,
        });
      }
    }
    if (type === "rename" || name === null) await checkGone(events);
    deliver(events);
  };
  const onError = (on: string) => (err: Error) => {
    console.error(`[file-watcher] error on ${on}`, err);
    const events: parcel.Event[] = [];
    reportGone(events);
    deliver(events);
  };
  const watchers: FSWatcher[] = [];
  const closeAll = (): void => {
    closed = true;
    for (const w of watchers) w.close();
  };
  try {
    const own = fsWatch(dir, { persistent: false }, (type, filename) => {
      // A stat that fails for any reason but absence rejects here, unhandled
      // — loud, never swallowed.
      void classify(type, filename ?? null);
    });
    watchers.push(own);
    own.on("error", onError(dir));
    const parent = dirname(dir);
    if (parent !== dir) {
      const self = basename(dir);
      const above = fsWatch(
        parent,
        { persistent: false },
        (_type, filename) => {
          // Only this dir's own entry in its parent; a nameless event may be it.
          if (filename !== null && filename !== self) return;
          const events: parcel.Event[] = [];
          void checkGone(events).then(() => deliver(events));
        },
      );
      watchers.push(above);
      above.on("error", onError(parent));
    }
  } catch (err) {
    closeAll();
    throw err;
  }
  return {
    unsubscribe: async () => {
      closeAll();
    },
  };
}
