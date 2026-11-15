import { defineTraceEventClass } from "@plugins/debug/plugins/trace/plugins/engine/server";
import { StallSectionSchema } from "../../core";

// The stall class is TRIGGER-OWNED: unlike spans/gates (which read ambient
// in-memory state at the trip instant), the stack evidence is pre-aggregated by
// the health-monitor sampler — the raw JSC traces (thousands per freeze) are far
// too large to carry, and the drain must happen on the sampler's own tick to
// bound memory. So the sampler builds the StallSection and hands it in as
// `stallClass.supply(section)`. No captureAtTrip: the class reads no trigger
// kind, so a trace carries a stall section exactly when its producer supplied one.
export const stallClass = defineTraceEventClass({
  id: "stall",
  schema: StallSectionSchema,
});
