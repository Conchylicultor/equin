import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { submitTabMemorySample } from "../core";
import { handleTabMemorySample } from "./internal/routes";
import { tabMemorySeriesServed } from "./internal/resource";

export default {
  description:
    "Tab memory telemetry, server half: logs each page's sample to the durable tab-memory channel of the worktree it talks to, and serves tab-memory.series — every worktree's pages over the last 12 h beside each Chrome renderer's footprint (by pid) from main's health-owners log.",
  httpRoutes: {
    [submitTabMemorySample.route]: handleTabMemorySample,
  },
  contributions: [...tabMemorySeriesServed.declare],
} satisfies ServerPluginDefinition;
