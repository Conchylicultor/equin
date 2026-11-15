import { defineTraceEventClass } from "@plugins/debug/plugins/trace/plugins/engine/server";
import { ClientBootSectionSchema } from "../../core";

// The client-boot class is TRIGGER-OWNED (the stall precedent): the browser
// builds the section itself — `toClientBootSection(getBootTrace())` in the
// slow-op collector — and it rides the page-load beacon's `clientBoot` field;
// handle-client-slow-op hands it in as `clientBootClass.supply(section)`. The
// server has no ambient client state to read at the trip instant, so there is
// no captureAtTrip: an item without a `clientBoot` (an older client, any
// non-page-load signal) supplies nothing and the section is omitted — never faked.
export const clientBootClass = defineTraceEventClass({
  id: "client-boot",
  schema: ClientBootSectionSchema,
});
