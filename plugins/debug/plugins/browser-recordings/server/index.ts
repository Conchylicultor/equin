import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { browserRecordingRunsServed } from "./internal/list-runs";

export default {
  description:
    "Serves the browser recordings filed under one tool call (the browser-recordings.runs live value) — an e2e run's steps, or a browser_* MCP call's frame — pushed when a run's manifest lands in the browser-recordings data dir.",
  contributions: [...browserRecordingRunsServed.declare],
} satisfies ServerPluginDefinition;
