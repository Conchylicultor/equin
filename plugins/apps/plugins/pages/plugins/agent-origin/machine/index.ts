import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { agentPagesSweep } from "./internal/sweep";

export default {
  description:
    "Agent-origin, desktop-only half: the 24h retention sweep that trashes the pages an automated session marked (a nightly job over page_blocks_ext_origin).",
  // The sweep declares `schedule` — the jobs worker seeds its cron item at
  // startup, so no onReady enqueue is needed.
  register: [agentPagesSweep],
} satisfies MachinePluginDefinition;
