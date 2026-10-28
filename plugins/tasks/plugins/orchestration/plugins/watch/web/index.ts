import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { IdKinds } from "@plugins/ids/web";
import { watchEventIdKind, watchIdKind } from "../core";

export default {
  description:
    "Watch, web half: registers the watch and watch-event id kinds, so their ids are recognised in the browser as on the server.",
  contributions: [
    IdKinds.Kind({ kind: watchIdKind }),
    IdKinds.Kind({ kind: watchEventIdKind }),
  ],
} satisfies PluginDefinition;
