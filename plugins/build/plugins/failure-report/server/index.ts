import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { buildFailedKind } from "./internal/kind";

export { linkRunReport, runReportIds } from "./internal/link";

export default {
  description:
    "The build-failed report kind: a failed build of main, deduped on what failed (the failing step, and its failing checks or normalized error line — not the run), category error so the Error reports supervisor stream carries it, with the fix ledger of every report. linkRunReport makes a task the owner of the report a run fell into (build/machine calls it when an Investigate task is filed about a build run).",
  contributions: [buildFailedKind],
} satisfies ServerPluginDefinition;
