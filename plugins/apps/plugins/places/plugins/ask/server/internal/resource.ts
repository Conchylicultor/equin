import { serveCollection } from "@plugins/network/plugins/live/server";
import { askCandidates } from "../../core";
import { askCandidateRows } from "./tables";

// Lookup-only, served from the extension handle: the loader reads only the
// subscribed conversations, and a search reaches only that run's readers.
export const askCandidatesServed = serveCollection(askCandidates, {
  from: askCandidateRows,
});
