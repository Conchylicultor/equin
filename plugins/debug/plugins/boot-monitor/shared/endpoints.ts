import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { BootGatewaySchema } from "@plugins/debug/plugins/trace/plugins/boot/core";

// The gateway's post-readiness boot report: after the proxy swap, the gateway
// POSTs its observed spawn/readiness stamps here (fire-and-forget over the unix
// socket — the same transport as its /api/health/ready polls, so this carries
// the same trust surface and needs no auth). The body IS the section's gateway
// shape (single source in trace/boot core): every field optional and unknown
// keys stripped, so a gateway/backend version skew in either direction can
// never fail the report or the section.
export const gatewayReport = defineEndpoint({
  route: "POST /api/boot/gateway-report",
  internal: {
    why: "the gateway process posts its boot report; no browser client",
  },
  body: BootGatewaySchema,
  response: z.object({ ok: z.literal(true) }),
});
