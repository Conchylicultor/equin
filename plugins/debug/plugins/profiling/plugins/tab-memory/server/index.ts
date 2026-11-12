import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { submitTabMemorySample, tabMemoryClimbConfig } from "../core";
import { tabMemoryClimbJob } from "./internal/climb-job";
import { tabMemoryClimbKind } from "./internal/climb-kind";
import { handleTabMemorySample } from "./internal/routes";
import { tabMemorySeriesServed } from "./internal/resource";

export default {
  description:
    "Tab memory telemetry, server half: logs each page's sample to the durable tab-memory channel of the worktree it talks to, and serves tab-memory.series — every worktree's pages over the last 12 h beside each Chrome renderer's footprint (by pid) from main's health-owners log. The climb watch: every 10 minutes on main, a Chrome renderer whose memory floor is too large or climbing files a tab-memory-climb report (error) with its growth curve, the pages alive through its window and what grew.",
  httpRoutes: {
    [submitTabMemorySample.route]: handleTabMemorySample,
  },
  register: [tabMemoryClimbJob],
  contributions: [
    ...tabMemorySeriesServed.declare,
    ConfigV2.Register({ descriptor: tabMemoryClimbConfig }),
    tabMemoryClimbKind,
  ],
} satisfies ServerPluginDefinition;
