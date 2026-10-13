import {
  defineFileWatcher,
  type FileWatcher,
} from "@plugins/infra/plugins/file-watcher/server";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { createCoalescer } from "@plugins/packages/plugins/coalesce/core";
import { protoIdKind } from "../../core";
import { prototypesDir } from "@plugins/apps/plugins/prototypes/data-dirs";
import { adoptPrototypeHistories, prototypeHistoryServed } from "./history";
import { prototypePicksServed } from "./picks";
import { prototypeStatusesServed } from "./status";
import { prototypesListServed } from "./resources";
import { changedPrototypes, readPrototypesSignature } from "./signature";
import { classifyTreePath } from "./tree-path";

/**
 * The one watcher over `prototypes/`. Push-based — no polling; the 30s
 * reconcile is a backstop for an fsevent parcel drops, and costs one stat per
 * prototype file because it changes nothing when the signature matches.
 */
export const prototypesTreeWatcher = defineFileWatcher({
  name: "prototypes-files.tree",
  description:
    "Watches the prototypes folder and reloads open prototypes, their history, picks and status when a file really changes.",
  // Everything a self-contained prototype can ship. No `.jsx`: JSX lives
  // inline in index.html, because Babel fetches an external `src` with XHR
  // and Chrome blocks that over file:// (the `prototypes:self-contained`
  // check rejects such a script tag, so an external .jsx cannot exist).
  // `.json` also passes each history's `latest.json` stamp — git's own
  // files carry no extension, so they never reach `onChange` — and each
  // `_picks/<id>.json` and `_status/<id>.json` (their `.lock` and
  // `.json.tmp` do not pass).
  extensions: [
    ".html",
    ".css",
    ".js",
    ".json",
    ".svg",
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".gif",
    ".woff2",
  ],
  reconcileMs: 30_000,
});

let watcher: FileWatcher | null = null;
let started = false;

const listeners: (() => void)[] = [];

/** The tree as of the last time it was looked at — see {@link readPrototypesSignature}. */
let lastSignature = new Map<string, string>();

/**
 * Subscribe to "something under `prototypes/` changed".
 *
 * This plugin owns the directory and therefore runs the ONLY watcher over it —
 * a second subscription to the same tree from another plugin would double every
 * filesystem event. So the signal it already computes is exported rather than
 * re-derived: a consumer that needs to react to an edit (the thumbnail
 * renderer) listens here instead of watching.
 *
 * Process-lifetime, like the watcher itself — there is no unsubscribe because
 * every listener is registered once, in a plugin's `onReady`.
 */
export function onPrototypesChanged(listener: () => void): void {
  listeners.push(listener);
}

/**
 * Re-read the tree; if its bytes really moved, re-broadcast the list (new/edited
 * mocks appear in the gallery, and the moved prototypes' `rev` reloads their
 * open live frames), re-read the history of every prototype that moved (an edit flips its
 * `dirty` flag) and wake the listeners. Then give any new prototype its `v0`.
 *
 * Everything goes through this one gate — the watcher's events and the
 * reconcile tick alike — because a new `rev` is a RELOAD. A prototype on screen
 * is a live app the author is clicking through, and a reload throws that state
 * away, so "the watcher woke up" is not enough of a reason: the tree has to
 * have actually changed.
 */
async function refreshOnce(): Promise<void> {
  const signature = await readPrototypesSignature();
  const changed = changedPrototypes(lastSignature, signature);
  if (changed.length === 0) return;
  lastSignature = signature;

  prototypesListServed.notify();
  for (const name of changed) notifyHistory(name);
  for (const listener of listeners) listener();

  // A folder that appeared without the mint (made by hand, restored from a
  // backup) gets its history here; a minted one already has it. Last, so a
  // failure to adopt cannot hold back the notifications above.
  await adoptPrototypeHistories();
}

/** Re-read one prototype's history, for whoever is subscribed to it. */
function notifyHistory(name: string): void {
  if (protoIdKind.is(name)) prototypeHistoryServed.notify({ name });
}

// One refresh at a time, with a trailing re-run: a signature read is async, so
// two triggers arriving together must not each compare against a stale
// `lastSignature` and notify twice for one edit.
const refreshes = createCoalescer({
  run: () => runTracked("prototypes:refresh", () => refreshOnce()),
});

/**
 * Sort one batch of watcher events. A version recorded under `_history/`
 * (by this backend or any other — the store is host-global) re-reads that one
 * history and nothing else: the prototype's bytes did not move, so nothing may
 * reload. Picks written under `_picks/` likewise re-read that one prototype's
 * picks and reload nothing — the frames follow on their own, because their `src`
 * carries the picks. A status written under `_status/` re-reads the statuses,
 * and likewise reloads nothing. Everything else goes through the signature gate.
 */
function onTreeEvents(paths: string[]): Promise<void> | undefined {
  let treeMoved = false;
  const recorded = new Set<string>();
  const picked = new Set<string>();
  let statusMoved = false;
  for (const path of paths) {
    const kind = classifyTreePath(prototypesDir.path, path);
    if (kind.kind === "version-recorded") recorded.add(kind.id);
    else if (kind.kind === "picks-recorded") picked.add(kind.id);
    else if (kind.kind === "status-recorded") statusMoved = true;
    else if (kind.kind === "tree") treeMoved = true;
  }
  for (const id of recorded) notifyHistory(id);
  for (const name of picked) prototypePicksServed.notify({ name });
  if (statusMoved) prototypeStatusesServed.notify();
  return treeMoved ? refreshes.run() : undefined;
}

/**
 * Watch `prototypes/` for edits. Push-based — no polling; the 30s reconcile is a
 * backstop for an fsevent parcel drops, and costs one stat per prototype file
 * because it changes nothing when the signature matches.
 */
export async function startPrototypesWatcher(): Promise<void> {
  if (started) return;
  started = true;

  // @parcel/watcher errors if the watched dir doesn't exist; the content is
  // authored separately (and lives outside any checkout), so ensure it exists
  // before subscribing.
  prototypesDir.ensure();

  // The tree as it stands at boot is the baseline, so the first genuine edit is
  // what re-broadcasts — not the first tick after start.
  lastSignature = await readPrototypesSignature();

  // Every prototype that predates version history gets its `v0` — once; after
  // that this is a stat per prototype. Not awaited: boot need not wait on a few
  // hundred milliseconds of git, and every backend on the box races to do it
  // (the store's per-repo lock makes exactly one of them win each prototype).
  void runTracked("prototypes:adopt-histories", () =>
    adoptPrototypeHistories(),
  );

  watcher = await prototypesTreeWatcher.start({
    dirs: [prototypesDir.path],
    onChange: (events) => onTreeEvents(events.map((e) => e.path)),
    onReconcile: () => refreshes.run(),
  });
}

export async function stopPrototypesWatcher(): Promise<void> {
  if (!started) return;
  started = false;
  lastSignature = new Map();
  if (watcher) {
    await watcher.stop();
    watcher = null;
  }
}
