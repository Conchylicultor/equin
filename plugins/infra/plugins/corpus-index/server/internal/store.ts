import { appendFile, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { readdir, readFile } from "@plugins/packages/plugins/timed-fs/core";
import { basename, dirname, join } from "node:path";
import type { JournalCursor } from "@plugins/infra/plugins/file-watcher/server";

// ─── What this is ─────────────────────────────────────────────────────────────
//
// The index on disk: a SNAPSHOT (`indexPath`, the whole document, written
// atomically) plus an append-only LOG of the entries changed since
// (`<indexPath>.<generation>.log`, one JSON line per changed path). A change
// appends its entries to the log — O(changed entries) — where it used to
// rewrite the whole document: 3.7 MB of JSON per transcript append on main
// (~10 ms each, ~2k appends an hour). The journal cursors are logged the same
// way (one line holding them all), after the entries they vouch for. The log
// is folded into a new snapshot once it outgrows it (amortized O(1) per line).
//
// The snapshot names the generation of its log, and each snapshot starts a new
// one: a log left behind by a crash between a snapshot and its log's removal
// belongs to an older generation and is never replayed over the newer
// snapshot (it would put back older entries the journal no longer names).

/** Persisted, per-file fingerprint + parsed partial. */
export interface CorpusEntry<TPartial> {
  mtimeMs: number;
  size: number;
  partial: TPartial;
}

/** On-disk index document. */
export interface CorpusFile<TPartial> {
  /** The code digest of the format that built `files` — another one rebuilds. */
  version: string;
  files: Record<string, CorpusEntry<TPartial>>;
  /**
   * One file-system journal cursor per root, taken before the last full walk
   * (or journal catch-up) whose result `files` holds: replaying the journal
   * from them names everything that may have moved since. Saved in the same
   * document as `files`, so the two cannot disagree. Absent ⇒ the next boot
   * walks. Moved by a log line (`recordCorpusCursors`), appended after the
   * entries' lines, so a replay never holds a cursor ahead of its entries.
   */
  cursors?: JournalCursor[];
  /** The generation of the log replayed over this snapshot (absent ⇒ none). */
  log?: string;
}

/** One log line: a path's new entry, its removal, or the cursors now (`[]`: none). */
type LogRecord<TPartial> =
  | { p: string; e: CorpusEntry<TPartial> }
  | { p: string; gone: true }
  | { c: JournalCursor[] };

/** Where an index loaded or saved by this process stands with its log. */
interface LogState {
  generation: string;
  snapshotBytes: number;
  logBytes: number;
}

// Keyed by the in-memory document: a document this process never loaded nor
// snapshotted (a fresh or rebuilt one) has no log yet, so its first save is a
// snapshot.
const logStates = new WeakMap<object, LogState>();

const logPath = (indexPath: string, generation: string): string =>
  `${indexPath}.${generation}.log`;

// Unique per snapshot, across processes (pid) and within one (the counter:
// two snapshots can land in the same millisecond).
let generations = 0;
function newGeneration(): string {
  return `${Date.now().toString(36)}-${process.pid}-${(++generations).toString(36)}`;
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return null;
  }
}

/**
 * Replay `raw` (a log's text) over `files`. Only newline-terminated lines
 * count: a trailing one without its newline is an append still being written
 * (or cut by a crash). Returns false when a complete line is not a record — a
 * corrupt log, which the caller treats like a corrupt snapshot.
 */
function replayLog<TPartial>(
  index: CorpusFile<TPartial>,
  raw: string,
): boolean {
  const { files } = index;
  const end = raw.lastIndexOf("\n");
  if (end < 0) return true;
  for (const line of raw.slice(0, end).split("\n")) {
    if (line === "") continue;
    let rec: LogRecord<TPartial>;
    try {
      rec = JSON.parse(line) as LogRecord<TPartial>;
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      return false;
    }
    /* eslint-disable @typescript-eslint/no-unnecessary-condition -- runtime guard on untrusted on-disk JSON */
    if (typeof rec !== "object" || rec === null) return false;
    if ("c" in rec) {
      if (!Array.isArray(rec.c)) return false;
      if (rec.c.length === 0) delete index.cursors;
      else index.cursors = rec.c;
      continue;
    }
    if (typeof rec.p !== "string") return false;
    /* eslint-enable @typescript-eslint/no-unnecessary-condition */
    if ("gone" in rec) delete files[rec.p];
    else files[rec.p] = rec.e;
  }
  return true;
}

/** The stored index — its snapshot with its log replayed — or an empty one to rebuild. */
export async function loadCorpusFile<TPartial>(
  indexPath: string,
  version: string,
): Promise<CorpusFile<TPartial>> {
  const fresh = (): CorpusFile<TPartial> => ({ version, files: {} });
  const raw = await readOptional(indexPath);
  if (raw === null) return fresh();
  let parsed: CorpusFile<TPartial>;
  try {
    parsed = JSON.parse(raw) as CorpusFile<TPartial>;
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return fresh();
  }
  /* eslint-disable @typescript-eslint/no-unnecessary-condition -- runtime guard on untrusted on-disk JSON */
  if (
    !parsed ||
    parsed.version !== version ||
    typeof parsed.files !== "object"
  ) {
    // Another format's index (its code digest differs — or an index stamped
    // with a pre-digest numeric version), or a corrupt/partial file ⇒ start
    // empty and rebuild.
    return fresh();
  }
  /* eslint-enable @typescript-eslint/no-unnecessary-condition */
  let logBytes = 0;
  if (typeof parsed.log === "string") {
    const log = await readOptional(logPath(indexPath, parsed.log));
    if (log !== null) {
      if (!replayLog(parsed, log)) return fresh();
      logBytes = Buffer.byteLength(log);
    }
    // A log ending mid-record (an append cut by a crash, or one main is still
    // writing) is never appended to: the next record would run on from the
    // fragment into one corrupt line. Left without a log state, this
    // document's first save is a snapshot, starting a clean log.
    if (log === null || log === "" || log.endsWith("\n")) {
      logStates.set(parsed, {
        generation: parsed.log,
        snapshotBytes: Buffer.byteLength(raw),
        logBytes,
      });
    }
  }
  return parsed;
}

/**
 * Write `index` whole as a new snapshot (atomic temp + rename), starting a new
 * log generation, then remove every older log of this index.
 */
export async function saveCorpusSnapshot<TPartial>(
  indexPath: string,
  index: CorpusFile<TPartial>,
): Promise<void> {
  const dir = dirname(indexPath);
  await mkdir(dir, { recursive: true });
  const generation = newGeneration();
  index.log = generation;
  const text = JSON.stringify(index);
  // Atomic write: a partially-written index would fail the version/shape guard
  // and force a full rebuild, so write to a sibling temp file then rename.
  const tmp = `${indexPath}.${process.pid}.tmp`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, indexPath);
  logStates.set(index, {
    generation,
    snapshotBytes: Buffer.byteLength(text),
    logBytes: 0,
  });
  // Every older generation is now superseded — the previous one, and any a
  // crash left behind.
  const prefix = `${basename(indexPath)}.`;
  for (const name of await readdir(dir)) {
    if (
      name.startsWith(prefix) &&
      name.endsWith(".log") &&
      name !== basename(logPath(indexPath, generation))
    ) {
      await unlinkOptional(join(dir, name));
    }
  }
}

async function unlinkOptional(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/**
 * Persist the current state in `index` of every path in `changed` and
 * `removed` (its entry, or its absence): appended to the log, O(those
 * entries). The first save
 * of a document with no log yet, and a log grown past its snapshot, write a
 * snapshot instead.
 */
export async function recordCorpusChanges<TPartial>(
  indexPath: string,
  index: CorpusFile<TPartial>,
  changed: readonly string[],
  removed: readonly string[],
): Promise<void> {
  const state = logStates.get(index);
  if (state === undefined || index.log !== state.generation) {
    await saveCorpusSnapshot(indexPath, index);
    return;
  }
  let text = "";
  // Each path's state as the pass left it — whichever list named it.
  for (const p of new Set([...removed, ...changed])) {
    const e = index.files[p];
    const rec: LogRecord<TPartial> =
      e === undefined ? { p, gone: true } : { p, e };
    text += `${JSON.stringify(rec)}\n`;
  }
  await appendLog(indexPath, index, state, text);
}

/**
 * Persist `index.cursors` (none: `[]`): one log line, appended after every
 * entry line already written — so call it once the entries the cursors vouch
 * for are recorded. A document with no log yet writes a snapshot instead.
 */
export async function recordCorpusCursors<TPartial>(
  indexPath: string,
  index: CorpusFile<TPartial>,
): Promise<void> {
  const state = logStates.get(index);
  if (state === undefined || index.log !== state.generation) {
    await saveCorpusSnapshot(indexPath, index);
    return;
  }
  const rec: LogRecord<TPartial> = { c: index.cursors ?? [] };
  await appendLog(indexPath, index, state, `${JSON.stringify(rec)}\n`);
}

async function appendLog<TPartial>(
  indexPath: string,
  index: CorpusFile<TPartial>,
  state: LogState,
  text: string,
): Promise<void> {
  if (text === "") return;
  await appendFile(logPath(indexPath, state.generation), text, "utf8");
  state.logBytes += Buffer.byteLength(text);
  if (state.logBytes > state.snapshotBytes) {
    await saveCorpusSnapshot(indexPath, index);
  }
}
