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
import { db, DatabaseDriver } from "./driver";

/**
 * How long a verifier waits for its database's owner to set the schema up for
 * its code before it gives up. The wait it covers is a deploy: a push advances
 * main's checkout, a child boots out of it, and main's new backend commits the
 * layer when it boots — 26 s median after the fast-forward, minutes in a build
 * storm. Ten minutes is past any deploy that is going to finish; a child still
 * waiting then is on a database nothing will set up for it (an abandoned
 * deploy, a worktree's edits not built), and says so.
 */
export const SCHEMA_WAIT_MS = 10 * 60 * 1000;

/**
 * Resolve once the database's owner has committed the schema layer of exactly
 * this code (`verifySchemaLayer`) — at once in the steady state (one read), or
 * when the owner's layer commits (its NOTIFY on `SCHEMA_STAMPED_CHANNEL`, a
 * push: nothing polls). Throws `SchemaNotReadyError` after `SCHEMA_WAIT_MS`.
 *
 * Why the child waits rather than exiting to be respawned: the run stays
 * open, so whoever waits on it (a launch's `worktree.prepare` waiter, a
 * supervised job's loop) keeps waiting on the same run — a closed run with
 * a retry coming later reads, to them, as an outcome. And the boot already
 * paid for (~5 s, the module load) is not paid twice. While it waits it holds
 * no lock: the verify's read has ended, and LISTEN takes none.
 */
export async function awaitSchemaLayer(
  migrations: readonly Migration[],
  inputs: SchemaLayerInputs,
  step: BootStep,
): Promise<void> {
  const first = await step("verify", () =>
    verifySchemaLayer(db, migrations, inputs),
  );
  if (first.kind === "ready") return;
  await step("wait", () => waitForOwner(migrations, inputs, first));
}

async function waitForOwner(
  migrations: readonly Migration[],
  inputs: SchemaLayerInputs,
  first: Extract<SchemaLayerCheck, { kind: "not-ready" }>,
): Promise<void> {
  dbLog.publish(
    `[database] waiting for the serving backend to set the schema up for this code (up to ${String(SCHEMA_WAIT_MS / 60_000)} min): ${first.detail}`,
  );
  const started = Date.now();
  // Sticky: a NOTIFY that lands while the loop is reading (no wait armed)
  // is kept for the next wait, never dropped.
  let notified = false;
  let wake: (() => void) | null = null;
  let lost: unknown = null;
  const session = await DatabaseDriver.get().listen([SCHEMA_STAMPED_CHANNEL], {
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
  try {
    for (;;) {
      // After LISTEN took effect, so a commit between the first read and here
      // is either seen by this read or delivered as a notification (kept in
      // `notified` until the next wait).
      notified = false;
      const check = await verifySchemaLayer(db, migrations, inputs);
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
      const remaining = SCHEMA_WAIT_MS - (Date.now() - started);
      if (remaining <= 0) throw new SchemaNotReadyError(check.detail);
      if (notified) continue;
      await withDeadline(
        new Promise<void>((resolve) => {
          wake = resolve;
        }),
        remaining,
        () =>
          new SchemaNotReadyError(
            `${check.detail} — waited ${String(SCHEMA_WAIT_MS / 60_000)} min and no backend set it up`,
          ),
      );
      wake = null;
    }
  } finally {
    await session.close();
  }
}
