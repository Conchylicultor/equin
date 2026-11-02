import { z } from "zod";
import {
  parseRelPath,
  type Mount,
  type RelPath,
} from "@plugins/infra/plugins/paths/plugins/data-files/core";
import { systemOrigin } from "@plugins/infra/plugins/request-origin/core";
import { wholeRecord } from "@plugins/packages/plugins/list-bound/core";
import type { FingerprintMemo } from "./hash-dir";

/**
 * The fingerprint memo, persisted: which content key each prototype folder
 * hashed to at which listing, in ONE file of the thumbnail cache root
 * (`fingerprints/memo.json`) — host-global like the prototypes tree it
 * describes, so a folder is read and hashed once per host per change, not once
 * per backend per boot. Under a subdirectory, so the cache's age sweep (which
 * unlinks the root's flat files) never takes it or its lock.
 *
 * It is a cache in the strict sense: losing it costs one re-hash per folder,
 * never a wrong key (a listing it does not hold is hashed). Concurrent
 * backends merge into it under the root's lock; the file is written only when
 * this process learned or forgot something, so a boot over an unchanged tree
 * writes nothing.
 */

const MEMO_FILE = parseRelPath("fingerprints/memo.json");
const MEMO_LOCK = parseRelPath("fingerprints/memo");

/**
 * Bumped when the listing's spelling OR `fingerprintFiles`' byte stream
 * changes: an older file is a cold memo.
 */
const MEMO_VERSION = 1;

const MemoEntrySchema = z.object({ listing: z.string(), key: z.string() });
type MemoEntry = z.infer<typeof MemoEntrySchema>;

const MemoFileSchema = z.object({
  version: z.literal(MEMO_VERSION),
  folders: wholeRecord(MemoEntrySchema, {
    reason: "one entry per prototype folder — bounded by the prototypes tree",
  }),
});

const writer = systemOrigin("prototype thumbnail fingerprint memo");

/** One root's persisted memo, loaded once per process and merged on save. */
export interface PersistedFingerprintMemo {
  /** The memo to fingerprint with — loaded from the file on first use. */
  load(): Promise<FingerprintMemo>;
  /** Drop every folder not in `names` (a full sync's listing) on next save. */
  retainOnly(names: readonly string[]): Promise<void>;
  /** Write what this process learned or forgot since; nothing when neither. */
  save(): Promise<void>;
}

export function persistedFingerprintMemo(
  root: Mount,
): PersistedFingerprintMemo {
  let folders: Promise<Map<string, MemoEntry>> | undefined;
  const learned = new Map<string, MemoEntry>();
  const forgotten = new Set<string>();

  // A failed load is not kept: the next sync reads (and fails) again.
  const loaded = (): Promise<Map<string, MemoEntry>> =>
    (folders ??= readMemoFile(root).catch((err: unknown) => {
      folders = undefined;
      throw err;
    }));

  return {
    async load() {
      const map = await loaded();
      return {
        known: (dir: RelPath, listing: string) => {
          const entry = map.get(dir);
          return entry?.listing === listing ? entry.key : undefined;
        },
        learned: (dir: RelPath, listing: string, key: string) => {
          const entry = { listing, key };
          map.set(dir, entry);
          learned.set(dir, entry);
          forgotten.delete(dir);
        },
      };
    },
    async retainOnly(names) {
      const map = await loaded();
      const keep = new Set(names);
      for (const name of map.keys()) {
        if (keep.has(name)) continue;
        map.delete(name);
        learned.delete(name);
        forgotten.add(name);
      }
    },
    async save() {
      if (learned.size === 0 && forgotten.size === 0) return;
      const learnedNow = new Map(learned);
      const forgottenNow = new Set(forgotten);
      learned.clear();
      forgotten.clear();
      try {
        await writeMerged(root, learnedNow, forgottenNow);
      } catch (err) {
        // Unsaved, so still owed: the next save retries it (a later learn or
        // forget of the same folder wins).
        for (const [name, entry] of learnedNow)
          if (!learned.has(name) && !forgotten.has(name))
            learned.set(name, entry);
        for (const name of forgottenNow)
          if (!learned.has(name)) forgotten.add(name);
        throw err;
      }
    },
  };
}

async function writeMerged(
  root: Mount,
  learnedNow: ReadonlyMap<string, MemoEntry>,
  forgottenNow: ReadonlySet<string>,
): Promise<void> {
  await root.withLock(MEMO_LOCK, async () => {
    // Another backend may have saved since this one loaded: merge onto
    // what is on disk now, so neither drops the other's entries.
    const merged = await readMemoFile(root);
    for (const name of forgottenNow) merged.delete(name);
    for (const [name, entry] of learnedNow) merged.set(name, entry);
    await root.write(
      MEMO_FILE,
      JSON.stringify({
        version: MEMO_VERSION,
        folders: Object.fromEntries(merged),
      } satisfies z.infer<typeof MemoFileSchema>),
      { writer },
    );
  });
}

async function readMemoFile(root: Mount): Promise<Map<string, MemoEntry>> {
  const read = await root.read(MEMO_FILE);
  // Never saved on this host yet: every folder is hashed once.
  if (read.kind === "missing") return new Map();
  const json: unknown = JSON.parse(await read.blob.text());
  // A memo in an older listing spelling vouches for nothing: start cold.
  if (
    typeof json === "object" &&
    json !== null &&
    "version" in json &&
    json.version !== MEMO_VERSION
  ) {
    return new Map();
  }
  // Anything else unparseable is a bug in this file's own writes — loud.
  return new Map(Object.entries(MemoFileSchema.parse(json).folders));
}
