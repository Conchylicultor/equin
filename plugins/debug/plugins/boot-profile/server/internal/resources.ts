import { serveCollection } from "@plugins/network/plugins/live/server";
import { bootTrace, bootTraces } from "../../core";
import { _bootTraces } from "./tables";

// Both read `boot_traces` through the change feed: a save (the only insert) or
// the retention sweep's delete reaches every subscribed window and lookup. Each
// row field binds to its column by name; the list's row has no `snapshot`, so
// the window never projects the blob.
export const bootTracesServed = serveCollection(bootTraces, {
  from: _bootTraces,
});

export const bootTraceServed = serveCollection(bootTrace, {
  from: _bootTraces,
});
