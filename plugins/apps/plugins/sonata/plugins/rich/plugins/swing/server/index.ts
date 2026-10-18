import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { swingDisplayConfig } from "../shared/config";
import { setSwingEndpoint } from "../shared/endpoints";
import { handleSetSwing } from "./internal/routes";
import { swingsServed } from "./internal/resource";

export { songSwing } from "./internal/tables";

export default {
  description:
    "Owns the sonata_songs_ext_swing side-table: a song's swing override (straight, or a chosen 8ths/16ths feel; no row = the song's own). Serves it as a per-song lookup collection. Server registration of the swing display config (swing the falling notes).",
  httpRoutes: {
    [setSwingEndpoint.route]: handleSetSwing,
  },
  contributions: [
    ...swingsServed.declare,
    ConfigV2.Register({ descriptor: swingDisplayConfig }),
  ],
} satisfies ServerPluginDefinition;
