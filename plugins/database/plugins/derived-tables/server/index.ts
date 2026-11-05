import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { DerivedTable } from "./internal/contribution";
export {
  prepareRollupTables,
  reconcileRollups,
  type PreparedRollups,
  feedExemptTables,
  rollupSources,
} from "./internal/rebuild";
export {
  publishReconciledRollups,
  reconciledRollups,
} from "./internal/reconciled";

export default {
  description:
    "Trigger-maintained materialized rollup tables as data: defineRollup generates a rollup's table, a maintain function and triggers per source (diffing the columns it reads, advisory-locked per key) and a diff-first reconcile; each rollup's functions and triggers a db-triggers set (rollup.<table>) the one trigger installer installs; the boot schema layer prepares the tables, installs every trigger set at once, reconciles, and reports what each reconcile healed (reconciledRollups). rollupSources() maps each rollup to the tables whose writes move it.",
} satisfies ServerPluginDefinition;
