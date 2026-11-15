import {
  SchemaNotReadyError,
  type BootStep,
} from "@plugins/framework/plugins/server-core/core";
import {
  SCHEMA_STAMPED_CHANNEL,
  verifySchemaLayer,
  type Migration,
  type SchemaLayerCheck,
  type SchemaLayerInputs,
} from "@plugins/database/plugins/migrations/server";
import { withDeadline } from "@plugins/packages/plugins/deadline/core";
import { dbLog } from "./db-log";
import { db, DatabaseDriver, type DatabaseDriverImpl } from "./driver";

/**
 * How long a verifier waits at most for a build or deploy in flight to set the
 * schema up for its code. The wait it covers is a deploy: a push advances
 * main's checkout, a child boots out of it, and main's new backend commits the
 * layer when it boots — 26 s median after the fast-forward, minutes in a build
 * storm. A verifier with no build or deploy in flight does not wait at all
 * (`awaitSchemaLayer`); this bounds one that never ends.
 */
export const SCHEMA_WAIT_MS = 10 * 60 * 1000;

/**
 * Resolve once the database's owner has committed the schema layer of exactly
 * this code (`verifySchemaLayer`) — at once in the steady state (one read), or
 * when the owner's layer commits (its NOTIFY on `SCHEMA_STAMPED_CHANNEL`, a
 * push: nothing polls).
 *
 * It waits only while an owner can still be on its way: a build or deploy in
 * flight (`DatabaseDriver.awaitDeploysSettled`) — main's ~26 s deploy window.
 * Once none is and the schema is still not set up for this code, nothing will
 * set it up (a worktree's edits not built, a deploy that failed or built
 * other code), and it throws `SchemaNotReadyError` at once — so a checkout
 * ahead of its running backend fails its children in a second, not after
 * `SCHEMA_WAIT_MS` each (task-1794738110-dfjqyq). `SCHEMA_WAIT_MS` bounds a
 * deploy that never ends.
 *
 * Why the child waits rather than exiting to be respawned: the run stays
 * open, so whoever waits on it (a launch's `worktree.prepare` waiter, a
 * supervised job's loop) keeps waiting on the same run — a closed run with
 * a retry coming later reads, to them, as an outcome. And the boot already
 * paid for (~5 s, the module load) is not paid twice. While it waits it holds
 * no lock (the verify's read has ended, and LISTEN takes none) and no host
 * admission slot (`yieldAdmission`, given back for the wait).
 */
export async function awaitSchemaLayer(
  migrations: readonly Migration[],
  inputs: SchemaLayerInputs,
  step: BootStep,
  yieldAdmission: <T>(wait: () => Promise<T>) => Promise<T>,
): Promise<void> {
  const first = await step("verify", () =>
    verifySchemaLayer(db, migrations, inputs),
  );
  if (first.kind === "ready") return;
  await step("wait", () =>
    yieldAdmission(() =>
      waitForOwner(first, {
        verify: () => verifySchemaLayer(db, migrations, inputs),
        driver: DatabaseDriver.get(),
        waitMs: SCHEMA_WAIT_MS,
      }),
    ),
  );
}

/** What `waitForOwner` reads the schema and the host through. */
export interface OwnerWaitDeps {
  /** One read of whether the schema is set up for this code (`verifySchemaLayer`). */
  verify(): Promise<SchemaLayerCheck>;
  driver: Pick<DatabaseDriverImpl, "listen" | "awaitDeploysSettled">;
  /** The bound on the whole wait (`SCHEMA_WAIT_MS`). */
  waitMs: number;
}

/**
 * The wait itself, after a first read found the schema not set up for this
 * code (`first`): LISTEN for the owner's stamp and watch the builds and
 * deploys in flight, re-reading on each wake — ready resolves; every build and
 * deploy settled with the schema still not ready throws at once; `waitMs`
 * elapsed throws.
 */
export async function waitForOwner(
  first: Extract<SchemaLayerCheck, { kind: "not-ready" }>,
  deps: OwnerWaitDeps,
): Promise<void> {
  const { driver, verify, waitMs } = deps;
  const started = Date.now();
  // Sticky: a NOTIFY that lands while the loop is reading (no wait armed)
  // is kept for the next wait, never dropped.
  let notified = false;
  let wake: (() => void) | null = null;
  let lost: unknown = null;
  const session = await driver.listen("schema-wait", [SCHEMA_STAMPED_CHANNEL], {
    notification: () => {
      notified = true;
      wake?.();
    },
    lost: (err) => {
      lost = err;
      notified = true;
      wake?.();
    },
  });
  // Armed after LISTEN took effect: an owner that records its stamp and lets
  // its build lock go after this point is heard as a NOTIFY, and one that did
  // before it is seen by the read that follows the settle.
  const stopWatching = new AbortController();
  let settled = false;
  let waitedOn: readonly string[] = [];
  // Cast, not annotated: set from a callback, which tsc's narrowing of the
  // initializer does not see.
  let watchFailed = null as { err: unknown } | null;
  const deploys = driver.awaitDeploysSettled(stopWatching.signal).then(
    (what) => {
      waitedOn = what;
      settled = true;
      wake?.();
    },
    (err: unknown) => {
      // Our own abort, once the wait is over, is not a failure.
      if (stopWatching.signal.aborted) return;
      watchFailed = { err };
      wake?.();
    },
  );
  dbLog.publish(
    `[database] waiting for the build or deploy in flight to set the schema up for this code (up to ${String(Math.round(waitMs / 60_000))} min): ${first.detail}`,
  );
  try {
    for (;;) {
      notified = false;
      const wasSettled = settled;
      const check = await verify();
      if (check.kind === "ready") {
        dbLog.publish(
          `[database] the schema is set up for this code, after ${String(Math.round((Date.now() - started) / 1000))} s`,
        );
        return;
      }
      if (lost !== null) {
        throw new Error(
          "[database] lost the LISTEN session while waiting for the schema to be set up",
          { cause: lost },
        );
      }
      if (watchFailed !== null) {
        throw new Error(
          "[database] could not watch for the builds and deploys in flight while waiting for the schema to be set up",
          { cause: watchFailed.err },
        );
      }
      // Read after every build and deploy in flight ended (each records its
      // owner's stamp before it lets go): no owner is on its way.
      if (wasSettled)
        throw new SchemaNotReadyError(nothingComing(check, waitedOn));
      const remaining = waitMs - (Date.now() - started);
      if (remaining <= 0) throw new SchemaNotReadyError(check.detail);
      if (notified || settled || watchFailed !== null) continue;
      await withDeadline(
        new Promise<void>((resolve) => {
          wake = resolve;
        }),
        remaining,
        () =>
          new SchemaNotReadyError(
            `${check.detail} — waited ${String(Math.round(waitMs / 60_000))} min and the build or deploy in flight did not set it up`,
          ),
      );
      wake = null;
    }
  } finally {
    stopWatching.abort();
    await deploys;
    await session.close();
  }
}

/** Why no owner will set this database up for this code, for the refusal. */
function nothingComing(
  check: Extract<SchemaLayerCheck, { kind: "not-ready" }>,
  waitedOn: readonly string[],
): string {
  const after =
    waitedOn.length === 0
      ? "no build or deploy of this checkout is in flight"
      : `${waitedOn.join(" and ")} ended without setting it up for this code`;
  return `${check.detail}; ${after}, so nothing will — if this checkout has changes its backend was not built from, run \`./equin build\``;
}
