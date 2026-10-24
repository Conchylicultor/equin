import { serveCollection } from "@plugins/network/plugins/live/server";
import { prototypeStates, prototypeTags } from "../../core";
import { _prototypeState, _prototypeTags } from "./tables";

// Both collections are their tables whole (`all` sets): the change feed routes
// each write — a state change, a tag edit, a tag delete's carrier rewrite.
export const prototypeStatesServed = serveCollection(prototypeStates, {
  from: _prototypeState,
});

export const prototypeTagsServed = serveCollection(prototypeTags, {
  from: _prototypeTags,
});
