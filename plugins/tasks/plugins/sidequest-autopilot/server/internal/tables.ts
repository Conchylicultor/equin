import { _tasks } from "@plugins/tasks/plugins/tasks-core/server";
import { defineExtension } from "@plugins/infra/plugins/entity-extensions/server";
import { sidequestTriageShape } from "../../shared/triage";

// What triage made of each sidequest (see the shape): one row per task, the
// latest read winning; a task's deletion cascades it away.
export const tasksSidequestTriage = defineExtension(
  _tasks,
  "sidequest_triage",
  sidequestTriageShape,
);
// Re-exported so drizzle-kit discovers the underlying pgTable.
export const _tasksSidequestTriageExt = tasksSidequestTriage.table;
