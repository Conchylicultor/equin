import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
// The build_runs entity and the claim-time settle the backend shares with the
// CLI. The CLI itself imports `run-ledger/cli` (the recorder), never this
// barrel: the entity loads the field-storage manifest.
export { _buildRuns } from "./internal/tables";
export { settleDeadInflightRun } from "../shared/stale-holder";
export default {
  description:
    "Build-runs ledger leaf: the build_runs entity, and (cli/) the hand-SQL build-run recorder the `./singularity build` CLI imports without the table or the heavy build barrel.",
  contributions: [],
} satisfies ServerPluginDefinition;
