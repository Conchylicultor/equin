import type { Mount } from "@plugins/infra/plugins/paths/plugins/data-files/core";
import { createSemaphore } from "@plugins/packages/plugins/semaphore/core";
import { nonTokenNamesOf, type PrototypeMeta } from "../../core";
import {
  listingKey,
  metaOf,
  readFolderListing,
  scanPrototype,
  type FolderListing,
  type ScannedPrototype,
} from "../../shared/list-metas";
import {
  isPrototypeDirName,
  listPrototypeDirNames,
} from "../../shared/read-folder";

// The prototypes tree as the server holds it: one record per folder, moved by
// the watch and nothing else. The gallery list is composed from the records —
// no file system call — so reading it costs the same however often it is read,
// and an edit costs a re-read of the one folder it touched.
//
// Why records rather than re-listing on each read: a list read used to stat and
// list every folder (~570 calls for 132 prototypes, one after another), which
// on a host whose stats stall took 5–24 s, held a read-admission slot the whole
// time, and left other tabs' subscriptions unanswered behind it. The watch
// already names the folders that moved; the records are what it moves.

/** One folder: its listing, and its bytes read once some reader asked. */
interface FolderRecord {
  listing: FolderListing;
  key: string;
  /**
   * The folder read, validated and parsed — on the first list after the record
   * was (re)made, never before (a backend nobody opens the gallery on reads no
   * prototype's bytes). Kept only while readable.
   */
  scanned: Promise<ScannedPrototype> | null;
}

/** What one refresh moved. */
export interface RecordsRefresh {
  /**
   * The prototypes whose files moved — added, removed or edited (signature:
   * every file's size and mtime), by name. Exactly the ones whose `rev`, and so
   * their open frames, change.
   */
  moved: string[];
  /** Whether anything the list shows may have changed (`moved`, or a subdir or birth time). */
  listChanged: boolean;
}

/** The folders a refresh re-reads: every one (a rescan, the baseline), or these. */
export type RecordsScope = "all" | ReadonlySet<string>;

/**
 * The records over one tree. The server holds one, over `prototypesFiles`
 * (`watcher.ts`); a test holds its own over a mount.
 */
export class PrototypeRecords {
  /** `null` until the first refresh of `"all"`: nothing to compose from yet. */
  private records: Map<string, FolderRecord> | null = null;
  /**
   * Resolves once the first refresh of `"all"` settles, whenever it starts: a list
   * read before the watcher loaded the records (a sub landing during boot)
   * waits for them rather than failing — a failed loader would stay failed,
   * since nothing re-notifies the list once the baseline lands.
   */
  private firstLoad = Promise.withResolvers<void>();
  /**
   * Folder reads at once: a first list after boot reads every folder (~300
   * files), which must not open them all together.
   */
  private readonly reads = createSemaphore(8);

  constructor(private readonly mount: Mount) {}

  /** Whether a refresh of `"all"` has completed — what a scoped refresh needs. */
  loaded(): boolean {
    return this.records !== null;
  }

  /** Whether a prototype of this name is in the records. */
  has(name: string): boolean {
    return this.records?.has(name) === true;
  }

  /**
   * Forget everything (the watcher stopped): nothing moves the records any
   * more, so nothing may be composed from them.
   */
  reset(): void {
    this.records = null;
    this.firstLoad = Promise.withResolvers<void>();
  }

  /** Every prototype name in the records, sorted. */
  names(): string[] {
    if (this.records === null) throw notLoaded();
    return [...this.records.keys()].sort();
  }

  /**
   * Re-read the listings of `scope`'s folders (a stat and a listing each — no
   * file read) and replace the records whose listing moved. A record whose
   * listing did not move keeps its scan.
   *
   * Callers serialize refreshes (the watcher's coalescer): two at once could
   * each apply an older listing over a newer one.
   */
  async refresh(scope: RecordsScope): Promise<RecordsRefresh> {
    if (scope === "all") {
      const first = this.records === null;
      const all = this.refreshAll();
      if (!first) return all;
      // Settled either way: the caller owns (and reports) a failure; a list
      // waiting on a baseline that failed then finds no records and throws.
      return all.finally(() => this.firstLoad.resolve());
    }
    if (this.records === null) throw notLoaded();
    const records = this.records;
    const names = [...scope].filter(isPrototypeDirName);
    const listings = await Promise.all(
      names.map((name) => readFolderListing(this.mount, name)),
    );
    const moved: string[] = [];
    let listChanged = false;
    names.forEach((name, i) => {
      const outcome = this.apply(records, name, listings[i] ?? null);
      if (outcome.moved) moved.push(name);
      if (outcome.changed) listChanged = true;
    });
    return { moved, listChanged };
  }

  private async refreshAll(): Promise<RecordsRefresh> {
    const names = await listPrototypeDirNames(this.mount);
    // Every folder at once, not one after another: each is a stat and a
    // listing, and in series each await queues behind whatever else holds the
    // event loop.
    const listings = await Promise.all(
      names.map((name) => readFolderListing(this.mount, name)),
    );
    const previous = this.records;
    const records = new Map<string, FolderRecord>();
    names.forEach((name, i) => {
      const listing = listings[i] ?? null;
      if (listing === null) return;
      const known = previous?.get(name);
      const key = listingKey(listing);
      records.set(
        name,
        known?.key === key ? known : { listing, key, scanned: null },
      );
    });
    const moved: string[] = [];
    let listChanged = previous === null;
    for (const [name, record] of records) {
      const known = previous?.get(name);
      if (known?.listing.signature !== record.listing.signature)
        moved.push(name);
      if (known?.key !== record.key) listChanged = true;
    }
    for (const name of previous?.keys() ?? []) {
      if (records.has(name)) continue;
      moved.push(name);
      listChanged = true;
    }
    this.records = records;
    return { moved, listChanged };
  }

  /** Put one folder's fresh listing (`null`: gone) into `records`. */
  private apply(
    records: Map<string, FolderRecord>,
    name: string,
    listing: FolderListing | null,
  ): { moved: boolean; changed: boolean } {
    const known = records.get(name);
    if (listing === null) {
      if (known === undefined) return { moved: false, changed: false };
      records.delete(name);
      return { moved: true, changed: true };
    }
    const key = listingKey(listing);
    if (known?.key === key) return { moved: false, changed: false };
    records.set(name, { listing, key, scanned: null });
    return {
      moved: known?.listing.signature !== listing.signature,
      changed: true,
    };
  }

  /**
   * Every prototype, as the gallery lists it — composed from the records: only
   * a folder whose record was (re)made since the last list has its bytes read.
   * Each folder's references are judged against the names in the records now.
   */
  async list(): Promise<PrototypeMeta[]> {
    // A read landing before the boot baseline is read waits for it.
    if (this.records === null) await this.firstLoad.promise;
    if (this.records === null)
      throw new Error(
        "the prototypes records' first load failed (reported by the files watcher) — the next refresh of the tree retries it",
      );
    const names = this.names();
    const nonTokenNames = nonTokenNamesOf(names);
    const records = this.records;
    const scanned = await Promise.all(
      names.map((name) => {
        const record = records.get(name);
        if (record === undefined) throw new Error(`no record for ${name}`);
        return this.scanned(name, record, nonTokenNames);
      }),
    );
    return scanned.map((s) => metaOf(s, names));
  }

  /** `record`'s scan, read now when it has none (or one judged against other non-token names). */
  private scanned(
    name: string,
    record: FolderRecord,
    nonTokenNames: readonly string[],
  ): Promise<ScannedPrototype> {
    const held = record.scanned;
    if (held !== null) {
      return held.then((s) =>
        !s.readable || sameNames(s.scan.nonTokenNames, nonTokenNames)
          ? s
          : this.rescan(name, record, nonTokenNames),
      );
    }
    return this.rescan(name, record, nonTokenNames);
  }

  private rescan(
    name: string,
    record: FolderRecord,
    nonTokenNames: readonly string[],
  ): Promise<ScannedPrototype> {
    // An unreadable folder's error is the moment's, and so is a failed read:
    // neither is kept, so the next list reads the folder again.
    const read: Promise<ScannedPrototype> = this.reads
      .run(() => scanPrototype(this.mount, name, record.listing, nonTokenNames))
      .then(
        (s) => {
          if (!s.readable && record.scanned === read) record.scanned = null;
          return s;
        },
        (err: unknown) => {
          if (record.scanned === read) record.scanned = null;
          throw err;
        },
      );
    record.scanned = read;
    return read;
  }
}

function sameNames(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, i) => name === b[i]);
}

function notLoaded(): Error {
  return new Error(
    "the prototypes records are read before their first refresh — the files watcher (started in onReady) loads them",
  );
}
