import { captureFlightWindow } from "@plugins/infra/plugins/runtime-profiler/core";
import { implement } from "@plugins/infra/plugins/endpoints/server";
import { getFlightWindow } from "../../core";

export const handleFlightWindow = implement(getFlightWindow, ({ query }) => {
  const windowMs = query.windowMs;
  // Both anchor halves are read back-to-back so they name the same instant on
  // the two clocks; every t0/t1 in the window converts through this pair (see
  // flightWindowResponseSchema).
  const atMs = performance.now();
  const wallTime = new Date().toISOString();
  return {
    wallAnchor: { atMs, wallTime },
    window: captureFlightWindow({
      windowStartMs: atMs - windowMs,
      maxOpen: 100,
      maxCompleted: 200,
    }),
  };
});
