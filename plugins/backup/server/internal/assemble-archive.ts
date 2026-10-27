import { mkdir, stat, rm, rename } from "node:fs/promises";
import { join } from "node:path";
import { backupsDir } from "@plugins/infra/plugins/paths/server";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import type {
  BackupArchive,
  BackupManifest,
  BackupSourceReport,
} from "@plugins/backup/core";
import { BackupSource } from "./contribution";

/**
 * Hard wall-clock ceiling on the `tar` below.
 *
 * It replaces the job's `ctx.signal`, which is gone with the in-process job: the
 * body runs in a detached child now, and there is no job deadline in a child to
 * abort anything. Passing a signal that never fires would have been worse than
 * passing none — a bound in the type that is not a bound at runtime.
 *
 * One hour, which is the ceiling this `tar` already had: the old job was
 * `hold: "minutes"`, whose `deadlineMs` is 3,600,000 ms, and that deadline
 * aborting `ctx.signal` was the only thing that ever stopped it. So this is the
 * same number, moved to where it is now knowable, and not a new policy.
 *
 * Not a target. A healthy archive of this machine is minutes; only a wedge —
 * a stalled network filesystem under the staging dir — reaches an hour, and at
 * that point the run has to end so its `.partial` can be reclaimed and the
 * in-flight lock released.
 */
const ARCHIVE_TAR_TIMEOUT_MS = 60 * 60 * 1000;

function formatTimestamp(): string {
  return new Date()
    .toISOString()
    .replace(/T/, "_")
    .replace(/:/g, "-")
    .slice(0, 19);
}

export async function assembleArchive(
  trigger: "manual" | "periodic",
): Promise<BackupArchive> {
  const timestamp = formatTimestamp();
  const runDir = join(backupsDir(), timestamp);
  const stagingDir = join(runDir, "staging");
  const archivePath = join(runDir, "archive.tar.gz");
  // Compress into a sidecar first, then atomically rename onto the final path.
  // A killed tar (deploy/sleep mid-run) leaves only this `.partial` file, never
  // a truncated `archive.tar.gz` that would read as a valid-but-incomplete
  // backup. The `finally` below always reclaims staging + the partial.
  const partialPath = `${archivePath}.partial`;

  // The run directory is named for the SECOND the assembly started, and nothing
  // about that is unique. Two runs reaching here in the same second would share
  // one staging tree, tar each other's files, and rename over each other's
  // archive — silently, producing one file whose manifest describes neither.
  //
  // Two ways to get there, and the in-flight lock prevents neither: a
  // `runAttempts: 2` retry whose first attempt failed inside the same second,
  // and two NAMESPACES backing up at once (the unique index is per-namespace,
  // `BACKUPS_DIR` is host-global). Both are out of reach today — a fresh exec
  // runtime takes far longer than a second to boot, so the retry cannot get
  // here that fast — which is precisely why the guard belongs here rather than
  // in a comment: an unreachable race that later becomes reachable must fail
  // loudly, not corrupt an archive nobody looks at until they need it.
  //
  // `recursive: false` makes the kernel answer, so there is no check-then-act
  // window between asking and creating.
  await mkdir(backupsDir(), { recursive: true });
  try {
    await mkdir(runDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    throw new Error(
      `[backup] run directory ${runDir} already exists — another backup started ` +
        `in the same second. Refusing to share a staging tree and an archive path.`,
    );
  }
  await mkdir(stagingDir, { recursive: true });

  try {
    // Assemble every source concurrently — each writes into its own staging
    // subdir, so they are independent.
    //
    // `allSettled`, not `all`: a source that throws is ONE source missing from
    // the archive, and it used to be the whole archive. A single rejection
    // propagated out of here, past the `finally` that reclaims staging, and the
    // run ended with no file at all — so a stale foreign key in a database
    // nobody has booted since the last migration cost the machine its
    // attachments, its secrets and its transcripts too.
    //
    // A thrown source becomes a `failed` report instead. Its staging subdir is
    // left exactly as it is and goes into the tar: whatever it managed to write
    // is real, and the manifest says in the same breath which source did not
    // finish and what it said. `backup-body` reads those outcomes and refuses
    // to call such a run `ok`.
    const sources = BackupSource.getContributions();
    const reports: BackupSourceReport[] = await Promise.all(
      sources.map(async (source): Promise<BackupSourceReport> => {
        const dir = join(stagingDir, source.id);
        await mkdir(dir, { recursive: true });
        try {
          return await source.assemble(dir);
        } catch (err) {
          return {
            id: source.id,
            name: source.name,
            outcome: "failed",
            error: err instanceof Error ? err.message : String(err),
            // Unknown: the source threw rather than reporting. What it wrote is
            // in the archive either way, and claiming a byte count we did not
            // measure would be worse than claiming none.
            items: [],
            sizeBytes: 0,
          };
        }
      }),
    );

    const manifest: BackupManifest = {
      version: 3,
      createdAt: new Date().toISOString(),
      trigger,
      sources: reports,
      sizeBytes: 0,
    };

    await Bun.write(
      join(stagingDir, "manifest.json"),
      JSON.stringify(manifest, null, 2),
    );

    // Bounded by this file's own ceiling, because there is no longer anyone
    // else to own the deadline: the body runs in a detached child, which has no
    // job and therefore no `ctx.signal`. Either way what a bound does here is
    // the same — kill the tar, leaving the `.partial` sidecar the `finally`
    // below reclaims, never a truncated `archive.tar.gz`.
    //
    // CANCELLATION is a separate mechanism and does not come through here:
    // `killSupervisedRun` signals the whole process GROUP, which this `tar` is
    // in, so it dies with its parent without anything having to forward a
    // signal to it.
    const result = await spawnCaptured(
      ["tar", "-czf", partialPath, "-C", stagingDir, "."],
      { timeoutMs: ARCHIVE_TAR_TIMEOUT_MS },
    );
    if (result.timedOut) {
      throw new Error(
        `tar exceeded its ${ARCHIVE_TAR_TIMEOUT_MS} ms ceiling and was killed — ` +
          `the archive is incomplete. stderr: ${result.stderr}`,
      );
    }
    if (result.exitCode !== 0) {
      throw new Error(`tar failed: ${result.stderr}`);
    }

    const archiveStat = await stat(partialPath);
    manifest.sizeBytes = archiveStat.size;

    // The final `archive.tar.gz` appears only when fully written.
    await rename(partialPath, archivePath);

    return { archivePath, stagingDir: runDir, manifest };
  } finally {
    // Always reclaim staging (and any leftover partial on the error path).
    // On success the rename already moved the partial away, so its rm is a
    // harmless no-op.
    await rm(stagingDir, { recursive: true, force: true });
    await rm(partialPath, { force: true });
  }
}
