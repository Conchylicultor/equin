/**
 * The files under `data/meta/` that record the drizzle snapshot chain
 * (research/2026-10-22-global-single-live-migration-snapshot.md):
 *
 * - `schema.snapshot.json` — the snapshot DAG's TIP, drizzle's format
 *   unchanged. Rewritten in place by each new schema migration or merge node;
 *   every older body is read from git (`./snapshot-bodies`).
 * - `legacy-snapshots.json` — `{ "<tag>": { id, prevId } }` for every schema
 *   migration written before the cutover. Those `.sql` files can never gain a
 *   snapshot header (their sha8 is immutable), so this is where their lineage
 *   and their schema-migration status live.
 * - `<tag>_snapshot.json` — a pre-cutover per-migration snapshot. Present only
 *   until the next `./singularity build` folds it into `legacy-snapshots.json`
 *   (a clone that merged the cutover while holding its own legacy migrations).
 *
 * And the ONE answer to "is this a schema migration?" (`isSchemaMigration`):
 * its `.sql` starts with a snapshot header, or it is a legacy key, or (until
 * the cutover folds it) it has a sibling `<tag>_snapshot.json`.
 */
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
} from "fs";
import { join } from "path";
import { snapshotLineage, type SnapshotLineage } from "./phases";

/** The tip snapshot body, under `data/meta/`. */
export const SCHEMA_SNAPSHOT_FILE = "schema.snapshot.json";
/** The frozen lineage of every pre-cutover schema migration, under `data/meta/`. */
export const LEGACY_SNAPSHOTS_FILE = "legacy-snapshots.json";
/** The suffix of a pre-cutover per-migration snapshot, `<tag>_snapshot.json`. */
export const LEGACY_SNAPSHOT_SUFFIX = "_snapshot.json";

/** A snapshot's identity: the first two keys drizzle writes. */
export interface SnapshotHead {
  id: string;
  prevId: string;
}

/**
 * How much of a file's start is read. drizzle-kit writes `id` then `prevId` as
 * a snapshot's first two keys, and a snapshot header is its `.sql`'s first
 * line — both fit well inside this.
 */
const HEAD_BYTES = 1024;

/** The first two keys of a snapshot, anchored at the start of the file. */
const HEAD_RE = /^\{\s*"id":\s*"([^"]+)",\s*"prevId":\s*"([^"]+)"/;

/** The first `HEAD_BYTES` of `path`, or null when it does not exist. */
export function readStart(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const bytesRead = readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.toString("utf8", 0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

/**
 * The `{ id, prevId }` a snapshot body starts with. Throws, naming `where`,
 * when it does not start that way: a changed drizzle layout must fail here,
 * not pass unchecked.
 */
export function parseSnapshotHead(text: string, where: string): SnapshotHead {
  const m = HEAD_RE.exec(text);
  if (!m)
    throw new Error(
      `${where} does not start with "id" then "prevId" — the drizzle snapshot layout changed; update parseSnapshotHead`,
    );
  return { id: m[1]!, prevId: m[2]! };
}

/** The head of the snapshot at `path`, or null when the file does not exist. */
export function readSnapshotHead(path: string): SnapshotHead | null {
  const start = readStart(path);
  return start === null ? null : parseSnapshotHead(start, path);
}

/** `data/meta/schema.snapshot.json` for `dataDir`. */
export function schemaSnapshotPath(dataDir: string): string {
  return join(dataDir, "meta", SCHEMA_SNAPSHOT_FILE);
}

/** `data/meta/legacy-snapshots.json` for `dataDir`. */
export function legacySnapshotsPath(dataDir: string): string {
  return join(dataDir, "meta", LEGACY_SNAPSHOTS_FILE);
}

/**
 * `legacy-snapshots.json`, tag → head; null when the file does not exist (a
 * tree from before the cutover, or a fresh repo). A malformed file throws.
 */
export function readLegacySnapshots(
  dataDir: string,
): Map<string, SnapshotHead> | null {
  const path = legacySnapshotsPath(dataDir);
  if (!existsSync(path)) return null;
  return parseLegacySnapshots(readFileSync(path, "utf8"), path);
}

/** Parse a `legacy-snapshots.json` text (from disk or from git). Throws when malformed. */
export function parseLegacySnapshots(
  text: string,
  where: string,
): Map<string, SnapshotHead> {
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new Error(`${where} is not a { "<tag>": { id, prevId } } object`);
  const map = new Map<string, SnapshotHead>();
  for (const [tag, v] of Object.entries(raw)) {
    const head = v as Partial<SnapshotHead> | null;
    if (
      typeof head !== "object" ||
      head === null ||
      typeof head.id !== "string" ||
      typeof head.prevId !== "string"
    )
      throw new Error(`${where}: entry "${tag}" is not { id, prevId }`);
    map.set(tag, { id: head.id, prevId: head.prevId });
  }
  return map;
}

/** The one byte layout of `legacy-snapshots.json`: keys sorted, 2-space indent, trailing newline. */
export function renderLegacySnapshots(
  entries: ReadonlyMap<string, SnapshotHead>,
): string {
  const sorted = [...entries.keys()].sort();
  const obj: Record<string, SnapshotHead> = {};
  for (const tag of sorted) {
    const { id, prevId } = entries.get(tag)!;
    obj[tag] = { id, prevId };
  }
  return `${JSON.stringify(obj, null, 2)}\n`;
}

/** Every pre-cutover `<tag>_snapshot.json` still under `data/meta/`, sorted. */
export function legacySnapshotFiles(dataDir: string): string[] {
  const metaDir = join(dataDir, "meta");
  if (!existsSync(metaDir)) return [];
  return readdirSync(metaDir)
    .filter((f) => f.endsWith(LEGACY_SNAPSHOT_SUFFIX))
    .sort();
}

/** The `.sql` basename a legacy `<tag>_snapshot.json` belongs to. */
export function legacySnapshotSql(file: string): string {
  return `${file.slice(0, -LEGACY_SNAPSHOT_SUFFIX.length)}.sql`;
}

/** The legacy `<tag>_snapshot.json` basename of a `.sql` basename. */
export function legacySnapshotFileOf(sql: string): string {
  return `${sql.slice(0, -".sql".length)}${LEGACY_SNAPSHOT_SUFFIX}`;
}

/** The snapshot header of `data/<file>`, read from its first line; null when it has none. */
export function readSnapshotLineage(
  dataDir: string,
  file: string,
): SnapshotLineage | null {
  const start = readStart(join(dataDir, file));
  return start === null ? null : snapshotLineage(start);
}

/**
 * Whether `data/<file>` is a schema migration, given `legacy` (the tree's
 * `readLegacySnapshots`): a snapshot header, a legacy key, or — until the next
 * build folds it — a sibling `<tag>_snapshot.json`.
 */
function isSchemaFile(
  dataDir: string,
  file: string,
  legacy: ReadonlyMap<string, SnapshotHead> | null,
): boolean {
  if (!file.endsWith(".sql")) return false;
  if (legacy?.has(file.slice(0, -".sql".length))) return true;
  if (existsSync(join(dataDir, "meta", legacySnapshotFileOf(file))))
    return true;
  return readSnapshotLineage(dataDir, file) !== null;
}

/**
 * THE schema-migration predicate (see the module docblock). A data migration
 * and an adoption file are everything else. For a loop over `data/`, read the
 * whole set once with `schemaMigrationFiles`.
 */
export function isSchemaMigration(dataDir: string, file: string): boolean {
  return isSchemaFile(dataDir, file, readLegacySnapshots(dataDir));
}

/** Every `.sql` basename in `dataDir` that `isSchemaMigration` holds for. */
export function schemaMigrationFiles(dataDir: string): Set<string> {
  const legacy = readLegacySnapshots(dataDir);
  return new Set(
    readdirSync(dataDir).filter((f) => isSchemaFile(dataDir, f, legacy)),
  );
}
