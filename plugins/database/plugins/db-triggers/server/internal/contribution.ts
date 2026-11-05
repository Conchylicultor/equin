import { defineServerContribution } from "@plugins/framework/plugins/server-core/core";
import type { DbTriggerSet } from "./define";

// A plugin declares each of its trigger sets here, in its server plugin
// definition's `contributions: [...]`; the database plugin hands every one to
// the boot schema layer, which installs them after the migrations and the
// derived `updatedAt` triggers (`installDbTriggers`).
export const DbTrigger = defineServerContribution<DbTriggerSet>("db-trigger", {
  docLabel: (c) => c.id,
});

/** A set its plugin installs by its own `installDbTriggers` call. */
export interface DbTriggerClaimSpec {
  /** The set's id. */
  readonly id: string;
  /** Why it is not a `DbTrigger` the schema layer installs. */
  readonly reason: string;
}

// A plugin claims here a set it installs itself, outside the boot schema
// layer (the change feed's, built from the booted resource registry). The
// schema layer's sweep of `public` would otherwise read that set as removed
// and drop it; read as data, so the layer's dry run sees the claim too.
export const DbTriggerClaim = defineServerContribution<DbTriggerClaimSpec>(
  "db-trigger-claim",
  { docLabel: (c) => c.id },
);
