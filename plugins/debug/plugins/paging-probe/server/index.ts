import { isMain } from "@plugins/infra/plugins/runtime-identity/core";
import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2, getConfig } from "@plugins/config_v2/server";
import { isRelease } from "@plugins/infra/plugins/paths/server";
import { pagingProbeConfig } from "../core";
import {
  pagingProbeDaemon,
  startPagingProbes,
  stopPagingProbes,
} from "./internal/probe-host";

export default {
  description:
    "Twin-probe paging-victim discriminator: three main-only child processes with controlled heap shapes (lean / fat-idle / fat-touch) measure event-loop lag under host memory pressure, so divergence between them separates scheduling from cold-page-fault mechanisms. Config-gated, OFF by default; writes paging-probe-<variant>.jsonl.",
  contributions: [ConfigV2.Register({ descriptor: pagingProbeConfig })],
  // Listed in Background activity whether or not the experiment is on.
  register: [pagingProbeDaemon],
  // Main-only (main is the victim under test) and NEVER in a compiled release
  // (a release is a shipped composition, not a diagnostics host — unlike the
  // sentinel, which must run on releases too). Off unless explicitly enabled:
  // the fat variants allocate real cold heap, so this is an experiment switch.
  onReady: async () => {
    if (!isMain() || isRelease()) return;
    if (!getConfig(pagingProbeConfig).enabled) return;
    await startPagingProbes();
  },
  onShutdown: async () => {
    await stopPagingProbes();
  },
} satisfies ServerPluginDefinition;
