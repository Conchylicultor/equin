import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { subjectTaskServed } from "./internal/resource";

export { tasksSubject } from "./internal/tables";
export {
  findSubjectTask,
  setTaskSubject,
  withSubjectLock,
} from "./internal/subject-task";

export default {
  description:
    "Owns the tasks_ext_subject side-table: the record a task is about (a failed build run, a job run — a caller-named kind and id), so a launch about a subject that already has a live task reuses it, and a surface reads that task back live by subject.",
  contributions: [...subjectTaskServed.declare],
} satisfies ServerPluginDefinition;
