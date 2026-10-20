import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  HOST_FS_PEEK_MAX_NAMES,
  hostFsListing,
  type HostFsEntry,
  type HostFsListingMeta,
} from "@plugins/infra/plugins/host-fs/core";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  foldResource,
  type ResourceError,
} from "@plugins/primitives/plugins/live-state/web";
import type { FolderRefusal } from "../../core";

/**
 * One directory's listing as the explorer holds it — the `host-fs.list` pages
 * and their meta sibling, read together. A refusal (a missing, denied, not-a-
 * folder or unreadable folder) is `refused`, apart from a read that failed
 * (`failed`); `unavailable` is a build with no computer behind it.
 */
export type Listing =
  | { kind: "loading" }
  | { kind: "unavailable"; message: string }
  | (FolderRefusal & { refetch: () => Promise<void> })
  | { kind: "failed"; error: ResourceError; refetch: () => Promise<void> }
  | {
      kind: "ok";
      meta: HostFsListingMeta;
      /** In code-point name order; at most {@link HOST_FS_PEEK_MAX_NAMES}. */
      entries: readonly HostFsEntry[];
      /**
       * A re-read of a listing already shown failed: `entries` are the last
       * the server vouched for, kept rather than blanking the folder.
       */
      refreshError?: { error: ResourceError; refetch: () => Promise<void> };
    };

/** Every listing a browser holds, by the path it was asked under. */
export type Listings = ReadonlyMap<string, Listing>;

/**
 * Whether `dir` was listed from the disk itself — not from inside an archive
 * (`within`), whose entries cannot be written to.
 */
export function isOnDisk(listings: Listings, dir: string): boolean {
  const listing = listings.get(dir);
  return listing?.kind === "ok" && listing.meta.within === undefined;
}

/**
 * How many of a listed folder's entries it holds past what was read (the
 * read stops at {@link HOST_FS_PEEK_MAX_NAMES}); 0 when it holds them all.
 */
export function unlistedCount(listing: Listing | undefined): number {
  if (listing?.kind !== "ok") return 0;
  return Math.max(0, listing.meta.total - listing.entries.length);
}

/**
 * The listings of `root` and of every folder the tree has open, and the
 * `readers` that read them — render them once, anywhere under the hook's
 * component (they draw nothing).
 *
 * Each folder is one `host-fs.list` read (`useLive`, every page live, up to
 * {@link HOST_FS_PEEK_MAX_NAMES} entries — the most a reader with no
 * viewport holds) plus its meta, pushed while read from a watch of the
 * folder, so a listing is never older than the disk. One read per folder, by
 * a reader component each: a paged value has no list form
 * (`useLive(v, [...])`).
 *
 * Liveness follows what the tree draws: a folder is read while it is open
 * (`setOpen`, the tree's `onOpenChange`) or asked for (`request`, its lazy
 * `load`); once it closes its reader unmounts — its subscription, the
 * server's held listing and its watch go — and its last listing stays,
 * shown again at once when it re-opens while the new read lands.
 */
export function useListings(root: string): {
  listings: Listings;
  /** Ask for a folder's listing (the tree's lazy `load`). */
  request: (path: string) => void;
  /** The folders the tree has open now (the tree's `onOpenChange`). */
  setOpen: (paths: readonly string[]) => void;
  readers: ReactNode;
} {
  const [open, setOpenPaths] = useState<readonly string[]>([]);
  const [held, setHeld] = useState<ReadonlyMap<string, Listing>>(
    () => new Map(),
  );
  const paths = useMemo(
    () => [root, ...open.filter((p) => p !== root)],
    [root, open],
  );
  const request = useCallback(
    (path: string) =>
      setOpenPaths((prev) => (prev.includes(path) ? prev : [...prev, path])),
    [],
  );
  const setOpen = useCallback(
    (next: readonly string[]) =>
      setOpenPaths((prev) =>
        prev.length === next.length && prev.every((p, i) => p === next[i])
          ? prev
          : next,
      ),
    [],
  );
  const report = useCallback(
    (path: string, listing: Listing) =>
      setHeld((prev) => {
        const before = prev.get(path);
        if (before === listing) return prev;
        // A folder re-opened shows its last listing until the new read lands.
        if (listing.kind === "loading" && before?.kind === "ok") return prev;
        const next = new Map(prev);
        next.set(path, listing);
        return next;
      }),
    [],
  );
  const listings = useMemo<Listings>(() => {
    const all = new Map<string, Listing>();
    // A closed folder's last listing: its rows stay (the tree hides them).
    for (const [p, listing] of held)
      if (listing.kind === "ok") all.set(p, listing);
    for (const p of paths) all.set(p, held.get(p) ?? { kind: "loading" });
    return all;
  }, [paths, held]);
  const readers = paths.map((p) => (
    <ListingReader key={p} path={p} report={report} />
  ));
  return { listings, request, setOpen, readers };
}

/** A listing read's failure: its refusal, or a read that failed. */
function failure(
  error: ResourceError<FolderRefusal["code"]>,
  refetch: () => Promise<void>,
): Listing {
  return error.kind === "refused" && error.code !== undefined
    ? { kind: "refused", code: error.code, message: error.message, refetch }
    : { kind: "failed", error, refetch };
}

/** Reads one folder's listing and hands every new state of it to `report`. */
function ListingReader({
  path,
  report,
}: {
  path: string;
  report: (path: string, listing: Listing) => void;
}): ReactNode {
  const pages = useLive(
    hostFsListing,
    { path },
    { limit: HOST_FS_PEEK_MAX_NAMES },
  );
  const meta = useLive(hostFsListing.meta, { path });
  const listing = useMemo((): Listing => {
    if (pages.status === "unavailable") {
      return { kind: "unavailable", message: pages.message };
    }
    if (meta.status === "unavailable") {
      return { kind: "unavailable", message: meta.message };
    }
    // What each read holds now: its value, or — once a re-read failed — the
    // last one the server vouched for; nothing while loading.
    const entries = foldResource(pages, {
      loading: () => undefined,
      error: (_error, stale) => stale,
      ready: (data) => data,
    });
    const known = foldResource(meta, {
      loading: () => undefined,
      error: (_error, stale) => stale,
      ready: (data) => data,
    });
    // A refresh that failed keeps the rows already shown; a refusal (the
    // folder is gone, or no longer readable) is the server's answer.
    const failedRead = (
      error: ResourceError<FolderRefusal["code"]>,
      refetch: () => Promise<void>,
    ): Listing =>
      error.kind !== "refused" && entries !== undefined && known !== undefined
        ? { kind: "ok", meta: known, entries, refreshError: { error, refetch } }
        : failure(error, refetch);
    if (pages.status === "error") return failedRead(pages.error, pages.refetch);
    if (meta.status === "error") return failedRead(meta.error, meta.refetch);
    if (pages.status === "loading" || meta.status === "loading") {
      return { kind: "loading" };
    }
    return { kind: "ok", meta: meta.data, entries: pages.data };
  }, [pages, meta]);
  useEffect(() => report(path, listing), [report, path, listing]);
  return null;
}
