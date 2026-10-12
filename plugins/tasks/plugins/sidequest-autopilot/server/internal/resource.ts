import { serveCollection } from "@plugins/network/plugins/live/server";
import { sidequestTriageRows } from "../../shared/triage";
import { tasksSidequestTriage } from "./tables";

// Served from the extension handle: a first triage read is an entrant of the
// whole set, a re-triage a one-row refill, and a task's deletion cascades its
// row away (an exit).
export const sidequestTriageServed = serveCollection(sidequestTriageRows, {
  from: tasksSidequestTriage,
});
