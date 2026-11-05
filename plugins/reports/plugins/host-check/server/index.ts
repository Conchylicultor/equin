import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { hostCheckKind } from "./internal/kind";

export default {
  description:
    "Host-check report kind: one row per failing host-scoped check (fingerprint = check id), filed through the report outbox by main's hourly checks.host-audit job (`./equin check --scope host --file-reports`) — the only place a host check's verdict is delivered, since no worktree's check pass asserts the shared machine. Renders a task carrying the check's message and hint verbatim. Warning, re-arms every 6 h.",
  contributions: [hostCheckKind],
} satisfies ServerPluginDefinition;
