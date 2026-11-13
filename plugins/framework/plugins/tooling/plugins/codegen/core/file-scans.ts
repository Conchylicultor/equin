import type { RepoFiles } from "@plugins/framework/plugins/tooling/core";
import {
  currentRecordStore,
  outsideFilesOf,
  scanFilesCached,
  type FileScan,
} from "@plugins/plugin-meta/plugins/plugin-records/core";

export type { FileScan };

/**
 * A generator's per-file scan as file records (`plugin-records`'
 * `scanFilesCached`), in the process's record store: from the build's snapshot
 * only a file whose blob changed is read; from a plain file set, every file.
 */
export function scanFiles<T>(
  repo: RepoFiles,
  files: readonly string[],
  scanner: FileScan<T>,
): Promise<T[]> {
  return scanFilesCached(
    {
      snapshot: repo,
      store: currentRecordStore(),
      readOutside: outsideFilesOf(repo),
    },
    files,
    scanner,
  );
}
