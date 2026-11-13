import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { drain } from "./internal/drain";
export type { SinkDrain } from "./internal/drain";

export default {
  description:
    "Web presence for the report-sink primitive; the runtime-agnostic factories live in ./core so both web and server can import them. defineReportSink() is fire-and-forget and holds reports emitted before a handler registers (bounded), replaying them on register; defineRequestSink() returns the handler's answer and never holds. emit() never throws — it is called on error paths. drain(sink, handler) is how a browser collector of another plugin's sink is spelled (a reports.collectors Collector contribution), attached ref-counted per sink.",
  contributions: [],
} satisfies PluginDefinition;
