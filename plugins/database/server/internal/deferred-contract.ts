import { View } from "@plugins/database/plugins/derived-views/server";
import { DerivedTable } from "@plugins/database/plugins/derived-tables/server";
import { registeredDerivedUpdatedAt } from "@plugins/database/plugins/derived-updated-at/server";
import {
  completeDeferredContract,
  generationsKnowing,
  MigrationSource,
  type SchemaLayerInputs,
} from "@plugins/database/plugins/migrations/server";
import { db, DatabaseDriver } from "./driver";

// The derived set the schema layer installs, read at the call site (see the
// boot comment in `../index.ts`) — by the boot layer and by the deferred
// contract's run.
export function derivedInputs(): SchemaLayerInputs {
  return {
    views: View.getContributions(),
    derivedTables: DerivedTable.getContributions(),
    updatedAtSpecs: registeredDerivedUpdatedAt(),
  };
}

// The phased file whose contract this boot's schema layer deferred, for
// `onReady` to run once older code is gone. Null when nothing was deferred.
let deferredContract: string | null = null;

export function setDeferredContract(file: string | null): void {
  deferredContract = file;
}

/** The deferred file, handed over once. */
export function takeDeferredContract(): string | null {
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
export async function runDeferredContract(file: string): Promise<void> {
  const driver = DatabaseDriver.get();
  const migrations = MigrationSource.get().list();
  const release = await driver.awaitGenerationsGone(
    generationsKnowing(migrations, file),
  );
  try {
    await driver.bootDdl(
      () => completeDeferredContract(db, migrations, derivedInputs()),
      "deferred contract",
    );
  } finally {
    await release();
  }
}
