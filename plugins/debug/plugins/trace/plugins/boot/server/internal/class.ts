import { defineTraceEventClass } from "@plugins/debug/plugins/trace/plugins/engine/server";
import { BootSectionSchema } from "../../core";

// The boot class is TRIGGER-OWNED (the stall precedent): unlike spans/gates
// (which read ambient in-memory state at the trip instant), the boot profile is
// pre-aggregated by debug/boot-monitor — the mint happens on a minute tick long
// after boot completed, so there is no live instant to capture. The producer
// builds the BootSection from getProfilingData() (+ the gateway report box) and
// hands it in as `bootClass.supply(section)`. There is no captureAtTrip: the
// class reads no trigger kind — "boot" is also the kind of the client's
// in-browser host boot slow-op, whose detail it once took for a BootSection —
// so a trace carries a boot section exactly when its producer supplied one.
export const bootClass = defineTraceEventClass({
  id: "boot",
  schema: BootSectionSchema,
});
