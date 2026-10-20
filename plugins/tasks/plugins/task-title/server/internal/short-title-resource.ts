import { serveCollection } from "@plugins/network/plugins/live/server";
import { taskShortTitles } from "../../core";
import { tasksShortTitle } from "./tables";

// Lookup-only collection served from the extension entity: the loader reads
// only the subscribed id set, and a write reaches only the tuples naming it.
export const taskShortTitlesServed = serveCollection(taskShortTitles, {
  from: tasksShortTitle,
});
