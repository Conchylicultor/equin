import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { fileTestFailingReports } from "./internal/file-reports";

export default {
  description:
    "Files the test-failing reports of main (fileTestFailingReports, called by the idle test runner after each batch's verdicts are ingested): each file of the batch judged by judgeFailingFile — failing on its current code with no pass, confirmed by a second failure, after having passed in main's checkout — becomes one occurrence of its file's report, with the failing cases, the last-passed and first-failed commits, and the failing run's commit as the occurrence's commit. One incident (one bell) per batch. Main only.",
} satisfies MachinePluginDefinition;
