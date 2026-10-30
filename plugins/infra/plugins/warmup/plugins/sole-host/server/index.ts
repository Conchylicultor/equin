import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { WarmupHost } from "@plugins/infra/plugins/warmup/server";

export default {
  description:
    "Warm-up admission of a sole host — one backend with no neighbours (the browser composition, the portable boot test): provides the WarmupHost host service running every scope, host-scoped warm-ups included, with no slot to take. Never booted by the desktop.",
  portable: true,
  contributions: [
    WarmupHost.provide({
      runs: () => true,
      withSlot: (fn) => fn(),
    }),
  ],
} satisfies ServerPluginDefinition;
