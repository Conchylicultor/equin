import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
// The claim-time settle of a dead holder of `build_runs_inflight_uniq`, shared
// with the CLI's recorder (`shared/recorder.ts`). Desktop-only: it reads the
// build's own terminal record off disk and probes the holder's pid.
export { settleDeadInflightRun } from "../shared/stale-holder";

export default {
  description:
    "Build-runs ledger, desktop-only half: settleDeadInflightRun — closing a build_runs in-flight row whose build provably ended (its terminal record on disk, or its process gone), for the backend's claim.",
} satisfies MachinePluginDefinition;
