import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { clientRateConfig } from "../core";
import { clientRateMonitorJob } from "./internal/monitor-job";
import { clientRateKind } from "./internal/client-rate-kind";

export default {
  description:
    "Per-client page-load judge: a per-worktree job that counts each browser tab's page loads and in-app navigations in the clock hour so far (the latency ledger's interactions, by tab id) and files a client-rate report when one tab is far past what a client usually does in an hour (the 99th percentile of the last 7 days' client-hours) — the reload loop a per-op call-count alarm cannot see. Automated tabs are judged alike and marked.",
  register: [clientRateMonitorJob],
  contributions: [
    ConfigV2.Register({ descriptor: clientRateConfig }),
    clientRateKind,
  ],
} satisfies ServerPluginDefinition;
