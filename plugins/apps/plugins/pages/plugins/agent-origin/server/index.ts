import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { LiveColumns } from "@plugins/network/plugins/live/server";
import { BlockLifecycle } from "@plugins/page/plugins/editor/server";
import { agentOriginCreateHook } from "./internal/create-hook";
import { agentPagesSweep } from "./internal/sweep";
import { pageBlocksOrigin } from "./internal/tables";

export { pageBlocksOrigin } from "./internal/tables";

export default {
  description:
    "Agent-origin provenance for pages (page_blocks_ext_origin): a create-hook contributor stamps every page written by an automated session (x-singularity-origin: agent) with the script that minted it, the marker's presence is exposed as the `origin` field (agent | user) of every list whose rows are blocks — the Pages sidebar's Private / Scratch sections — and a 24h retention sweep trashes the marked pages.",
  // The sweep declares `schedule` — the jobs worker seeds its cron item at
  // startup, so no onReady enqueue is needed.
  register: [agentPagesSweep],
  contributions: [
    // `origin`, folded into every list whose rows are blocks (pages.tree).
    LiveColumns.Expose(pageBlocksOrigin),
    // Stamps the marker after the block row lands. The editor dispatches this
    // generically and never names this plugin — which is the whole reason the
    // hook exists (an inline stamp would make the editor import us back, a cycle).
    BlockLifecycle.AfterCreate(agentOriginCreateHook),
  ],
} satisfies ServerPluginDefinition;
