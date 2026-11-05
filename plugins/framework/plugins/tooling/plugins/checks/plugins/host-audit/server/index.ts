import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { hostAuditJob } from "./internal/host-audit-job";

export default {
  description:
    "The hourly checks.host-audit job: runs the host-scoped checks on main and files a host-check report per failure — the one place a verdict about the shared machine is delivered, since no worktree's check pass asserts it.",
  register: [hostAuditJob],
} satisfies ServerPluginDefinition;
