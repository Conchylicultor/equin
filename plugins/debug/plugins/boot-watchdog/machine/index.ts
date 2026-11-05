import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { bootWatchdogMonitorJob } from "./internal/monitor-job";

export default {
  description:
    "Boot-watchdog monitor, desktop-only half (it reads worktrees' boot channels off this computer's disk): a main-only per-minute scheduled job that reads the boot channel of every worktree that can hold a wedge — those the gateway runs a backend for, and those boot-events marks unsettled — and files a deduped boot-wedge report for any backend that never reached its `ready` line within the boot budget — superseded (post-hoc, once) or open (re-filed each tick while the worktree exists). Structurally main-only: a perWorktree job cannot observe its own wedged boot.",
  register: [bootWatchdogMonitorJob],
} satisfies MachinePluginDefinition;
