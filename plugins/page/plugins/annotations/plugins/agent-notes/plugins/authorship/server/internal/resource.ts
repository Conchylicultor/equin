import { serveCollection } from "@plugins/network/plugins/live/server";
import { agentNotesAuthors } from "../../shared/schemas";
import { agentNotesAuthorsEntity } from "./tables";

// Server half of the per-card authorship read: one scoped tuple per card,
// compiled from the table (query-resource's `compileAllCollection`) — its
// routes and SQL from one declaration. A stamp on another card reaches no
// tuple; a stamp on this one is a one-row refill.
export const agentNotesAuthorsServed = serveCollection(agentNotesAuthors, {
  from: agentNotesAuthorsEntity,
});
