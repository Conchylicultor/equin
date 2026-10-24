import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { ZodParser } from "@plugins/packages/plugins/zod-parser/core";
import { protoIdKind } from "../core";
import { withHistoryLock } from "./history/lock";

// A small JSON record per prototype, kept BESIDE the folders in a `_`-prefixed
// dir of the data dir: `<prototypes>/_<kind>/<id>.json`. The user's option
// picks (`picks.ts`) and the prototype's status (`status.ts`) are two of them.
//
// Beside the folders, not in them: a record inside a prototype would churn its
// signature (a reload of every open frame), its thumbnail fingerprint and its
// version history — and neither a pick nor a status is part of the design. The
// dir is `_`-prefixed, so every reader of the tree skips it the way it skips
// `_template/` and `_history/` (`listPrototypeDirNames`).
//
// Node-only and in `shared/` for the reason `history/store.ts` is: the server
// serves and writes the records, and `./equin prototype …` reads the same
// files with no backend running.

/** A record file's extension — the one the watcher's extension filter passes. */
export const RECORD_FILE_EXT = ".json";

/** A record file's state. `present: false` is "no file" — the empty record — not "empty". */
export type RecordFileSnapshot =
  { present: false } | { present: true; bytes: string };

/**
 * Callbacks run INSIDE the prototype's lock, around the one write a change
 * makes — so what they read of the file is exactly what this write replaced
 * and what it left, with no other writer in between. Neither runs when the
 * change changes nothing.
 */
export interface RecordWriteHooks {
  beforeWrite?: () => void;
  afterWrite?: () => void;
}

/** What one kind of record is. */
export interface RecordKind<R, C> {
  /** The dir's name inside the prototypes data dir (`_picks`). */
  dirName: string;
  /** How a malformed file is named in its error (`prototype picks`). */
  label: string;
  schema: ZodParser<R>;
  /** The record a prototype has when there is no file. Writing it removes the file. */
  empty: R;
  /** `record` with `change` applied — the one fold. */
  apply: (record: R, change: C) => R;
  /** Same content — a change that leaves this true writes nothing. */
  equal: (a: R, b: R) => boolean;
}

export interface RecordStore<R, C> {
  /** The absolute path of a prototype's record file (present or not). */
  fileOf(id: string): string;
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
   * A change that changes nothing writes nothing.
   */
  write(id: string, change: C, hooks?: RecordWriteHooks): Promise<R>;
  /** Put the file back to exactly `snapshot` (its bytes, or no file), under the lock. */
  restore(id: string, snapshot: RecordFileSnapshot): Promise<void>;
}

/**
 * The store of one record kind over a prototypes tree at `root` — resolved by
 * the caller (`prototypesDir.path`, per call; the tests pass a temp dir), like
 * `openHistoryStore`.
 */
export function openRecordStore<R, C>(
  root: string,
  kind: RecordKind<R, C>,
): RecordStore<R, C> {
  const dir = join(root, kind.dirName);
  const fileOf = (id: string) =>
    join(dir, `${assertPrototypeId(id)}${RECORD_FILE_EXT}`);
  // One flock per prototype, never unlinked (see `withHistoryLock`). Its
  // extension is not one the watcher passes.
  const lockOf = (id: string) => join(dir, `${assertPrototypeId(id)}.lock`);

  async function readFileState(id: string): Promise<RecordFileSnapshot> {
    try {
      return { present: true, bytes: await readFile(fileOf(id), "utf8") };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { present: false };
      }
      throw err;
    }
  }

  async function read(id: string): Promise<R> {
    const state = await readFileState(id);
    return state.present ? parse(fileOf(id), state.bytes) : kind.empty;
  }

  /**
   * Parse a record file. Malformed is a THROW, never `empty`: an unreadable
   * record is not "nothing recorded", and answering as if it were would show
   * the empty state while claiming it is the user's choice — then the next
   * write would overwrite the file and lose whatever was in it.
   */
  function parse(path: string, bytes: string): R {
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

  async function writeBytes(id: string, bytes: string): Promise<void> {
    const path = fileOf(id);
    // `.tmp`, not `.json`: the watcher's extension filter must not pass the
    // temp — the same rule as the history's `latest.json` stamp.
    const temp = `${path}.tmp`;
    await writeFile(temp, bytes);
    await rename(temp, path);
  }

  async function locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
    await mkdir(dir, { recursive: true });
    return withHistoryLock(lockOf(id), fn);
  }

  return {
    fileOf,
    read,

    async readAll() {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch (err) {
        // No dir yet: nobody has written a record of this kind.
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
        throw err;
      }
      const records: Record<string, R> = {};
      for (const name of names) {
        if (!name.endsWith(RECORD_FILE_EXT)) continue;
        const id = name.slice(0, -RECORD_FILE_EXT.length);
        // A file the store could not have written (a hand-made name) names no
        // prototype, so it holds no record of one.
        if (!protoIdKind.is(id)) continue;
        records[id] = await read(id);
      }
      return records;
    },

    write(id, change, hooks = {}) {
      return locked(id, async () => {
        const before = await read(id);
        const after = kind.apply(before, change);
        if (kind.equal(before, after)) return before;

        hooks.beforeWrite?.();
        if (kind.equal(after, kind.empty)) {
          await rm(fileOf(id), { force: true });
        } else {
          // Pretty JSON, so a person can read it too.
          await writeBytes(id, `${JSON.stringify(after, null, 2)}\n`);
        }
        hooks.afterWrite?.();
        return after;
      });
    },

    restore(id, snapshot) {
      return locked(id, async () => {
        if (snapshot.present) await writeBytes(id, snapshot.bytes);
        else await rm(fileOf(id), { force: true });
      });
    },
  };
}

// Every id becomes a path, so it is checked before it touches the filesystem:
// a route answers 404 for a name that is not an id before it gets here, so past
// that a bad id is a caller bug, and the store throws.
function assertPrototypeId(id: string): string {
  if (!protoIdKind.is(id)) {
    throw new Error(`not a prototype id: ${JSON.stringify(id)}`);
  }
  return id;
}
