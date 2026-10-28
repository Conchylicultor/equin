import type { z } from "zod";
import {
  readText,
  relPath,
  type Mount,
  type RelPath,
} from "@plugins/infra/plugins/paths/plugins/data-files/core";
import type { WriteOrigin } from "@plugins/infra/plugins/request-origin/core";
import { protoIdKind } from "../core";

// A small JSON record per prototype, kept BESIDE the folders in a `_`-prefixed
// dir of the data dir: `<prototypes>/_<kind>/<id>.json`. The user's option
// picks (`picks.ts`) are one. (The Done / pinned status was another, until it
// moved into the instance's DB — `apps/prototypes/state`.)
//
// Beside the folders, not in them: a record inside a prototype would churn its
// signature (a reload of every open frame), its thumbnail fingerprint and its
// version history — and a pick is not part of the design. The
// dir is `_`-prefixed, so every reader of the tree skips it the way it skips
// `_template/` and `_history/` (`listPrototypeDirNames`).
//
// Over a `Mount`, in `shared/`: the server serves and writes the records
// through the `prototypesFiles` root, and `./equin prototype …` reads the same
// files with no backend running, through a disk mount of the data dir.

/** A record file's extension — the one the watcher's extension filter passes. */
export const RECORD_FILE_EXT = ".json";

/** What one kind of record is. */
export interface RecordKind<R, C> {
  /** The dir's name inside the prototypes data dir (`_picks`). */
  dirName: string;
  /** How a malformed file is named in its error (`prototype picks`). */
  label: string;
  schema: z.ZodType<R>;
  /** The record a prototype has when there is no file. Writing it removes the file. */
  empty: R;
  /** `record` with `change` applied — the one fold. */
  apply: (record: R, change: C) => R;
  /** Same content — a change that leaves this true writes nothing. */
  equal: (a: R, b: R) => boolean;
}

export interface RecordStore<R, C> {
  /** A prototype's record file inside the tree (present or not). */
  fileOf(id: string): RelPath;
  /** The stored record; `empty` when there is no file. A malformed file throws. */
  read(id: string): Promise<R>;
  /**
   * Every present record, keyed by prototype id. A prototype with no file is
   * absent (its record is `empty`). A malformed file throws.
   */
  readAll(): Promise<Record<string, R>>;
  /**
   * Apply one change under the prototype's lock (read → fold → write), and
   * answer with the record it left. A change leaving `empty` removes the file.
   * A change that changes nothing writes nothing. `writer` is who asked: the
   * root ledgers an automated session's write (`prototypesFiles`' ledger), so
   * its harness can put the file back.
   */
  write(id: string, change: C, writer: WriteOrigin): Promise<R>;
}

/**
 * The store of one record kind over a prototypes tree — the `prototypesFiles`
 * root on a server, a disk mount of the data dir in the CLI, a temp dir or a
 * memory root in a test.
 */
export function openRecordStore<R, C>(
  mount: Mount,
  kind: RecordKind<R, C>,
): RecordStore<R, C> {
  const fileOf = (id: string): RelPath =>
    relPath(kind.dirName, `${assertPrototypeId(id)}${RECORD_FILE_EXT}`);
  // One lock per prototype — on disk the flock `_<kind>/<id>.lock`, never
  // unlinked, the same file every backend and the CLI take. Its extension is
  // not one the watch passes.
  const lockOf = (id: string): RelPath =>
    relPath(kind.dirName, assertPrototypeId(id));

  async function read(id: string): Promise<R> {
    const state = await readText(mount, fileOf(id));
    return state.kind === "text" ? parse(fileOf(id), state.text) : kind.empty;
  }

  /**
   * Parse a record file. Malformed is a THROW, never `empty`: an unreadable
   * record is not "nothing recorded", and answering as if it were would show
   * the empty state while claiming it is the user's choice — then the next
   * write would overwrite the file and lose whatever was in it.
   */
  function parse(path: RelPath, bytes: string): R {
    let json: unknown;
    try {
      json = JSON.parse(bytes);
    } catch (err) {
      throw new Error(`malformed ${kind.label} file ${path}: ${String(err)}`);
    }
    const parsed = kind.schema.safeParse(json);
    if (!parsed.success) {
      throw new Error(
        `malformed ${kind.label} file ${path}: ${parsed.error.message}`,
      );
    }
    return parsed.data;
  }

  return {
    fileOf,
    read,

    async readAll() {
      const listed = await mount.list(relPath(kind.dirName));
      // No dir yet: nobody has written a record of this kind.
      if (listed.kind === "missing") return {};
      const records: Record<string, R> = {};
      for (const entry of listed.entries) {
        if (entry.kind !== "file" || !entry.name.endsWith(RECORD_FILE_EXT)) {
          continue;
        }
        const id = entry.name.slice(0, -RECORD_FILE_EXT.length);
        // A file the store could not have written (a hand-made name) names no
        // prototype, so it holds no record of one.
        if (!protoIdKind.is(id)) continue;
        records[id] = await read(id);
      }
      return records;
    },

    write(id, change, writer) {
      return mount.withLock(lockOf(id), async () => {
        const before = await read(id);
        const after = kind.apply(before, change);
        if (kind.equal(before, after)) return before;

        if (kind.equal(after, kind.empty)) {
          await mount.remove(fileOf(id), { writer, recursive: false });
        } else {
          // Pretty JSON, so a person can read it too. Atomic: the mount writes
          // a temp file (an extension the watch does not pass) and renames it.
          await mount.write(fileOf(id), `${JSON.stringify(after, null, 2)}\n`, {
            writer,
          });
        }
        return after;
      });
    },
  };
}

// Every id becomes a path, so it is checked before it touches the tree: a route
// answers 404 for a name that is not an id before it gets here, so past that a
// bad id is a caller bug, and the store throws.
function assertPrototypeId(id: string): string {
  if (!protoIdKind.is(id)) {
    throw new Error(`not a prototype id: ${JSON.stringify(id)}`);
  }
  return id;
}
