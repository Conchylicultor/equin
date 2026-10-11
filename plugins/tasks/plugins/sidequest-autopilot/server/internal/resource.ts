import { serveCollection } from "@plugins/network/plugins/live/server";
import { sidequestTriageRows } from "../../shared/triage";
import { tasksSidequestTriage } from "./tables";

// Served from the extension handle: a triage read is a window entry, a task's
// deletion cascades its row away (an exit).
export const sidequestTriageServed = serveCollection(sidequestTriageRows, {
  from: tasksSidequestTriage,
});
