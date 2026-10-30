import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { IdKinds } from "@plugins/ids/web";
import { FieldPresentation } from "@plugins/network/plugins/live/web";
import { taskManagerShape, watchEventIdKind, watchIdKind } from "../core";

export default {
  description:
    "Watch, web half: registers the watch and watch-event id kinds, so their ids are recognised in the browser as on the server; presents the exposed `managedBy` field (Agent / You — whether another task's agent watches the task) and `managerTaskId` (the watching agent's task, hidden by default) in every list whose rows reach a task.",
  contributions: [
    IdKinds.Kind({ kind: watchIdKind }),
    IdKinds.Kind({ kind: watchEventIdKind }),
    // The exposed `managedBy` field (Agent / You) in every list whose rows
    // reach a task, presented by its type (`live:exposures-registered`); and
    // `managerTaskId`, the manager's task — a dimension a list nests by
    // (`attach`), left out of the body by default.
    FieldPresentation.Register({
      owner: taskManagerShape.exposure,
      fields: { managerTaskId: { visible: false } },
    }),
  ],
} satisfies PluginDefinition;
