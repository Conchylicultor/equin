import { serveValue } from "@plugins/network/plugins/live/machine";
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
import { listHostPath } from "../../server/internal/list";
import { peekHostDir } from "../../server/internal/peek";
import { refusalFor, resolveOrRefuse, resolvedOrNull } from "./refuse";
import { watchHostDir } from "./watch-dir";

type Listed = Extract<HostFsListResult, { kind: "ok" }>;

/**
 * Each folder's listing, held while a question of it is subscribed: every
 * page of a folder (and its meta) is cut from ONE read of it, instead of one
 * `readdir` + a `stat` per entry per page. A change the folder's watch hears
 * drops it before the pages re-read; the last subscriber's leaving drops the
 * folder. Not held at all for a read with no subscriber.
 */
const held = new Map<
  string,
  { holders: number; listing: Promise<HostFsListResult> | null }
>();

/** The listing of the absolute folder `abs` — the held one when there is one. */
async function listingOf(abs: string): Promise<HostFsListResult> {
  const entry = held.get(abs);
  if (entry === undefined) return listHostPath(abs);
  entry.listing ??= listHostPath(abs);
  const listing = entry.listing;
  try {
    return await listing;
  } catch (err) {
    // A failed read is not kept: the next page asks again.
    if (entry.listing === listing) entry.listing = null;
    throw err;
  }
}

/** The listing `path` asks for, or the refusal saying why there is none. */
async function listedOrRefuse(path: string | undefined): Promise<Listed> {
  const listed = await listingOf(resolveOrRefuse(hostFsListing.refuse, path));
  if (listed.kind !== "ok") throw refusalFor(hostFsListing.refuse, listed);
  return listed;
}

/** Hold `abs`'s listing until the returned release runs. */
function hold(abs: string): () => void {
  const entry = held.get(abs) ?? { holders: 0, listing: null };
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
 * written (a download, a build) re-lists at most once a second.
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
    const release = hold(abs);
    try {
      const stop = await watchHostDir(abs, () => {
        const entry = held.get(abs);
        if (entry !== undefined) entry.listing = null;
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
  },
});

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
