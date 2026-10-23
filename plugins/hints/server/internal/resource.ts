import { serveCollection } from "@plugins/network/plugins/live/server";
import { hintsSeen } from "../../core";
import { hintSeenEntity } from "./tables";

// Every row field binds to its `_hintSeen` column by name. The window is
// bounded by its declared limit; the table by the set of declared hints.
export const hintsSeenServed = serveCollection(hintsSeen, {
  from: hintSeenEntity,
});
