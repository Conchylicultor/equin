import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOME_DIR } from "@plugins/infra/plugins/paths/core";
import { getParcelWatcher, watcherBackend } from "./engine";

// ─── The file-system journal: what changed under a folder since a cursor ─────
//
// macOS keeps a journal of every file-system change (FSEvents' history, in each
// volume's `.fseventsd`). A cursor is a point in it — the journal's event id
// then, parcel's snapshot. Replaying from a cursor answers "what changed under
// this folder since?" in time proportional to the CHANGES, where re-walking the
// folder costs time proportional to its SIZE (`~/Downloads`: 26k dirs, every
// boot, to learn that nothing moved).
//
// Fail-closed: a replay answers `changes` only when the journal is known to
// hold everything since the cursor. Everything else is `unknown` — the caller
// then walks the folder, the answer that is always right:
// - not FSEvents (Linux, Windows: parcel's "snapshot" there is a full tree
//   crawl, no cheaper than the walk), or a folder on another volume than the
//   user's own (a network share, a FAT drive: no journal, or one another
//   machine wrote to without updating);
// - the folder is not its own real path (FSEvents names real paths: under a
//   symlinked root every replayed path would fall outside it);
// - the cursor is older than MAX_CURSOR_AGE_MS: FSEvents' history is
//   bounded (purged when the disk fills, reset with the volume) and parcel
//   cannot tell a purged range from a quiet one, so an old cursor is not
//   trusted to still be covered;
// - the folder was replaced (another device or inode at its path — a drive
//   swapped, the folder deleted and recreated);
// - the journal went back past the cursor (its ids were reset);
// - FSEvents says it dropped events (the history says "must re-scan").

/** A point in the file-system journal for one folder (plain JSON: persist it). */
export interface JournalCursor {
  /** The folder, as watched (its real path). */
  root: string;
  /** Its device and inode when the cursor was taken: a replaced folder is a different one. */
  dev: number;
  ino: number;
  /** The journal's event id then. */
  eventId: string;
  /** When it was taken (epoch ms). */
  takenAt: number;
  /** parcel's snapshot document (event id + wall time), replayed verbatim. */
  snapshot: string;
}

/** How old a cursor may be and still be replayed (see the module doc). */
export const MAX_CURSOR_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type JournalCursorResult =
  | { kind: "cursor"; cursor: JournalCursor }
  | { kind: "unsupported"; reason: string };

export type JournalReplay =
  | {
      kind: "changes";
      /** Every path the journal names under the folder since the cursor (files and dirs). */
      paths: string[];
    }
  | { kind: "unknown"; reason: string };

// parcel's FSEvents backend reports a history gap with one of these errors.
const DROPPED_EVENTS = /must be re-scanned/;

async function withScratch<T>(fn: (file: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "equin-journal-"));
  try {
    return await fn(join(dir, "snapshot"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function journalVolume(
  root: string,
): Promise<
  | { kind: "ok"; dev: number; ino: number }
  | { kind: "unsupported"; reason: string }
> {
  if (watcherBackend(false) !== "fs-events")
    return { kind: "unsupported", reason: "no FSEvents journal here" };
  let st;
  try {
    st = await stat(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return { kind: "unsupported", reason: `${root} is gone` };
  }
  if ((await realpath(root)) !== root)
    return { kind: "unsupported", reason: `${root} is not its real path` };
  if (st.dev !== (await stat(HOME_DIR)).dev)
    return {
      kind: "unsupported",
      reason: `${root} is not on the user's data volume`,
    };
  return { kind: "ok", dev: st.dev, ino: st.ino };
}

/** The journal's position now, for `root` — taken BEFORE the work it vouches for. */
export async function journalCursor(
  root: string,
): Promise<JournalCursorResult> {
  const volume = await journalVolume(root);
  if (volume.kind === "unsupported") return volume;
  const parcel = await getParcelWatcher();
  const snapshot = await withScratch(async (file) => {
    await parcel.writeSnapshot(root, file, { backend: "fs-events" });
    return await readFile(file, "utf8");
  });
  const eventId = snapshot.split("\n")[0]?.trim() ?? "";
  if (!/^\d+$/.test(eventId))
    throw new Error(`unexpected FSEvents snapshot for ${root}: ${snapshot}`);
  return {
    kind: "cursor",
    cursor: {
      root,
      dev: volume.dev,
      ino: volume.ino,
      eventId,
      takenAt: Date.now(),
      snapshot,
    },
  };
}

/**
 * Every path the journal names under `cursor.root` since `cursor` — or
 * `unknown` whenever the journal cannot vouch for that (see the module doc).
 * A path may be named although nothing about it changed (an event
 * reported twice, a create then delete): the caller re-checks each path.
 */
export async function journalChangesSince(
  cursor: JournalCursor,
): Promise<JournalReplay> {
  if (Date.now() - cursor.takenAt > MAX_CURSOR_AGE_MS)
    return { kind: "unknown", reason: "the cursor is too old to trust" };
  const volume = await journalVolume(cursor.root);
  if (volume.kind === "unsupported")
    return { kind: "unknown", reason: volume.reason };
  if (volume.dev !== cursor.dev || volume.ino !== cursor.ino)
    return { kind: "unknown", reason: `${cursor.root} was replaced` };
  const now = await journalCursor(cursor.root);
  if (now.kind === "unsupported")
    return { kind: "unknown", reason: now.reason };
  if (BigInt(now.cursor.eventId) < BigInt(cursor.eventId))
    return { kind: "unknown", reason: "the FSEvents journal was reset" };
  const parcel = await getParcelWatcher();
  try {
    const events = await withScratch(async (file) => {
      await writeFile(file, cursor.snapshot, "utf8");
      return await parcel.getEventsSince(cursor.root, file, {
        backend: "fs-events",
      });
    });
    return { kind: "changes", paths: events.map((e) => e.path) };
  } catch (err) {
    if (err instanceof Error && DROPPED_EVENTS.test(err.message))
      return { kind: "unknown", reason: err.message };
    throw err;
  }
}
