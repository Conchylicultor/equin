import { mkdir, open, rename } from "node:fs/promises";
import { reportServerError } from "@plugins/framework/plugins/server-core/core";
import { crashFieldsOf } from "@plugins/packages/plugins/error-subject/core";
import { dirname } from "node:path";
import { z } from "zod";
import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  flockTryShared,
  waitForFlock,
  type HeldFlock,
} from "@plugins/packages/plugins/flock/core";
import { openOwnedFd } from "@plugins/packages/plugins/owned-fd/core";
import { readFile } from "@plugins/packages/plugins/timed-fs/core";
import { worktreeArtifacts } from "@plugins/infra/plugins/paths/core";
import type { Namespace } from "@plugins/infra/plugins/namespace/core";
import type {
  OwnerBootOutcome,
  OwnerBootRecord,
} from "../../server/internal/driver";

// ── The schema-owner boot marker ─────────────────────────────────────────────
//
// An `exec` child whose database is not set up for its code waits only while
// its stamp can still come (`awaitSchemaLayer`). What brings the stamp is a
// serving backend reaching `onReady`; the build that restarted it is only a
// proxy for that — and a build exits on a deadline arm ("still booting under
// host load", "gateway unreachable", …) while its backend is still booting,
// letting go of the build lock seconds before the stamp lands
// (task-1794739540-eqmg40). So the backend itself says it: it holds this
// marker from the top of its entry point (`serve`, before any plugin loads)
// until its `onReady` settled the stamp — and the kernel drops it with the
// process, SIGKILL included. Shared: two incarnations of one namespace booting
// at once (a crash respawn under a slow predecessor) never wait on each other,
// and a waiter's exclusive wait is granted once every one of them is done.
//
// What is left uncovered is only the spawn → `serve()` gap (Bun's start and
// the entry module's imports), during which the build that spawned it still
// holds its own lock: every build deadline is ≥ 20 s past the restart.

/** Where one namespace's marker and record live (`worktreeArtifacts`). */
export interface OwnerBootPaths {
  lock: AppPath;
  record: AppPath;
}

function pathsOf(namespace: Namespace): OwnerBootPaths {
  return {
    lock: worktreeArtifacts.schemaOwnerBoot(namespace),
    record: worktreeArtifacts.schemaOwnerBootRecord(namespace),
  };
}

/** The claim this serving process holds, between `claim` and `settle`. */
let claimed: {
  paths: OwnerBootPaths;
  held: HeldFlock;
  base: { pid: number; startedAt: number };
} | null = null;

/**
 * Claim the namespace's schema-owner boot marker for this serving process —
 * once, by the serving entry point (server-core's `serve`), before anything
 * boots. Held until `settleSchemaOwnerBoot` (database's `onReady`, through
 * `DatabaseDriver.settleOwnerBoot`) or this process's death.
 */
export function claimSchemaOwnerBoot(
  namespace: Namespace,
  startedAt: number,
): Promise<void> {
  return claimOwnerBootAt(pathsOf(namespace), startedAt);
}

/** `claimSchemaOwnerBoot` at explicit paths (a test's temp dir). */
export async function claimOwnerBootAt(
  paths: OwnerBootPaths,
  startedAt: number,
): Promise<void> {
  if (claimed !== null) {
    throw new Error(
      `[database] the schema-owner boot marker was claimed twice (already ${claimed.paths.lock}, asked ${paths.lock})`,
    );
  }
  await mkdir(dirname(paths.lock), { recursive: true });
  const held = await holdShared(paths.lock);
  const base = { pid: process.pid, startedAt };
  claimed = { paths, held, base };
  // After the marker is held: a waiter that finds it free and reads `booting`
  // reads a backend that exited before its stamp, never one still on its way.
  await writeRecord(paths.record, { ...base, kind: "booting" });
}

/**
 * This serving process's boot toward its stamp is over: write what it came to
 * (`recorded`, or `stamp-failed` with the error), THEN let go of the marker —
 * so the waiter it wakes reads the outcome, not `booting`. A process that
 * claimed nothing (a test's serving host) has nothing to settle.
 */
export async function settleSchemaOwnerBoot(
  outcome: OwnerBootOutcome,
): Promise<void> {
  const claim = claimed;
  if (claim === null) return;
  claimed = null;
  try {
    await writeRecord(claim.paths.record, { ...claim.base, ...outcome });
  } catch (err) {
    // Reported, not thrown: the caller is database's `onReady`, whose own
    // outcome (the stamp, the deferred contract, a stamp error being filed)
    // must not be replaced by a failure to say it. A waiter then reads the
    // previous record (`booting`) and names an exit instead.
    reportServerError({
      message: `[database] could not write the schema-owner boot record (${outcome.kind}): ${err instanceof Error ? err.message : String(err)}`,
      ...crashFieldsOf(err),
    });
  } finally {
    await claim.held.release();
  }
}

const OwnerBootRecordSchema: z.ZodType<OwnerBootRecord> = z.intersection(
  z.object({ pid: z.number().int(), startedAt: z.number() }),
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("booting") }),
    z.object({ kind: z.literal("recorded") }),
    z.object({ kind: z.literal("stamp-failed"), error: z.string() }),
  ]),
);

/** The namespace's last boot record, or null when no serving backend ever wrote one. */
export function readOwnerBootRecord(
  namespace: Namespace,
): Promise<OwnerBootRecord | null> {
  return readOwnerBootRecordAt(pathsOf(namespace).record);
}

/** `readOwnerBootRecord` at an explicit path (a test's temp dir). */
export async function readOwnerBootRecordAt(
  path: AppPath,
): Promise<OwnerBootRecord | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as { code?: unknown }).code === "ENOENT") return null;
    throw err;
  }
  // An unreadable record is a bug in its writer, never "no record".
  return OwnerBootRecordSchema.parse(JSON.parse(raw));
}

async function writeRecord(
  path: AppPath,
  record: OwnerBootRecord,
): Promise<void> {
  const tmp = `${path}.${String(process.pid)}.tmp`;
  // Synced before the rename: a power loss must not leave an empty record
  // that every refused child then fails to parse.
  const file = await open(tmp, "w");
  try {
    await file.writeFile(`${JSON.stringify(record)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(tmp, path);
}

/**
 * `path`'s shared flock, held: on a descriptor of this process when no one
 * holds it exclusively (the usual case: no waiter is mid-grant), else through
 * a `flock-wait` child once that waiter let go — microseconds, since a waiter
 * drops its exclusive grant the moment it gets it.
 */
async function holdShared(path: AppPath): Promise<HeldFlock> {
  const fd = await openOwnedFd(path, "a");
  if (!flockTryShared(fd.fd)) {
    fd.close();
    return waitForFlock(path, { shared: true });
  }
  let open = true;
  const releaseNow = (): void => {
    if (!open) return;
    open = false;
    fd.close();
  };
  return {
    releaseNow,
    release: () => {
      releaseNow();
      return Promise.resolve();
    },
  };
}
