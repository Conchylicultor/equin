import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { IdKinds } from "@plugins/ids/web";
import { FieldPresentation } from "@plugins/network/plugins/live/web";
import { taskManagerShape, watchEventIdKind, watchIdKind } from "../core";

export default {
  description:
    "Watch, web half: registers the watch and watch-event id kinds, so their ids are recognised in the browser as on the server; presents the exposed `managedBy` field (Agent / You — whether another task's agent watches the task) in every list whose rows reach a task.",
  contributions: [
    IdKinds.Kind({ kind: watchIdKind }),
    IdKinds.Kind({ kind: watchEventIdKind }),
    // The exposed `managedBy` field (Agent / You) in every list whose rows
    // reach a task, presented by its type (`live:exposures-registered`).
    FieldPresentation.Register({ owner: taskManagerShape.exposure }),
  ],
} satisfies PluginDefinition;
