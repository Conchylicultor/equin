import { serveValue } from "@plugins/network/plugins/live/machine";
import { readdir } from "@plugins/packages/plugins/timed-fs/core";
import { createSemaphore } from "@plugins/packages/plugins/semaphore/core";
import { sliceRange } from "@plugins/network/plugins/live/server";
import type { LiveKeyRange } from "@plugins/network/plugins/live/core";
import {
  hostFsDirPeek,
  hostFsListing,
  type HostFsDirPeek,
  type HostFsEntry,
  type HostFsListingMeta,
  type HostFsListResult,
} from "../../core";
import { byName } from "../../server/internal/entry";
import { describeChildren, listHostPath } from "../../server/internal/list";
import { classifyFsError } from "../../server/internal/path";
import { peekHostDir } from "../../server/internal/peek";
import { refusalFor, resolveOrRefuse, resolvedOrNull } from "./refuse";
import { watchHostDir } from "./watch-dir";
import type { UserPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

type Listed = Extract<HostFsListResult, { kind: "ok" }>;

/**
 * Each folder's listing, held while a question of it is subscribed: every
 * page of a folder (and its meta) is cut from ONE read of it, instead of one
 * `readdir` + a `stat` per entry per page. A change the folder's watch hears
 * re-describes only the entries it names (`changed`) at the next read — a
 * folder that never stops changing (`/tmp`) costs O(changed) per re-read, not
 * O(folder); a change that names none (the folder replaced, events lost)
 * drops it for a whole re-read. The last subscriber's leaving drops the
 * folder. Not held at all for a read with no subscriber.
 */
interface Held {
  holders: number;
  /** The listing as of its last (or in-flight) read; null: read it all. */
  listing: Promise<HostFsListResult> | null;
  /** Entries changed since `listing`'s read started, to re-describe. */
  changed: Set<string>;
}

const held = new Map<string, Held>();

/** The listing of the absolute folder `abs` — the held one when there is one. */
async function listingOf(abs: UserPath): Promise<HostFsListResult> {
  const entry = held.get(abs);
  if (entry === undefined) return listHostPath(abs);
  if (entry.listing === null) {
    entry.changed.clear();
    entry.listing = listHostPath(abs);
  } else if (entry.changed.size > 0) {
    const names = entry.changed;
    entry.changed = new Set();
    entry.listing = patchListing(abs, entry.listing, names);
  }
  const listing = entry.listing;
  try {
    return await listing;
  } catch (err) {
    // A failed read is not kept: the next page asks again.
    if (entry.listing === listing) entry.listing = null;
    throw err;
  }
}

/**
 * `base` with the entries `names` described again. Which entries there are is
 * one `readdir` (the folder's own names, so a case-only rename on a
 * case-insensitive volume is not kept twice); only the named entries, and any
 * the base does not have, are described (`lstat`) — the rest keep the base's
 * row. A listing that is not of a folder on disk (a refusal, inside an
 * archive) is read whole instead.
 */
async function patchListing(
  abs: UserPath,
  base: Promise<HostFsListResult>,
  names: ReadonlySet<string>,
): Promise<HostFsListResult> {
  const listed = await base;
  if (listed.kind !== "ok" || listed.within !== undefined) {
    return listHostPath(abs);
  }
  try {
    const present = await readdir(abs);
    const had = new Set(listed.entries.map((e) => e.name));
    const described = await describeChildren(
      abs,
      present.filter((name) => names.has(name) || !had.has(name)),
    );
    const there = new Set(present);
    const kept = listed.entries.filter(
      (e) => there.has(e.name) && !described.has(e.name),
    );
    const fresh = [...described.values()]
      .filter((e): e is HostFsEntry => e.kind !== "vanished")
      .sort(byName);
    return { ...listed, entries: mergeByName(kept, fresh) };
  } catch (err) {
    return { kind: classifyFsError(err), path: listed.path };
  }
}

/** Two lists in name order, merged into one. */
function mergeByName(a: HostFsEntry[], b: HostFsEntry[]): HostFsEntry[] {
  if (b.length === 0) return a;
  const out: HostFsEntry[] = [];
  let i = 0;
  for (const y of b) {
    let x = a[i];
    while (x !== undefined && byName(x, y) <= 0) {
      out.push(x);
      i += 1;
      x = a[i];
    }
    out.push(y);
  }
  return out.concat(a.slice(i));
}

/** The listing `path` asks for, or the refusal saying why there is none. */
async function listedOrRefuse(path: string | undefined): Promise<Listed> {
  const listed = await listingOf(resolveOrRefuse(hostFsListing.refuse, path));
  if (listed.kind !== "ok") throw refusalFor(hostFsListing.refuse, listed);
  return listed;
}

/** Hold `abs`'s listing until the returned release runs. */
function hold(abs: UserPath): () => void {
  const entry = held.get(abs) ?? {
    holders: 0,
    listing: null,
    changed: new Set<string>(),
  };
  entry.holders += 1;
  held.set(abs, entry);
  return () => {
    entry.holders -= 1;
    if (entry.holders === 0) held.delete(abs);
  };
}

/** One page of a folder's entries: its range of the held listing. */
export async function listingPage(
  q: { path?: string },
  range: LiveKeyRange,
): Promise<HostFsEntry[]> {
  return sliceRange(
    hostFsListing,
    (await listedOrRefuse(q.path)).entries,
    range,
  );
}

/** What a folder's listing says about the folder (the meta sibling). */
export async function listingMeta(q: {
  path?: string;
}): Promise<HostFsListingMeta> {
  const listed = await listedOrRefuse(q.path);
  return {
    path: listed.path,
    parent: listed.parent,
    total: listed.entries.length,
    ...(listed.within !== undefined ? { within: listed.within } : {}),
  };
}

/**
 * At most this many peeks read at once. A tree reads one per visible folder
 * row, each its own subscription; bounded so a scroll through many folders
 * costs a few `readdir`s at a time, as the batched endpoint it replaced did.
 */
const PEEK_CONCURRENCY = 8;
const peeks = createSemaphore(PEEK_CONCURRENCY);

/** A folder's child names, or the refusal saying why there are none. */
export async function dirPeek(path: string): Promise<HostFsDirPeek> {
  const abs = resolveOrRefuse(hostFsDirPeek.refuse, path);
  const peeked = await peeks.run(() => peekHostDir(abs));
  switch (peeked.kind) {
    case "ok":
    case "too-many":
    case "archive":
      return peeked;
    case "missing":
    case "denied":
    case "not-a-dir":
    case "unreadable-archive":
      throw refusalFor(hostFsDirPeek.refuse, peeked);
  }
}

/**
 * A folder's entries, paged by name: every page — and the meta — cut from the
 * folder's held listing, pushed from a watch of the folder for as long as a
 * question of it is read (`watchHostDir`: its entries, or its own entry while
 * it is not there; the archive file, inside one). Throttled: a folder being
 * written (a download, a build) is re-read at most once a second, and then
 * only the entries that changed.
 */
export const hostFsListingServed = serveValue(hostFsListing, {
  source: "external",
  changes: "notified",
  throttleMs: 1_000,
  loader: listingPage,
  meta: listingMeta,
  whileSubscribed: async (q, notify) => {
    const abs = resolvedOrNull(q.path);
    // The loader refuses the spelling; there is nothing to watch.
    if (abs === null) return () => {};
    return holdListingOver(watchHostDir, abs, notify);
  },
});

/**
 * Hold `abs`'s listing while a watch of it (`watchDir`: {@link watchHostDir},
 * or a test's) is open: each change it hears marks the entries to describe
 * again (or the whole folder), then `notify`s.
 */
export async function holdListingOver(
  watchDir: typeof watchHostDir,
  abs: UserPath,
  notify: () => void,
): Promise<() => void> {
  const release = hold(abs);
  try {
    const stop = await watchDir(abs, (change) => {
      const entry = held.get(abs);
      if (entry !== undefined) {
        if (change.kind === "all") entry.listing = null;
        else for (const name of change.names) entry.changed.add(name);
      }
      notify();
    });
    return () => {
      stop();
      release();
    };
  } catch (err) {
    release();
    throw err;
  }
}

/**
 * A folder's child names (`peek`), pushed from a watch of the folder while
 * read. `ok` / `too-many` / `archive` are answers; every failure is a refusal.
 */
export const hostFsDirPeekServed = serveValue(hostFsDirPeek, {
  source: "external",
  changes: "notified",
  throttleMs: 1_000,
  loader: ({ path }) => dirPeek(path),
  whileSubscribed: async ({ path }, notify) => {
    const abs = resolvedOrNull(path);
    if (abs === null) return () => {};
    return watchHostDir(abs, () => notify());
  },
});
