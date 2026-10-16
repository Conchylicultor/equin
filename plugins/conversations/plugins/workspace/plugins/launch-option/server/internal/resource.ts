import { serveCollection } from "@plugins/network/plugins/live/server";
import { taskWorkspaces } from "../../shared/schemas";
import { tasksWorkspace } from "./tables";

// The lookup-only per-task read, served from the extension entity.
export const taskWorkspacesServed = serveCollection(taskWorkspaces, {
  from: tasksWorkspace,
});
