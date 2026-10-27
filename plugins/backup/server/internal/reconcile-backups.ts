import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { backupsDir } from "@plugins/infra/plugins/paths/server";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { hasLiveBackup } from "./run-state";

// `gzip -t` decompresses one archive to check its CRC — real work, roughly
// proportional to the archive, but bounded by it. This runs on the boot path,
// so a child that never returns would leave the backend stuck before it is
// ready; five minutes is far past any healthy archive's decompression and only
// a wedge reaches it.
const GZIP_TEST_TIMEOUT_MS = 300_000;

const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/;

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return false;
  }
}

/**
 * Boot-time sweep of the wreckage a hard-killed backup leaves on disk: an
 * orphaned ~GB `staging/` dir that would survive forever and corrupt retention,
 * a `.partial` sidecar, and a truncated archive.
 *
 * **A filesystem sweep, and nothing else.** It used to have a second arm that
 * marked every unfinished `backup_runs` row failed, on the reasoning that a row
 * still open at boot meant a process that died. That reasoning is now false and
 * the arm would be actively destructive: a backup runs in a detached child that
 * SURVIVES a backend restart, so the most likely unfinished row at boot belongs
 * to a backup that is still going — the very outcome this workstream exists to
 * produce. Closing rows is the supervised job's job now (`closeBackupRow`,
 * driven by the child's own exit marker); this function must never write to the
 * ledger.
 *
 * The same argument applies to the files, which is why the guard below exists:
 * a live run's `staging/` is mid-write, and deleting it would kill the backup
 * that survived the restart just as surely as failing its row would.
 *
 * Host-global backupsDir() + main-only lifecycle: callers gate on isMain().
 */
export async function reconcileBackups(): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(backupsDir());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    entries = [];
  }

  // AFTER the readdir, deliberately. A backup that starts between the two reads
  // has a directory this pass never saw, so it is safe either way; a backup
  // that was live during the readdir is still live here (or has finished, and
  // then its directory holds a valid archive and takes the fast path below).
  // Reading liveness first would leave the reverse window open.
  //
  // **Liveness, not an open row.** After a hard kill the row stays open until
  // the supervised-run reconciler closes it, and a sweep that waited for that
  // would skip exactly the wreckage it exists to clear. A live pid is a running
  // backup; an open row is not.
  if (await hasLiveBackup()) return;

  for (const entry of entries) {
    if (!TIMESTAMP_RE.test(entry)) continue;

    const runDir = join(backupsDir(), entry);
    const archivePath = join(runDir, "archive.tar.gz");
    const stagingDir = join(runDir, "staging");
    const partialPath = `${archivePath}.partial`;

    const hasArchive = await exists(archivePath);
    const hasStaging = await exists(stagingDir);
    const hasPartial = await exists(partialPath);

    // Fast path: a clean completed backup — no gzip cost in steady state.
    if (hasArchive && !hasStaging && !hasPartial) continue;

    if (hasArchive) {
      // An archive exists but leftovers linger — validate it before trusting it.
      const result = await spawnCaptured(["gzip", "-t", archivePath], {
        timeoutMs: GZIP_TEST_TIMEOUT_MS,
      });
      const valid = result.exitCode === 0;
      if (valid) {
        // Good archive with defensive leftovers: drop staging + partial, keep it.
        await rm(stagingDir, { recursive: true, force: true });
        await rm(partialPath, { force: true });
        continue;
      }
    }

    // No archive, or a corrupt/truncated one: the run was interrupted — drop it.
    await rm(runDir, { recursive: true, force: true });
  }
}
