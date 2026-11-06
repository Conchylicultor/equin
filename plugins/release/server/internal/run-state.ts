import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { readFile } from "@plugins/packages/plugins/timed-fs/core";
import { join } from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@plugins/database/server";
import type { UnfinishedRun } from "@plugins/infra/plugins/jobs/plugins/supervised-job/server";
import type { RunTerminal } from "@plugins/infra/plugins/jobs/plugins/supervised-job/core";
import { releaseOutDir } from "@plugins/release/plugins/bundles/server";
import type { ReleaseIntent } from "../../core/endpoints";
import { isPlatformTag } from "../../core/platforms";
import { noteCandidateClosed } from "./candidate-resource";
import { _releaseRuns } from "./tables";
import {
  releaseFailureMessage,
  releaseSucceeded,
  type ReleaseEnding,
} from "./release-outcome";
import { releaseRunIdKind } from "@plugins/release/plugins/bundles/core";
import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

/** The index the claiming INSERT contends on — see `tables.ts`. */
const INFLIGHT_UQ = "release_runs_inflight_uniq";

/**
 * node-postgres surfaces a unique violation as SQLSTATE 23505 plus the offending
 * constraint. The constraint is checked, not just the code: `release_runs` also
 * has a primary key, and a (vanishingly unlikely) id collision reported as
 * "a release is already running" would be a plausible-looking lie about a
 * different fault.
 */
function isInflightViolation(err: unknown): boolean {
  const pg = err as { code?: string; constraint?: string } | null;
  return pg?.code === "23505" && pg.constraint === INFLIGHT_UQ;
}

/**
 * Claim the in-flight slot for one composition by INSERTing its ledger row.
 * `false` means another release of this composition holds the lock.
 *
 * **The INSERT is the lock.** The partial unique index on
 * `(namespace, composition) WHERE finished_at IS NULL` is what wins or loses the
 * race, so there is no check-then-act window at all. Losing is not a fault: it
 * is the `already-running` outcome, reached the only way that is safe under
 * concurrency.
 *
 * Called from the release job's memoized spawn step, so it runs exactly once per
 * enqueue however many times the workflow is resumed.
 */
export async function claimRelease(opts: {
  releaseId: string;
  composition: string;
  target: string;
  intent: ReleaseIntent;
}): Promise<boolean> {
  try {
    await db.insert(_releaseRuns).values({
      id: releaseRunIdKind.parse(opts.releaseId),
      composition: opts.composition,
      target: opts.target,
      startedAt: new Date(),
      // Stamped from the intent, at claim time — before the CLI has produced
      // anything. What a run WAS FOR is decided by the request, not inferred
      // later from whether an artifact happens to be on disk.
      kind: opts.intent.kind,
      // This backend's own, live pid. It keeps the fresh row from looking like
      // an orphan in the window before the child's pid is known.
      pid: process.pid,
      namespace: runtimeNamespace(),
    });
    return true;
  } catch (err) {
    if (!isInflightViolation(err)) throw err;
    return false;
  }
}

/** The `RELEASE.json` the CLI writes once it has produced an artifact. */
interface ReleaseManifest {
  composition: string;
  target: string;
  platform: string;
  builtAt: string;
  port: number;
  /** Provenance the CLI stamps before its artifact phase; absent on old bundles. */
  commitSha?: string;
  commitDirty?: boolean;
}

async function readManifest(out: AppPath): Promise<ReleaseManifest | null> {
  try {
    return JSON.parse(
      await readFile(join(out, "RELEASE.json"), "utf-8"),
    ) as ReleaseManifest;
  } catch (err) {
    if (
      (err as NodeJS.ErrnoException).code !== "ENOENT" &&
      !(err instanceof SyntaxError)
    )
      throw err;
    return null;
  }
}

/**
 * Stamp this run's terminal outcome on its ledger row, if the row is still open.
 *
 * This is the supervised-job kind's `closeRow`: a **bare, idempotent,
 * first-writer-wins write and nothing else**. It runs inside the supervised-run
 * reconciler of whichever backend sees the run end — a process that may know
 * nothing about the workflow that started it — so there is no log line, no
 * notification and no enqueue here. Those are `onEnded`'s, where they happen
 * exactly once (see `release-job.ts`).
 *
 * Closing here rather than only in the workflow is what keeps the kind from
 * wedging: the unfinished row IS the composition's in-flight lock, so a workflow
 * that dies would otherwise hold that lock against every future release of the
 * composition, permanently and with no symptom at the call site.
 *
 * The row's own facts are read back rather than passed in, for the same reason:
 * the caller is the reconciler, which knows only `(kindId, runId)`.
 *
 * `finishedAt` is the exit marker's **mtime**, never `new Date()`. A reconcile
 * that stamps its own `now` inflates the run's Duration by the whole gap between
 * the child exiting and something noticing — often the length of a restart — and
 * the row then disagrees with its own transcript.
 */
export async function closeReleaseRow(
  releaseId: string,
  terminal: RunTerminal,
): Promise<void> {
  const [row] = await db
    .select({
      composition: _releaseRuns.composition,
      target: _releaseRuns.target,
      kind: _releaseRuns.kind,
      startedAt: _releaseRuns.startedAt,
    })
    .from(_releaseRuns)
    .where(
      and(
        eq(_releaseRuns.id, releaseRunIdKind.key(releaseId)),
        isNull(_releaseRuns.finishedAt),
      ),
    );
  // Someone stamped it first — the ordinary shape of first-writer-wins, not an
  // error.
  if (row === undefined) return;

  const out = releaseOutDir(
    runtimeNamespace(),
    row.composition,
    row.target,
    releaseId,
  );
  const manifest = await readManifest(out);
  const ending: ReleaseEnding = {
    exitCode: terminal.exitCode,
    signalCode: terminal.signalCode,
    manifest: manifest !== null,
    durationSeconds: Math.round(
      (terminal.finishedAt.getTime() - row.startedAt.getTime()) / 1000,
    ),
  };
  const succeeded = releaseSucceeded(ending);

  const closed = await db
    .update(_releaseRuns)
    .set({
      finishedAt: terminal.finishedAt,
      exitCode: terminal.exitCode,
      status: succeeded ? "succeeded" : "failed",
      platform: manifest?.platform ?? null,
      artifactPath: succeeded ? out : null,
      port: manifest?.port ?? null,
      // Copied off the manifest, never re-read from git here: the run's source
      // state is what the CLI saw BEFORE its artifact phase, and this backend
      // reads the row long after that tree has moved on.
      commitSha: manifest?.commitSha ?? null,
      commitDirty: manifest?.commitDirty ?? null,
      // The one sentence, computed here and stored — so a caller that reports
      // the failure (the Deploy app's `update` reads it back through
      // `observeRelease`) and a user who later opens the run detail read one
      // wording, not two.
      error: succeeded ? null : releaseFailureMessage(ending),
    })
    .where(
      and(
        eq(_releaseRuns.id, releaseRunIdKind.key(releaseId)),
        isNull(_releaseRuns.finishedAt),
      ),
    )
    .returning({ id: _releaseRuns.id });

  // The `release.candidate` value is read off the filesystem, which the change
  // feed cannot see — so the one write that says "a new bundle may be on disk"
  // nudges it. Only when THIS call closed the row (a concurrent closer that
  // lost the guarded UPDATE got nothing back), and only for the one pair that
  // can have moved: a candidate run (a staged one claims no pointer) of the web
  // target (the only one `resolveBundle` resolves), whose manifest names a
  // platform the value is keyed by.
  if (
    closed.length > 0 &&
    row.kind === "candidate" &&
    row.target === "web" &&
    manifest !== null &&
    isPlatformTag(manifest.platform)
  ) {
    noteCandidateClosed(row.composition, manifest.platform);
  }
}

/**
 * Every release this namespace launched that has not been stamped with an
 * outcome.
 *
 * **Scoped to `namespace`, which is not optional.** A worktree DB is a fork of
 * main's and inherits its rows, so an unscoped read would hand the reconciler
 * another machine's runs — to adopt, to tail transcripts that do not exist here,
 * and to close with an outcome nobody in this namespace observed.
 */
export async function listUnfinished(): Promise<readonly UnfinishedRun[]> {
  const rows = await db
    .select({ id: _releaseRuns.id, pid: _releaseRuns.pid })
    .from(_releaseRuns)
    .where(
      and(
        isNull(_releaseRuns.finishedAt),
        eq(_releaseRuns.namespace, runtimeNamespace()),
      ),
    );
  return rows.map((row) => ({ runId: row.id, pid: row.pid }));
}

/** Record the pid of the detached CLI now serving this run. */
export async function setPid(releaseId: string, pid: number): Promise<void> {
  await db
    .update(_releaseRuns)
    .set({ pid })
    .where(eq(_releaseRuns.id, releaseRunIdKind.key(releaseId)));
}
