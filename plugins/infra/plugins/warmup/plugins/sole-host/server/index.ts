import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { WarmupHost } from "@plugins/infra/plugins/warmup/server";

export default {
  description:
    "Warm-up admission of a sole host — one backend with no neighbours (the browser composition, the portable boot test): provides the WarmupHost host service running every scope, host-scoped warm-ups included, with no slot to take, and no code digest (a warm-up declaring derivedFrom runs on every boot). Never booted by the desktop.",
  contributions: [
    WarmupHost.provide({
      runs: () => true,
      withSlot: (fn) => fn(),
      // No source tree to digest: a derivedFrom warm-up runs on every boot.
      // A browser host's corpus is its own seed (derived by the seed's own
      // writes) or what its storage kept, never main's, so that pass is small.
      codeDigest: () => Promise.resolve(null),
    }),
  ],
} satisfies ServerPluginDefinition;
