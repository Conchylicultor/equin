import type * as parcel from "@parcel/watcher";
import { exists } from "@plugins/packages/plugins/timed-fs/core";
import { basename, dirname, join, resolve } from "node:path";
import { WatchedDirGoneError } from "./dir-gone";

// Following writes to named files (`writesWhileOpen`): the per-directory
// multiplexer under the engine's `files` mode.
//
// Writes to a file another process holds open are heard only by a backend that
// holds a descriptor on the file itself (kqueue on darwin), so the cost of a
// follow is one descriptor per followed file. That is why a follow NAMES its
// files: what it holds is the list its caller enumerated, never "whatever a
// directory has grown to" (2026-11-05: a dir-wide kqueue watch of
// state/sdk-agents/<ns>/ held ~4,400 descriptors and crash-looped main; the
// supervised runs dir held one per artifact, ~1,100, during every live run).
//
// Two constraints of @parcel/watcher 2.6.0 shape the rest:
//
// - **One subscription per directory per process.** parcel caches a
//   directory's listing by path and shares it between subscriptions, even when
//   their ignore lists differ: a second subscription with a different ignore
//   fails outright (measured: `error watching <dir>: Undefined error: 0`), or
//   misses the files the first one ignored. So every follow of one directory —
//   whatever declaration it comes from — shares ONE subscription whose ignore
//   lets through exactly the union of their names, re-opened when that union
//   changes. Between the close and the re-open nothing is heard, so after every
//   open each follower is handed an `update` for each of its files on disk: a
//   follower reads from its own cursor, and a spurious update costs a read.
// - **Upstream leaks a followed file's descriptor when it is deleted or
//   renamed** — its kqueue backend drops it from its tables without closing
//   it, and `unsubscribe` closes only what it still tracks (measured: 70
//   deletes under a dir-wide watch left 90 descriptors held after
//   unsubscribe). The addon this engine loads on darwin is built from a
//   patched source that closes it (`patches/@parcel%2Fwatcher@*.patch`, built
//   by the `parcel-addon` child plugin and copied into the checkout by
//   `./equin build`); a checkout never built, or a release, still runs the
//   upstream prebuild.

/** One follower's files in one directory, and where its events go. */
interface Member {
  readonly names: ReadonlySet<string>;
  readonly take: (events: parcel.Event[]) => void;
  readonly lost: (dir: string, error: unknown) => void;
  /** Its names are inside the open subscription. False until the first open that included them. */
  live: boolean;
}

interface DirFollow {
  readonly members: Set<Member>;
  sub: { unsubscribe(): Promise<void> } | null;
  /** The resync in flight, if any; resyncs of one dir run one at a time. */
  running: Promise<void>;
  /** A resync queued behind `running` and not started yet: later requests join it. */
  queued: Promise<void> | null;
  /** Why the latest open failed, for a follower whose names it was opening. */
  lastError: unknown;
}

/**
 * How the engine opens one native subscription of `dir`: kqueue on darwin,
 * parcel's default elsewhere, closed (and `onGone` called) when `dir` itself
 * goes.
 */
export type SubscribeDir = (
  dir: string,
  opts: {
    ignore: RegExp;
    onEvents: parcel.SubscribeCallback;
    onGone: () => void;
  },
) => Promise<{ unsubscribe(): Promise<void> }>;

// Per process, keyed by the resolved directory path. Bounded by the
// directories followed at once; an entry goes with its last follower.
const follows = new Map<string, DirFollow>();

/**
 * The ignore that lets through exactly `names` — direct entries of the
 * subscribed directory — and nothing else, subdirectories included. parcel
 * tests it against the path relative to the directory, so a nested entry
 * (`a/b`) never equals a name. parcel opens no descriptor for an ignored entry.
 */
export function onlyNames(names: Iterable<string>): RegExp {
  const alternatives = [...names].map((n) =>
    n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  return new RegExp(`^(?!(?:${alternatives.join("|")})$)`);
}

/** Group absolute file paths by their directory. Throws on a path that is not a plain file name in a dir. */
export function groupByDir(files: readonly string[]): Map<string, Set<string>> {
  const byDir = new Map<string, Set<string>>();
  for (const file of files) {
    const path = resolve(file);
    const name = basename(path);
    if (name === "" || path === dirname(path)) {
      throw new Error(`[file-watcher] cannot follow ${file}: not a file path`);
    }
    const dir = dirname(path);
    const names = byDir.get(dir) ?? new Set<string>();
    names.add(name);
    byDir.set(dir, names);
  }
  return byDir;
}

/**
 * Follow writes to `files` (absolute paths; a file not there yet is heard from
 * the moment it is created). Resolves once every one of them is inside an open
 * subscription; rejects — holding nothing — when one of their directories
 * cannot be watched (missing). `stop()` releases the follow.
 */
export async function followFiles(opts: {
  files: readonly string[];
  subscribe: SubscribeDir;
  take: (events: parcel.Event[]) => void;
  lost: (dir: string, error: unknown) => void;
}): Promise<{ stop(): Promise<void> }> {
  if (opts.files.length === 0) {
    throw new Error("[file-watcher] a writesWhileOpen watch names no file");
  }
  const joined: { dir: string; member: Member }[] = [];
  const stop = async (): Promise<void> => {
    const leaving = joined.splice(0);
    await Promise.all(
      leaving.map(({ dir, member }) => leave(dir, member, opts.subscribe)),
    );
  };
  try {
    for (const [dir, names] of groupByDir(opts.files)) {
      const member: Member = {
        names,
        take: opts.take,
        lost: opts.lost,
        live: false,
      };
      const follow = followOf(dir);
      follow.members.add(member);
      joined.push({ dir, member });
      follow.lastError = null;
      await resync(dir, follow, opts.subscribe);
      if (!member.live) {
        throw (
          follow.lastError ?? new WatchedDirGoneError(dir) // it went while the follow was opening
        );
      }
    }
  } catch (err) {
    await stop();
    throw err;
  }
  return { stop };
}

function followOf(dir: string): DirFollow {
  let follow = follows.get(dir);
  if (follow === undefined) {
    follow = {
      members: new Set(),
      sub: null,
      running: Promise.resolve(),
      queued: null,
      lastError: null,
    };
    follows.set(dir, follow);
  }
  return follow;
}

async function leave(
  dir: string,
  member: Member,
  subscribe: SubscribeDir,
): Promise<void> {
  // Not live from here: a reopen already past its snapshot must not hand a
  // stopped follower anything.
  member.live = false;
  const follow = follows.get(dir);
  if (follow === undefined || !follow.members.delete(member)) return;
  await resync(dir, follow, subscribe);
}

/**
 * Bring `dir`'s subscription in line with its followers' names. One at a time
 * per dir; a request landing while one runs joins the next (not-yet-started)
 * run, so a burst of joins costs at most two re-opens.
 */
function resync(
  dir: string,
  follow: DirFollow,
  subscribe: SubscribeDir,
): Promise<void> {
  if (follow.queued !== null) return follow.queued;
  const run = follow.running.then(() => {
    follow.queued = null;
    return reopen(dir, follow, subscribe);
  });
  follow.queued = run;
  follow.running = run;
  return run;
}

/**
 * Close the current subscription and open one over the current union of names.
 * Never rejects — a rejection would wedge every later resync of the dir behind
 * it: a failed close or open is handed to every follower that was live (`lost`,
 * which logs it — their watch may be gone) and left in `lastError` for the ones
 * it was opening (their `followFiles` throws it).
 */
async function reopen(
  dir: string,
  follow: DirFollow,
  subscribe: SubscribeDir,
): Promise<void> {
  const previous = follow.sub;
  follow.sub = null;
  if (previous !== null) {
    try {
      await previous.unsubscribe();
    } catch (err) {
      for (const m of follow.members) if (m.live) m.lost(dir, err);
    }
  }
  const members = [...follow.members];
  if (members.length === 0) {
    if (follows.get(dir) === follow && follow.queued === null) {
      follows.delete(dir);
    }
    return;
  }
  const names = new Set(members.flatMap((m) => [...m.names]));
  let sub: { unsubscribe(): Promise<void> };
  try {
    sub = await subscribe(dir, {
      ignore: onlyNames(names),
      onEvents: (err, events) => {
        route(follow, events);
        if (err) for (const m of follow.members) if (m.live) m.lost(dir, err);
      },
      onGone: () => {
        if (follow.sub === sub) follow.sub = null;
        for (const m of follow.members) {
          if (!m.live) continue;
          m.live = false;
          m.lost(dir, new WatchedDirGoneError(dir));
        }
      },
    });
  } catch (err) {
    follow.lastError = err;
    for (const m of members) {
      if (!m.live) continue;
      m.live = false;
      m.lost(dir, err);
    }
    return;
  }
  follow.sub = sub;
  for (const m of members) m.live = follow.members.has(m);
  // Nothing was heard while no subscription was open: every follower re-reads.
  for (const m of members) {
    if (!m.live) continue;
    const present: parcel.Event[] = [];
    for (const name of m.names) {
      const path = join(dir, name);
      if (await exists(path)) present.push({ type: "update", path });
    }
    // Re-checked after the awaits: it may have left meanwhile.
    if (present.length > 0 && m.live) m.take(present);
  }
}

function route(follow: DirFollow, events: parcel.Event[]): void {
  for (const m of follow.members) {
    if (!m.live) continue;
    const mine = events.filter((e) => m.names.has(basename(e.path)));
    if (mine.length > 0) m.take(mine);
  }
}

/** The directories followed in this process and how many followers each has (tests, the catalog). */
export function followedDirs(): { dir: string; followers: number }[] {
  return [...follows].map(([dir, f]) => ({ dir, followers: f.members.size }));
}
