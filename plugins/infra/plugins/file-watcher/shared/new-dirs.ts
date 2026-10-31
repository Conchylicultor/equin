import type * as parcel from "@parcel/watcher";
import { readdir, stat } from "node:fs/promises";
import { join, matchesGlob, resolve, sep } from "node:path";

// What a backend that watches each directory on its own misses, recovered.
//
// parcel's kqueue (macOS `writesWhileOpen`) and inotify (Linux) backends hear a
// new directory by diffing its parent, then watch that directory alone — never
// the entries already inside it. Whatever was created in it before parcel's
// thread got to the parent's change (a moved-in folder, or `mkdir` + write
// while the thread lags) is never watched: no `create`, no later write, no
// error (@parcel/watcher 2.6.0 `KqueueBackend::compareDir`; inotify upstream
// #97 / #243). On 2026-10-31 an SDK agent's `events.jsonl`, created 7 s after
// its folder on a loaded host, went unheard by main's consumer for its
// lifetime.
//
// So on every directory a watch reports created, the engine subscribes parcel
// to that directory too — `subscribe` walks the tree it is given and watches
// every entry there — and then reports, as `create`, everything it finds
// inside: an entry that landed before the subscription is announced by the
// walk, one after it by the subscription. A path can be reported twice;
// consumers key by path. The cost: one more native subscription per directory
// created under the watch, held until it is deleted or the watcher stops.

/** Whether an `ignore` entry is a glob (parcel asks `is-glob`; these are its magic characters). */
function isGlob(value: string): boolean {
  return /[*?[\]{}()!]/.test(value);
}

/**
 * The `ignore` list as one predicate over absolute paths, matching parcel's
 * own reading of it (`wrapper.js` `normalizeOptions`, `Watcher::isIgnored`):
 * a glob is matched against the whole absolute path, `**` matching dotted
 * names too and zero segments (picomatch's `dot: true`: a glob ending in
 * `/env/**` covers the `env` directory itself); anything else is a path under
 * `root`, ignoring itself and everything below.
 */
export function ignoreMatcher(
  root: string,
  ignore: readonly string[] | undefined,
): (path: string) => boolean {
  if (!ignore || ignore.length === 0) return () => false;
  const globs: string[] = [];
  const paths: string[] = [];
  for (const value of ignore) {
    if (!isGlob(value)) paths.push(resolve(root, value));
    else {
      globs.push(value);
      if (value.endsWith("/**")) globs.push(value.slice(0, -3));
    }
  }
  return (path) =>
    globs.some((g) => matchesGlob(path, g)) ||
    paths.some((p) => path === p || path.startsWith(p + sep));
}

/**
 * `ignore` as a subscription of a directory BELOW `root` must be given it:
 * parcel resolves a plain path against the directory it subscribes, so each
 * is made absolute against the root it was written for. Globs stay as they are.
 */
export function ignoreForSubdir(
  root: string,
  ignore: readonly string[] | undefined,
): string[] | undefined {
  return ignore?.map((value) => (isGlob(value) ? value : resolve(root, value)));
}

function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Every entry below `dir`, ignored ones (and what is below them) left out. */
async function entriesBelow(
  dir: string,
  ignored: (path: string) => boolean,
): Promise<string[]> {
  const found: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (err) {
      // Removed while walked: its `delete` reaches the watch on its own.
      if (isMissing(err)) continue;
      throw err;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (ignored(path)) continue;
      found.push(path);
      if (entry.isDirectory()) stack.push(path);
    }
  }
  return found;
}

interface Subscription {
  unsubscribe(): Promise<void>;
}

export interface NewDirWatches {
  /**
   * Look at a native batch heard under `root`: subscribe to each directory it
   * reports created, drop the subscriptions of each path it reports deleted.
   * Call it with the RAW batch, before any extension filter (a directory has
   * none).
   */
  see(root: string, events: readonly parcel.Event[]): void;
  /** Close every subscription opened, waiting for those still opening. */
  stop(): Promise<void>;
}

/**
 * The new-directory subscriptions of one watcher. `subscribe(root, dir)`
 * opens parcel on `dir` with the root's options, its batches handed back
 * through {@link NewDirWatches.see} too (a directory created inside it needs
 * the same); `report(root, events)` delivers the walk's `create`s; `fail`
 * receives an error opening or walking one — events under it may be unheard.
 */
export function createNewDirWatches(opts: {
  subscribe: (root: string, dir: string) => Promise<Subscription>;
  ignored: (root: string, path: string) => boolean;
  report: (root: string, events: parcel.Event[]) => void;
  fail: (root: string, error: unknown) => void;
}): NewDirWatches {
  /**
   * Where opening one stands once settled: `watching` holds a subscription;
   * `none` had nothing to watch (not a directory, gone, or the watcher
   * stopped); `failed` was handed to `fail`.
   */
  type Opened =
    | { kind: "watching"; sub: Subscription }
    | { kind: "none" }
    | { kind: "failed" };
  const open = new Map<string, Promise<Opened>>();
  let stopped = false;

  async function watch(root: string, dir: string): Promise<Opened> {
    try {
      if (!(await stat(dir)).isDirectory()) return { kind: "none" };
    } catch (err) {
      if (isMissing(err)) return { kind: "none" };
      throw err;
    }
    let sub: Subscription;
    try {
      sub = await opts.subscribe(root, dir);
    } catch (err) {
      // Gone before parcel walked it: nothing below it is left to hear (its
      // `delete` reaches the watch on its own).
      if (await stat(dir).then(() => false, isMissing)) return { kind: "none" };
      throw err;
    }
    if (stopped) {
      await sub.unsubscribe();
      return { kind: "none" };
    }
    const events = (await entriesBelow(dir, (p) => opts.ignored(root, p))).map(
      (path): parcel.Event => ({ type: "create", path }),
    );
    if (events.length > 0 && !stopped) opts.report(root, events);
    return { kind: "watching", sub };
  }

  async function unsubscribe(opened: Promise<Opened>): Promise<void> {
    const o = await opened;
    if (o.kind === "watching") await o.sub.unsubscribe();
  }

  function close(path: string): void {
    for (const [dir, opened] of open) {
      if (dir !== path && !dir.startsWith(path + sep)) continue;
      open.delete(dir);
      // `opened` never rejects (see `see`); an unsubscribe that throws is loud.
      void unsubscribe(opened);
    }
  }

  return {
    see(root, events) {
      if (stopped) return;
      for (const e of events) {
        if (e.type === "delete") close(e.path);
        else if (e.type === "create" && !open.has(e.path)) {
          if (opts.ignored(root, e.path)) continue;
          // A failure is handed to `fail` (the watch's loss report) and the
          // entry dropped, so a later `create` of the path tries again.
          const opened = watch(root, e.path).catch((err: unknown): Opened => {
            if (open.get(e.path) === opened) open.delete(e.path);
            opts.fail(root, err);
            return { kind: "failed" };
          });
          open.set(e.path, opened);
        }
      }
    },
    async stop() {
      stopped = true;
      const all = [...open.values()];
      open.clear();
      await Promise.all(all.map(unsubscribe));
    },
  };
}
