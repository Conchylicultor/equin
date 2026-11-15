import { View } from "@plugins/database/plugins/derived-views/server";
import { DerivedTable } from "@plugins/database/plugins/derived-tables/server";
import { registeredDerivedUpdatedAt } from "@plugins/database/plugins/derived-updated-at/server";
import {
  DbTrigger,
  DbTriggerClaim,
} from "@plugins/database/plugins/db-triggers/server";
import {
  completeDeferredContract,
  generationsKnowing,
  MigrationSource,
  SchemaStampPart,
  type SchemaLayerInputs,
} from "@plugins/database/plugins/migrations/server";
import { db, DatabaseDriver } from "./driver";
import type { SchemaOwner } from "@plugins/framework/plugins/server-core/core";

// The derived set the schema layer installs, read at the call site (see the
// boot comment in `../index.ts`) — by the boot layer and by the deferred
// contract's run.
export function derivedInputs(): SchemaLayerInputs {
  return {
    views: View.getContributions(),
    derivedTables: DerivedTable.getContributions(),
    updatedAtSpecs: registeredDerivedUpdatedAt(),
    triggers: DbTrigger.getContributions(),
    claimedTriggerSets: DbTriggerClaim.getContributions().map((c) => c.id),
    stampParts: SchemaStampPart.getContributions(),
  };
}

// The phased file whose contract this boot's schema layer deferred, for
// `onReady` to run once older code is gone — with the owner token the layer
// ran under. Null when nothing was deferred.
let deferredContract: DeferredContract | null = null;

interface DeferredContract {
  readonly owner: SchemaOwner;
  readonly file: string;
}

export function setDeferredContract(file: DeferredContract | null): void {
  deferredContract = file;
}

/** The deferred file, handed over once. */
export function takeDeferredContract(): DeferredContract | null {
  const file = deferredContract;
  deferredContract = null;
  return file;
}

// The deferred contract: wait until no process running code older than its
// group is connected (`awaitGenerationsGone` — in a hot-swap, the previous
// backend draining, and any child it spawned), then run it. Its failure is
// loud (an unhandled rejection is a report) and leaves the row
// `contract_pending`: the code serving now runs on the expanded schema, and the
// next boot tries again. See
// research/2026-10-28-database-deferred-contract-phase.md.
export async function runDeferredContract(
  owner: SchemaOwner,
  file: string,
): Promise<void> {
  const driver = DatabaseDriver.get();
  const migrations = await MigrationSource.get().list();
  const release = await driver.awaitGenerationsGone(
    generationsKnowing(migrations, file),
  );
  try {
    await driver.bootDdl(
      owner,
      () => completeDeferredContract(db, owner, migrations, derivedInputs()),
      "deferred contract",
    );
  } finally {
    await release();
  }
}
