import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { groovePresetsConfig } from "../shared/groove-presets";
import { setRhythmEndpoint } from "../shared/endpoints";
import { handleSetRhythm } from "./internal/routes";
import { rhythmsServed } from "./internal/resource";

export { songRhythm } from "./internal/tables";

export default {
  description:
    "Owns the sonata_songs_ext_rhythm side-table: per-song rhythm groove (enabled + a bass and a chord RhythmPattern, figuration and HandVoicing + the groove preset it was applied from). Serves it as a per-song lookup collection. Server registration of the global groove-presets config.",
  httpRoutes: {
    [setRhythmEndpoint.route]: handleSetRhythm,
  },
  contributions: [
    ...rhythmsServed.declare,
    ConfigV2.Register({ descriptor: groovePresetsConfig }),
  ],
} satisfies ServerPluginDefinition;
