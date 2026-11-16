import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { fileBuildFailureReport } from "./internal/file-report";
export type { FailedBuildRun } from "./internal/file-report";

export default {
  description:
    "Files a failed build of main as a build-failed report (fileBuildFailureReport, called where the build's outcome is told): what failed read from the run's transcript (the failed step block, its failing checks and first error line, or the output a crash or abort ended in), the commit the build built as the occurrence's commit, no second bell. Main only, failed status only.",
} satisfies MachinePluginDefinition;
