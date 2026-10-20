import { serveCollection } from "@plugins/network/plugins/live/server";
import { automationTasks, launchDecisions } from "../../core";
import { tasksLaunchDecision, tasksOrigin } from "./tables";

// The `automations.catalog` value is served by the machine half
// (machine/internal/catalog.ts): it is `needsMachine` while the automations it
// lists read their config, which an in-browser server does not have yet.

// Served from the extension handle: `taskId` is the `parent_id` PK, the
// projection is exactly the row schema. Filing a task is a window entry;
// a task's deletion cascades its row away (an exit).
export const automationTasksServed = serveCollection(automationTasks, {
  from: tasksOrigin,
});

// Served from the extension handle, like the origin rows: a decision is an
// entrant of the whole set, a changed one a one-row refill, a cleared one an
// exit.
export const launchDecisionsServed = serveCollection(launchDecisions, {
  from: tasksLaunchDecision,
});
