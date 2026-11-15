import type { SchemaOwner } from "@plugins/framework/plugins/server-core/core";

// Whether this boot's schema layer changed the database's data or shape:
// applied a pending migration, or deferred a contract it will run once the
// previous code is gone. A migration may write with no changelog row (a
// TRUNCATE fires no row trigger), so a consumer that proves "nothing changed
// since the previous backend's cut" from the changelog alone — the epoch
// handoff — cannot prove it across such a boot. Set by this plugin's
// `onReadyBlocking` once the layer committed; read after it.
let changed: boolean | undefined;

export function setSchemaChangedAtBoot(value: boolean): void {
  changed = value;
}

/** Throws before the boot schema layer committed — a boot-order bug, never "unchanged". */
export function schemaChangedAtBoot(): boolean {
  if (changed === undefined) {
    throw new Error(
      "schemaChangedAtBoot() read before the boot schema layer committed (database's onReadyBlocking)",
    );
  }
  return changed;
}

// This boot's schema-layer stamp, set by the owner's `onReadyBlocking` once the
// layer committed and recorded by its `onReady` (`recordSchemaLayerStamp`),
// after every blocking hook's boot DDL. Handed over once.
let bootStamp: { owner: SchemaOwner; stamp: string } | null = null;

export function setBootStamp(owner: SchemaOwner, stamp: string): void {
  bootStamp = { owner, stamp };
}

export function takeBootStamp(): { owner: SchemaOwner; stamp: string } | null {
  const taken = bootStamp;
  bootStamp = null;
  return taken;
}
