import { defineRenderSlot } from "@plugins/primitives/plugins/slot-render/web";
import { defineItemActions } from "@plugins/primitives/plugins/data-view/web";
import type { TaskRow } from "@plugins/tasks/plugins/tasks-core/core";
import type { ComponentType } from "react";

export const Tasks = {
  // Over the task list's rows (`taskRows`' — exposed fields under `$columns`).
  TaskActions: defineItemActions<TaskRow>(),
  ListActions: defineRenderSlot<{
    component: ComponentType;
  }>({ docLabel: (p) => p.id }),
};
