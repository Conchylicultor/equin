import { z } from "zod";
import {
  readGateGauges,
  type GateGauge,
} from "@plugins/infra/plugins/runtime-profiler/core";
import { defineTraceEventClass } from "@plugins/debug/plugins/trace/plugins/engine/server";
import { cappedList } from "@plugins/packages/plugins/list-bound/core";

// How many holders one gate's capture keeps: every read-admission slot, and
// the longest-held head of a wider gate.
const HOLDERS_MAX = 8;

// Zod mirror of a point-in-time gate gauge, pinned to the profiler's GateGauge
// by the assertion below. `readGateGauges()` keys by the profiler's wait layer name,
// so this section joins directly to each span's `waits`.
const GateGaugeSchema = z.object({
  active: z.number(),
  queued: z.number(),
  max: z.number(),
  // Who holds the gate, when its owner names them (longest-held first).
  holders: cappedList(z.object({ label: z.string(), heldMs: z.number() }), {
    max: HOLDERS_MAX,
  }).optional(),
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
  captureAtTrip: () =>
    Object.fromEntries(
      Object.entries(readGateGauges()).map(([layer, g]) => [
        layer,
        g.holders === undefined
          ? g
          : { ...g, holders: g.holders.slice(0, HOLDERS_MAX) },
      ]),
    ),
});
