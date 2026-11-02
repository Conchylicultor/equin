import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { DerivedTable } from "./internal/contribution";
export {
  rebuildDerivedTables,
  feedExemptTables,
  rollupSources,
} from "./internal/rebuild";
export {
  publishReconciledRollups,
  reconciledRollups,
} from "./internal/reconciled";

export default {
  description:
    "Trigger-maintained materialized rollup tables as data: defineRollup generates a rollup's table, a maintain function and triggers per source (diffing the columns it reads, advisory-locked per key) and a diff-first reconcile; the boot schema layer installs only what changed, one source table per savepoint, and reports what each reconcile healed (reconciledRollups). rollupSources() maps each rollup to the tables whose writes move it.",
} satisfies ServerPluginDefinition;
