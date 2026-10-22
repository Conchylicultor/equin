import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
// The build_runs entity. The CLI itself imports `run-ledger/cli` (the
// recorder), never this barrel: the entity loads the field-storage manifest.
// The claim-time settle the backend shares with the CLI reads the disk, so it
// is the machine barrel's (`run-ledger/machine`).
export { _buildRuns } from "./internal/tables";
export default {
  description:
    "Build-runs ledger leaf: the build_runs entity, and (cli/) the hand-SQL build-run recorder the `./singularity build` CLI imports without the table or the heavy build barrel.",
  portable: true,
  contributions: [],
} satisfies ServerPluginDefinition;
