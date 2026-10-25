import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { buildRunCommitsServed } from "./internal/run-commits-value";

export default {
  description:
    "Per-run commit list, desktop-only: the build.run-commits live value — git log from the previous successful build to the run's commit, capped, recomputed on a ledger write.",
  contributions: [...buildRunCommitsServed.declare],
} satisfies MachinePluginDefinition;
