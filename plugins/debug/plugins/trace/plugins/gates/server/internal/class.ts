import { z } from "zod";
import {
  readGateGauges,
  type GateGauge,
} from "@plugins/infra/plugins/runtime-profiler/core";
import { defineTraceEventClass } from "@plugins/debug/plugins/trace/plugins/engine/server";

// Zod mirror of a point-in-time gate gauge, pinned to the profiler's GateGauge
// by the assertion below. `readGateGauges()` keys by the chargeWait layer name,
// so this section joins directly to each span's `waits`.
const GateGaugeSchema = z.object({
  active: z.number(),
  queued: z.number(),
  max: z.number(),
});
const _assertGateGauge: GateGauge = {} as z.infer<typeof GateGaugeSchema>;
void _assertGateGauge;

const GatesSchema = z.record(z.string(), GateGaugeSchema);

// The gates class: gate occupancy at the trip instant (no enrich, no ring), so
// saturation joins the same instant as the spans. Persisted under
// snapshot.events.gates.
export const gatesClass = defineTraceEventClass({
  id: "gates",
  schema: GatesSchema,
  captureAtTrip: () => readGateGauges(),
});
