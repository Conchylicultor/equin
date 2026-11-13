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
import { LEGACY_SNAPSHOT_SUFFIX, readStartAsync } from "./schema-snapshot";

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
