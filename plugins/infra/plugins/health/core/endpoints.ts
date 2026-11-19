import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { HealthResponseSchema } from "./protocol";

// A deployed site's visitor reads it too: every page probes its own host
// through it (the wedge watchdog's reach gate and its restart split, the
// crash collector's fetch-no-answer gate). Owner-only, a visitor's page got
// 403 — a host that answers, but whose boot instant it could never read, so
// a stall held by a server restart was filed as a wedge of a running server.
// The body names only when this process started, its boot phase and which
// release it runs: nothing a visitor of the deployed site may not know.
export const getHealth = defineEndpoint({
  route: "GET /api/health",
  access: {
    visitor:
      "every page of a deployed site probes its own host through it (wedge watchdog, crash reports); the body is the boot instant, boot phase and release id",
  },
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
