import { readFileSync } from "@plugins/packages/plugins/timed-fs/core";
import { joinAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import type { RepoFiles } from "@plugins/framework/plugins/tooling/core";
import {
  currentRecordStore,
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
      readOutside: (rel) => {
        try {
          return readFileSync(joinAppPath(repo.root, rel), "utf8");
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "ENOENT" || code === "EISDIR" || code === "ENOTDIR")
            return null;
          throw err;
        }
      },
    },
    files,
    scanner,
  );
}
