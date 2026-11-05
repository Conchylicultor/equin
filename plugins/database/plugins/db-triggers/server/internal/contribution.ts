import { defineServerContribution } from "@plugins/framework/plugins/server-core/core";
import type { DbTriggerSet } from "./define";

// A plugin declares each of its trigger sets here, in its server plugin
// definition's `contributions: [...]`; the database plugin hands every one to
// the boot schema layer, which installs them after the migrations and the
// derived `updatedAt` triggers (`installDbTriggers`).
export const DbTrigger = defineServerContribution<DbTriggerSet>("db-trigger", {
  docLabel: (c) => c.id,
});
