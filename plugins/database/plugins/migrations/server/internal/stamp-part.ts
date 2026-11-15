import { defineServerContribution } from "@plugins/framework/plugins/server-core/core";

/** One part of the schema-layer stamp that boot DDL outside the layer contributes. */
export interface SchemaStampPartSpec {
  /** The part's name, as a stamp mismatch reports it (`[A-Za-z0-9_.-]`). */
  readonly id: string;
  /**
   * What this code requires of the database, as plain text: equal on two
   * codes only if both run against the same install. A version, a revision,
   * a definition's hash. Never anything read from the database.
   */
  readonly digest: string;
}

// Boot DDL that a plugin installs ITSELF, in its own `onReadyBlocking`, rather
// than through the schema layer: the stamp sees it only through this kind.
// The owner records the stamp once every blocking hook has committed (its
// `onReady`), so an exec child admitted by an equal stamp finds the install
// this part describes. Contribute one only when an exec child of NEW code
// running against the OLD install breaks: it errors, reads wrong results, or
// writes data in a shape the install does not expect. A child writing through
// an older install the serving backend itself still writes through needs none.
// The migrations plugin's CLAUDE.md, "The schema layer's stamp", gives each
// owner's verdict.
export const SchemaStampPart = defineServerContribution<SchemaStampPartSpec>(
  "schema-stamp-part",
  { docLabel: (c) => c.id },
);
