import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { duressConfig } from "../core";

export { readDuressConfig } from "./internal/read-config";

// The latch lives in the `latch` leaf sub-plugin and the shed engine in the
// `shed` sub-plugin — import them from their own barrels
// (`…/duress/plugins/latch/server`, `…/duress/plugins/shed/server`). This barrel
// only registers the shed engine's config (and reads it: `readDuressConfig`),
// so it runs on every host: a browser host whose page shows the config
// (Settings → Config) serves it too.
export default {
  description:
    "Host-global duress: registers the shed engine's config (enabled, persist-first-N, buffer caps, flush delay). The latch file (a mtime-leased latch the cluster sentinel sets while the box is in trouble, read via the cheap synchronous isUnderDuress()) is the latch sub-plugin, the shed engine (per-episode first-N persistence, a bounded buffer, flush-on-clear replay) the shed sub-plugin.",
  contributions: [ConfigV2.Register({ descriptor: duressConfig })],
  portable: true,
} satisfies ServerPluginDefinition;
