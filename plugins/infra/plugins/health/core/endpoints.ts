import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { HealthResponseSchema } from "./protocol";

export const getHealth = defineEndpoint({
  route: "GET /api/health",
  response: HealthResponseSchema,
});

// Readiness probe: 200 only once the `onReadyBlocking` barrier has completed
// (migrations applied, DB warm, registry built); 503 while still booting. The
// gateway polls this to gate its hot-swap, so it never swaps to a half-booted
// backend. The 200 body is required: the gateway treats only 200 (or 404 on old
// backends) as ready — a 204 would read as "still booting" and time out.
export const getHealthReady = defineEndpoint({
  route: "GET /api/health/ready",
  response: z.object({ ready: z.literal(true) }),
});
