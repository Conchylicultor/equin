import { prototypesFiles } from "@plugins/apps/plugins/prototypes/server";
import {
  splitRel,
  type DataChange,
  type DataWatch,
} from "@plugins/infra/plugins/paths/plugins/data-files/core";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { reportServerError } from "@plugins/framework/plugins/server-core/core";
import { createCoalescer } from "@plugins/packages/plugins/coalesce/core";
import { yieldMacrotask } from "@plugins/packages/plugins/macrotask-yield/core";
import { protoIdKind } from "../../core";
import {
  adoptPrototypeHistories,
  prototypeHistoryServed,
  prototypeVersionCountsServed,
} from "./history";
import { prototypePicksServed } from "./picks";
import type { RecordsScope } from "./records";
import { prototypesListServed } from "./resources";
import { classifyTreePath } from "./tree-path";
import { prototypeRecords } from "./tree-records";

// The one subscription to the tree's watch (`prototypesFiles.watch`: the
// extensions are the root's — `apps/prototypes`' `server/internal/roots.ts`).
// On the desktop that is a declared file watcher over the data dir (its
// Background-catalog entry `prototypes-files.tree`); in a browser host, the
// memory store's own change feed.

let subscription: DataWatch | null = null;
let started = false;

const listeners: ((changed: readonly string[]) => void)[] = [];

/**
 * The watcher's work in flight — each delivered change until its handling
 * settles, and the boot adoption — and who waits for it to reach zero
 * ({@link settlePrototypesWatcher}).
 */
let busy = 0;
const idleWaiters: (() => void)[] = [];

function tracked<T>(work: Promise<T>): Promise<T> {
  busy += 1;
  return work.finally(() => {
    busy -= 1;
    if (busy === 0) for (const resolve of idleWaiters.splice(0)) resolve();
  });
}

/**
 * The boot baseline — the records' first refresh of the whole tree. A promise
 * because it is read after the watch subscribes: a refresh awaits it, so the
 * first comparison is against the real tree, never an empty one that would
 * read every prototype as just added.
 */
let baselineRead: Promise<void> = Promise.resolve();

/**
 * The prototypes a tree change named while the boot baseline was being read
 * (`"all"` for a rescan), or `null` outside that window. An edit landing
 * after the subscribe but before its folder is listed is already IN the
 * baseline, so the signature gate alone would read it as no change; the first
 * refresh counts these as changed regardless. Handed over to
 * {@link absorbedAtBoot} when the baseline settles.
 */
let seenDuringBaseline: Set<string> | "all" | null = null;
let absorbedAtBoot: Set<string> | "all" | null = null;

/**
 * Subscribe to "something under `prototypes/` changed".
 *
 * This plugin owns the directory and therefore runs the ONLY watcher over it —
 * a second subscription to the same tree from another plugin would double every
 * filesystem event. So the signal it already computes is exported rather than
 * re-derived: a consumer that needs to react to an edit (the thumbnail
 * renderer) listens here instead of watching.
 *
 * The listener is handed the prototypes that moved — added, removed or
 * edited, by name (a removed one is no longer on disk) — the same diff that
 * gates the re-broadcast, so a consumer redoes the work for those and leaves
 * the rest of the tree alone.
 *
 * Process-lifetime, like the watcher itself — there is no unsubscribe because
 * every listener is registered once, in a plugin's `onReady`.
 */
export function onPrototypesChanged(
  listener: (changed: readonly string[]) => void,
): void {
  listeners.push(listener);
}

/**
 * Re-read the listings of the folders `scope` names (every folder for a
 * rescan) into the records; if their bytes really moved, re-broadcast the list
 * (new/edited mocks appear in the gallery, and the moved prototypes' `rev`
 * reloads their open live frames), re-read the history of every prototype that
 * moved and still exists (an edit flips its `dirty` flag) and wake the
 * listeners. Then give any new prototype its `v0`.
 *
 * Everything goes through this one gate — the watcher's events and its
 * dropped-events report alike — because a new `rev` is a RELOAD. A prototype on screen
 * is a live app the author is clicking through, and a reload throws that state
 * away, so "the watcher woke up" is not enough of a reason: the tree has to
 * have actually changed.
 *
 * Only the named folders: an edit costs a stat and a listing of the folder it
 * touched, never of the tree — the list read afterwards re-reads that one
 * folder's bytes and composes the rest from the records.
 */
async function refreshOnce(scope: RecordsScope): Promise<void> {
  await baselineRead;
  // A baseline that failed loaded nothing to refresh a part of: re-derive all.
  const { moved, listChanged } = await prototypeRecords.refresh(
    prototypeRecords.loaded() ? scope : "all",
  );
  const changed = withAbsorbed(moved);
  if (changed.length === 0 && !listChanged) return;

  prototypesListServed.notify();
  if (changed.length === 0) return;
  // Only a prototype still on disk has a history to re-read: a removed one
  // (its folder gone) would make the loader throw "no such prototype" for
  // a pane still open on it — which unmounts once the list above reaches it.
  for (const name of changed)
    if (prototypeRecords.has(name)) notifyHistory(name);
  for (const listener of listeners) listener(changed);

  // A folder that appeared without the mint (made by hand, restored from a
  // backup) gets its history here; a minted one already has it. Last, so a
  // failure to adopt cannot hold back the notifications above.
  try {
    await adoptPrototypeHistories();
  } finally {
    // A repo is born by renaming a stamped staging dir into place — a dir
    // rename, which need not surface as a `latest.json` event — so a tree that
    // moved (a prototype minted, adopted or deleted) re-reads the counts here.
    prototypeVersionCountsServed.notify();
  }
}

/**
 * `moved` plus the prototypes a change named while the boot baseline was
 * read (see {@link seenDuringBaseline}) — once, on the first refresh after it.
 * Only prototypes count: a path's first segment may be `_template`, so a name
 * counts when it is in the records or just left them.
 */
function withAbsorbed(moved: string[]): string[] {
  const absorbed = absorbedAtBoot;
  if (absorbed === null) return moved;
  absorbedAtBoot = null;
  const names = absorbed === "all" ? prototypeRecords.names() : absorbed;
  const out = new Set(moved);
  for (const name of names) if (prototypeRecords.has(name)) out.add(name);
  return [...out];
}

/** Re-read one prototype's history, for whoever is subscribed to it. */
function notifyHistory(name: string): void {
  if (protoIdKind.is(name)) prototypeHistoryServed.notify({ name });
}

/** {@link handleTreeChange}'s mark for a change that names no folder. */
const ALL = Symbol("all");

/** What one trigger asks a refresh to re-read: one folder, or the whole tree. */
type RefreshItem = { kind: "folder"; name: string } | { kind: "all" };

// One refresh at a time, with a trailing re-run whose folders are every
// trigger's that landed meanwhile: a listing read is async, so two triggers
// arriving together must not each apply a listing over the other's and notify
// twice for one edit.
const refreshes = createCoalescer<RefreshItem>({
  run: (items) =>
    runTracked("prototypes:refresh", () => refreshOnce(scopeOf(items))),
});

function scopeOf(items: readonly RefreshItem[]): RecordsScope {
  const names = new Set<string>();
  for (const item of items) {
    if (item.kind === "all") return "all";
    names.add(item.name);
  }
  return names;
}

/**
 * Sort one batch of watcher events. A version recorded under `_history/`
 * (by this backend or any other — the store is host-global) re-reads that one
 * history and nothing else: the prototype's bytes did not move, so nothing may
 * reload. Picks written under `_picks/` likewise re-read that one prototype's
 * picks and reload nothing — the frames follow on their own, because their `src`
 * carries the picks. Anything under a retired dir (`_trash/`) is nothing to react
 * to. Everything else goes through the signature gate.
 */
function onTreeChange(change: DataChange): Promise<void> | undefined {
  const work = handleTreeChange(change);
  return work === undefined ? undefined : tracked(work);
}

function handleTreeChange(change: DataChange): Promise<void> | undefined {
  // The watch reported dropped events (`onLost`): re-derive everything —
  // through the same signature gate, so an unmoved tree costs a few stats.
  if (change.kind === "rescan") {
    if (seenDuringBaseline !== null) seenDuringBaseline = "all";
    return refreshes.run([{ kind: "all" }]);
  }
  const moved = new Set<string | typeof ALL>();
  const recorded = new Set<string>();
  const picked = new Set<string>();
  for (const path of change.paths) {
    const kind = classifyTreePath(path);
    if (kind.kind === "version-recorded") recorded.add(kind.id);
    else if (kind.kind === "picks-recorded") picked.add(kind.id);
    else if (kind.kind === "tree") {
      // A change at the root itself names no folder: re-read the tree.
      const dirName = splitRel(path)[0] ?? ALL;
      moved.add(dirName);
      if (dirName !== ALL && seenDuringBaseline instanceof Set)
        seenDuringBaseline.add(dirName);
    }
  }
  for (const id of recorded) notifyHistory(id);
  // Every recorded version moves one prototype's count; the counts are one
  // value, so a batch re-reads it once.
  if (recorded.size > 0) prototypeVersionCountsServed.notify();
  for (const name of picked) prototypePicksServed.notify({ name });
  if (moved.size === 0) return undefined;
  const items: RefreshItem[] = [];
  for (const name of moved)
    items.push(name === ALL ? { kind: "all" } : { kind: "folder", name });
  return refreshes.run(items);
}

/**
 * Watch the tree for edits. Push-based — no polling; a dropped fsevent is
 * reported by the watch (`onLost`, delivered as a `rescan`) and answered by the
 * same signature gate.
 */
export async function startPrototypesWatcher(): Promise<void> {
  if (started) return;
  started = true;

  // The tree as it stands at boot is the baseline, so the first genuine edit is
  // what re-broadcasts — not the first tick after start. It is read AFTER the
  // watch is live and not awaited here: `onReady` returns once subscribed (the
  // read is one listing per prototype, each queued behind every other boot
  // hook on the event loop — 2 s of wall at boot for ~20 ms of work). A refresh
  // awaits the baseline before comparing, so it never compares against an
  // empty tree. An edit delivered while the baseline is read may already be in
  // it, so the prototypes such a change names count as changed on the first
  // refresh (`seenDuringBaseline`); and, read after the subscribe, no edit can
  // land between the baseline and the watch unseen.
  const baseline = Promise.withResolvers<void>();
  baselineRead = baseline.promise;
  seenDuringBaseline = new Set();

  // Every prototype that predates version history gets its `v0` — once; after
  // that this is a stat per prototype. Not awaited: boot need not wait on a few
  // hundred milliseconds of git, and every backend on the box races to do it
  // (the store's per-repo lock makes exactly one of them win each prototype).
  void runTracked("prototypes:adopt-histories", () =>
    tracked(adoptPrototypeHistories()),
  );

  try {
    subscription = await prototypesFiles.watch(onTreeChange);
  } catch (err) {
    started = false;
    seenDuringBaseline = null;
    baseline.resolve();
    throw err;
  }
  baseline.resolve(
    tracked(
      runTracked("prototypes:baseline", () =>
        prototypeRecords.refresh("all"),
      ).then(
        () => {
          endBaselineWindow();
        },
        (err: unknown) => {
          // Loud, and not fatal to the watcher: with no records loaded the
          // next refresh re-derives the whole tree (a list read meanwhile
          // fails with this error, never answers an empty gallery).
          reportServerError({
            message: `[prototypes] reading the tree's boot baseline failed: ${err instanceof Error ? err.message : String(err)}`,
            errorType: "PrototypesBaselineFailed",
          });
          endBaselineWindow();
        },
      ),
    ),
  );
}

function endBaselineWindow(): void {
  absorbedAtBoot = seenDuringBaseline;
  seenDuringBaseline = null;
}

/**
 * Resolves once the watcher has handled every change its watch has delivered:
 * the list re-broadcast, the history re-reads, the listeners woken and every
 * new folder's history adopted — for a writer that puts prototypes in through
 * the tree and then needs what the watcher derives from them (a fixture
 * writer, after its `v0`s). Push-based: it waits on the in-flight work's own
 * settlement, re-checked a macrotask later until a turn passes with nothing in
 * flight, so a change delivered as the last one settles (the memory store
 * delivers each batch in a microtask) is waited on too.
 *
 * A change the watch has not delivered yet is not waited on: on the desktop
 * the disk watcher reports after the filesystem's own latency. A failed
 * handling is not reported here — it surfaces where it always does (an
 * unhandled rejection) — so a caller asserts what it needs afterwards.
 */
export async function settlePrototypesWatcher(): Promise<void> {
  if (!started)
    throw new Error(
      "settlePrototypesWatcher: the prototypes watcher is not running (it starts in files' onReady)",
    );
  for (;;) {
    await yieldMacrotask();
    if (busy === 0) return;
    await new Promise<void>((resolve) => idleWaiters.push(resolve));
  }
}

export async function stopPrototypesWatcher(): Promise<void> {
  if (!started) return;
  started = false;
  baselineRead = Promise.resolve();
  prototypeRecords.reset();
  seenDuringBaseline = null;
  absorbedAtBoot = null;
  if (subscription) {
    await subscription.dispose();
    subscription = null;
  }
}
