/**
 * The migrations data dir's files, as the snapshot readers (`./snapshot-dag`,
 * `./schema-snapshot`, `./snapshot-bodies`) read them: off disk
 * (`diskMigrationData`, what the CLI's generate pipeline reads), or through a
 * caller's own file set — the `snapshot-chain-intact` check hands its
 * `ctx.repo()`, so every file its verdict reads is recorded in its input-keyed
 * read-set and a PASS is re-run exactly when one of them changes.
 *
 * Every path is data-dir-relative: `<tag>.sql`, `meta/<file>`.
 */
import { readFile, readdir } from "@plugins/packages/plugins/timed-fs/core";
import { join } from "path";
import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  LEGACY_SNAPSHOT_SUFFIX,
  LEGACY_SNAPSHOTS_FILE,
  legacySnapshotFileOf,
  parseLegacySnapshots,
  readStartAsync,
} from "./schema-snapshot";
import { snapshotLineage } from "@plugins/database/plugins/migrations/plugins/phases/core";
import { MIGRATIONS_DATA_DIR } from "./published";

export interface MigrationData {
  /** Every name directly in the data dir (files; a directory name may be listed too), sorted. */
  files(): Promise<readonly string[]>;
  /** Every file directly in `data/meta/`, sorted; empty when there is no `meta/`. */
  metaFiles(): Promise<readonly string[]>;
  /**
   * The start of `rel` — at least its first kilobyte, possibly the whole file
   * (all a snapshot head or a migration's header line needs) — or null when
   * it does not exist.
   */
  start(rel: string): Promise<string | null>;
  /** The whole text of `rel`, or null when it does not exist. */
  text(rel: string): Promise<string | null>;
}

const isEnoent = (err: unknown) =>
  (err as NodeJS.ErrnoException | null)?.code === "ENOENT";

/** `dataDir` read off disk, asynchronously (a check pass shares its thread). */
export function diskMigrationData(dataDir: AppPath): MigrationData {
  const list = async (dir: string): Promise<string[]> => {
    try {
      return (await readdir(dir)).sort();
    } catch (err) {
      if (isEnoent(err)) return [];
      throw err;
    }
  };
  return {
    files: () => list(dataDir),
    metaFiles: () => list(join(dataDir, "meta")),
    start: (rel) => readStartAsync(join(dataDir, rel)),
    async text(rel) {
      try {
        return await readFile(join(dataDir, rel), "utf8");
      } catch (err) {
        if (isEnoent(err)) return null;
        throw err;
      }
    },
  };
}

/** Every pre-cutover `<tag>_snapshot.json` still under `data/meta/`, sorted. */
export async function legacySnapshotFilesIn(
  data: MigrationData,
): Promise<string[]> {
  return (await data.metaFiles()).filter((f) =>
    f.endsWith(LEGACY_SNAPSHOT_SUFFIX),
  );
}

/**
 * The member listing and reads of a caller's file set — a check's
 * `ctx.repo()` — that {@link migrationDataIn} reads the data dir through.
 */
export interface MigrationFileSet {
  /** Every member under `dir` (repo-relative), sorted. */
  under(dir: string): readonly string[];
  /** A member's text, or null when it is not one. */
  read(rel: string): Promise<string | null>;
}

/**
 * The data dir as `repo` holds it — a check's `ctx.repo()`, so each listing
 * and read is a fact of its input-keyed read-set: the data dir's membership
 * (a migration added or removed) and the content of every file read (a
 * migration, `legacy-snapshots.json`, the tip file).
 */
export function migrationDataIn(repo: MigrationFileSet): MigrationData {
  const prefix = `${MIGRATIONS_DATA_DIR}/`;
  const under = () =>
    repo.under(MIGRATIONS_DATA_DIR).map((p) => p.slice(prefix.length));
  return {
    files: async () => under().filter((rel) => !rel.includes("/")),
    metaFiles: async () =>
      under()
        .filter((rel) => rel.startsWith("meta/"))
        .map((rel) => rel.slice("meta/".length))
        .filter((rel) => !rel.includes("/")),
    start: (rel) => repo.read(`${prefix}${rel}`),
    text: (rel) => repo.read(`${prefix}${rel}`),
  };
}

/**
 * `schemaMigrationFiles`, read through `data`: every `.sql` basename that is a
 * schema migration — a legacy key, a sibling `meta/<tag>_snapshot.json`, or a
 * snapshot header on its first line (`isSchemaMigration`'s one answer).
 */
export async function schemaMigrationFilesIn(
  data: MigrationData,
): Promise<Set<string>> {
  const legacyRel = `meta/${LEGACY_SNAPSHOTS_FILE}`;
  const legacyText = await data.text(legacyRel);
  const legacy =
    legacyText === null ? null : parseLegacySnapshots(legacyText, legacyRel);
  const meta = new Set(await data.metaFiles());
  const schema = new Set<string>();
  for (const file of await data.files()) {
    if (!file.endsWith(".sql")) continue;
    if (
      legacy?.has(file.slice(0, -".sql".length)) ||
      meta.has(legacySnapshotFileOf(file))
    ) {
      schema.add(file);
      continue;
    }
    const start = await data.start(file);
    if (start !== null && snapshotLineage(start) !== null) schema.add(file);
  }
  return schema;
}
