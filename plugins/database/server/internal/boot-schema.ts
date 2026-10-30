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
