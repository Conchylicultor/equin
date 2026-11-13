import {
  pluginLoadReportSink,
  type PluginDefinition,
} from "@plugins/framework/plugins/web-sdk/core";
import { drain } from "@plugins/primitives/plugins/report-sink/web";
import { ReportSinks } from "@plugins/reports/plugins/collectors/web";
import { collectPluginLoadError } from "./internal/plugin-load-error-reporter";

export default {
  description:
    "Files crash tasks for plugins whose chunk failed to load, each after a load probe: the tab walks the failing plugin's static import graph through its own import map and asks the server for each file, so the report says what failed (a 404 file of its build — named as missingFile, the server re-checks it as retired — every file served, a network error, another status) instead of the browser's one ambiguous message.",
  contributions: [
    ReportSinks.Collector({
      from: "framework.web-sdk",
      collect: drain(pluginLoadReportSink, collectPluginLoadError),
      companion: true,
    }),
  ],
} satisfies PluginDefinition;
