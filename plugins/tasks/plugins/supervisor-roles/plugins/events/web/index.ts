import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { IdKinds } from "@plugins/ids/web";
import { eventMessageIdKind, pendingEventIdKind } from "../core";

export default {
  description:
    "Supervisor event streams, web half: registers the supervisor event message and gathered event id kinds, so their ids are recognised in the browser as on the server.",
  contributions: [
    IdKinds.Kind({ kind: eventMessageIdKind }),
    IdKinds.Kind({ kind: pendingEventIdKind }),
  ],
} satisfies PluginDefinition;
