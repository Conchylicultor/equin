import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { endpointErrorSink } from "@plugins/infra/plugins/endpoints/web";
import { drain } from "@plugins/primitives/plugins/report-sink/web";
import { ReportSinks } from "@plugins/reports/plugins/collectors/web";
import { collectEndpointError } from "./internal/endpoint-error-reporter";

export default {
  description:
    "Files crash tasks for bug-shaped handled endpoint errors (validation 400s and 5xx).",
  contributions: [
    ReportSinks.Collector({
      from: "infra.endpoints",
      collect: drain(endpointErrorSink, collectEndpointError),
      companion: true,
    }),
  ],
} satisfies PluginDefinition;
