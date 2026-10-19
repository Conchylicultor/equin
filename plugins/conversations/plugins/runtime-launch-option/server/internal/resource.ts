import { serveCollection } from "@plugins/network/plugins/live/server";
import { taskRuntimes } from "../../shared/schemas";
import { tasksRuntime } from "./tables";

// The lookup-only per-task read, served from the extension entity.
export const taskRuntimesServed = serveCollection(taskRuntimes, {
  from: tasksRuntime,
});
