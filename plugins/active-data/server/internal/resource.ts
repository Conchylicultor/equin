import { serveCollection } from "@plugins/network/plugins/live/server";
import { activeDataBindings } from "../../core";
import { activeDataBindingsEntity } from "./tables";

// One scoped tuple per conversation, compiled from the table (query-resource's
// `compileAllCollection`): a PUT / DELETE of a binding in another conversation
// reaches no tuple; one in this conversation is a one-row refill. The routes
// notify nothing — the change feed carries the write.
export const activeDataBindingsServed = serveCollection(activeDataBindings, {
  from: activeDataBindingsEntity,
});
