import { serveCollection } from "@plugins/network/plugins/live/server";
import { launchDecisions } from "../../core";
import { tasksLaunchDecision } from "./tables";

// The `automations.catalog` value and the `automations.tasks` history are
// served by the machine half (machine/internal/catalog.ts, history.ts): both
// are `needsMachine` — the automations are the computer's.

// Served from the extension handle, like the origin rows: a decision is an
// entrant of the whole set, a changed one a one-row refill, a cleared one an
// exit.
export const launchDecisionsServed = serveCollection(launchDecisions, {
  from: tasksLaunchDecision,
});
