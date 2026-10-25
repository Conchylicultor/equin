import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { timelineScanServed } from "./internal/scan-served";
import { timelineTool } from "./internal/mcp-tool";

export default {
  description:
    "Cross-worktree unified timeline: fans out over every live worktree DB fork (traces, slow-op samples, reports, builds) plus the per-worktree disk logs (boot events, health series), normalizes everything to wall-clock TimelineEvents, and serves it as the debug.timeline.scan live value — one scan per window, pushed as each cell resolves.",
  contributions: [...timelineScanServed.declare],
  register: [timelineTool],
} satisfies ServerPluginDefinition;
