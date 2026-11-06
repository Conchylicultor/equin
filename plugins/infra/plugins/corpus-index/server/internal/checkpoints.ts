import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import {
  readdir,
  readFile,
  stat,
} from "@plugins/packages/plugins/timed-fs/core";
import { join } from "node:path";
import { hashHex } from "@plugins/packages/plugins/string-hash/core";

// ─── What this is ─────────────────────────────────────────────────────────────
//
// Where a `lines` format's fold states outlive the process: one checkpoint
// file per corpus file — its fold state (the format's `save`) and the byte
// offset, inode and tail bytes it was folded to — under
// `<indexPath>.lines/<format digest>/`. A new process's first read of a file
// continues from its checkpoint instead of folding it again from its first
// byte: held only in memory, every live transcript was re-read whole after
// each backend restart (~74 a day on main; ~1–1.8 s for a 106 MB transcript).
//
// A checkpoint is the line reader's own held state, validated the same way
// before it is continued (same inode, not shorter, tail bytes unchanged), so
// it needs no consistency with the index document: a stale one only costs a
// fold from the start. It lives beside the index, not in its entries: an
// entry is rewritten on every append (the log) and every entry is in every
// snapshot, while a checkpoint is written only every so many folded bytes and
// read only for a file that moved while no process held it.
//
// The directory is keyed by the format's code digest: a checkpoint is only
// ever loaded by the code that saved it, and a persisting process removes
// every other digest's directory on its first write. Across a deploy the old
// and the new backend may both write for a moment, each removing the other's
// directory: every write re-creates its own, so the cost is checkpoints lost
// (a fold from the start), never a failed write.

/** A temp file this old was never going to be renamed: its writer died. */
const STALE_TMP_MS = 60 * 60 * 1000;

/** A file's fold state as of byte `offset` (always a line start). */
export interface Checkpoint {
  ino: number;
  offset: number;
  /** The (up to 64) bytes ending at `offset`, checked before continuing. */
  tail: Uint8Array;
  /** The format's `save` of the fold state. */
  state: unknown;
}

/** What a stored checkpoint read back: its content, or that there is none. */
export type StoredCheckpoint =
  | { kind: "checkpoint"; checkpoint: Checkpoint; bytes: number }
  | { kind: "none" };

export interface CheckpointWriter {
  /** Store `checkpoint` for `path` (atomic); resolves to its size in bytes. */
  save(path: string, checkpoint: Checkpoint): Promise<number>;
  /** Drop `path`'s checkpoint (the file left the index). */
  remove(path: string): Promise<void>;
}

export interface CheckpointStore {
  load(path: string): Promise<StoredCheckpoint>;
  /** `null` on a backend that does not persist the index: it only reads. */
  writer: CheckpointWriter | null;
}

/** The on-disk shape of one checkpoint. */
interface CheckpointFile {
  path: string;
  ino: number;
  offset: number;
  /** Base64. */
  tail: string;
  state: unknown;
}

function isCheckpointFile(v: unknown, path: string): v is CheckpointFile {
  if (typeof v !== "object" || v === null) return false;
  const f = v as Partial<CheckpointFile>;
  return (
    f.path === path &&
    typeof f.ino === "number" &&
    typeof f.offset === "number" &&
    typeof f.tail === "string" &&
    "state" in f
  );
}

/**
 * The checkpoints of the index at `indexPath` whose format has code digest
 * `version`; `persist` ⇒ this process writes them (the index's own persist
 * rule), otherwise it only reads what the persisting backend wrote.
 */
export function createCheckpointStore(
  indexPath: string,
  version: string,
  persist: boolean,
): CheckpointStore {
  const base = `${indexPath}.lines`;
  const digestDir = hashHex(version);
  const dir = join(base, digestDir);
  const fileOf = (path: string): string => join(dir, `${hashHex(path)}.json`);

  async function load(path: string): Promise<StoredCheckpoint> {
    let raw: string;
    try {
      raw = await readFile(fileOf(path), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      return { kind: "none" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      // Never written half (temp + rename): only a foreign write gets here.
      // Folding the file from its start is the correct reading regardless.
      return { kind: "none" };
    }
    // A path whose name hash collides with another's reads as none.
    if (!isCheckpointFile(parsed, path)) return { kind: "none" };
    return {
      kind: "checkpoint",
      checkpoint: {
        ino: parsed.ino,
        offset: parsed.offset,
        tail: new Uint8Array(Buffer.from(parsed.tail, "base64")),
        state: parsed.state,
      },
      bytes: Buffer.byteLength(raw),
    };
  }

  // Once per process, before its first write: every other digest's
  // checkpoints are another format's, never loaded again; a temp file older
  // than any write takes is one a killed process never renamed (a younger one
  // may be a live writer's, across a deploy's overlap).
  let swept: Promise<void> | null = null;
  async function sweep(): Promise<void> {
    await mkdir(dir, { recursive: true });
    for (const name of await readdir(base)) {
      if (name !== digestDir)
        await rm(join(base, name), { recursive: true, force: true });
    }
    for (const name of await readdir(dir)) {
      if (!name.endsWith(".tmp")) continue;
      const tmp = join(dir, name);
      try {
        if (Date.now() - (await stat(tmp)).mtimeMs < STALE_TMP_MS) continue;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        continue;
      }
      await rm(tmp, { force: true });
    }
  }

  // Unique per write, within a process too.
  let writes = 0;

  const writer: CheckpointWriter = {
    async save(path, checkpoint) {
      swept ??= sweep().catch((err: unknown) => {
        swept = null; // the next write sweeps again
        throw err;
      });
      await swept;
      // Every write: a backend of another digest may have removed it.
      await mkdir(dir, { recursive: true });
      const text = JSON.stringify({
        path,
        ino: checkpoint.ino,
        offset: checkpoint.offset,
        tail: Buffer.from(checkpoint.tail).toString("base64"),
        state: checkpoint.state,
      } satisfies CheckpointFile);
      const file = fileOf(path);
      const tmp = `${file}.${process.pid}-${++writes}.tmp`;
      await writeFile(tmp, text, "utf8");
      await rename(tmp, file);
      return Buffer.byteLength(text);
    },
    async remove(path) {
      await rm(fileOf(path), { force: true });
    },
  };

  return { load, writer: persist ? writer : null };
}
