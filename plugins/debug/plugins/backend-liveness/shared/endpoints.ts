import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

/** The longest freeze the trigger will cause. */
export const MAX_FREEZE_SECONDS = 600;

// Reproduction trigger: blocks THIS backend's JS thread for `seconds`, right
// after answering — the way a sync call behind a macOS permission prompt froze
// main on 2026-10-11 — so the outside liveness probe can be seen to report it.
// Refused on main.
export const freezeBackend = defineEndpoint({
  route: "POST /api/debug/backend-liveness/freeze",
  internal: {
    why: "reproduction trigger for the frozen-backend report, hit by hand or script; no browser client",
  },
  body: z.object({
    seconds: z.number().int().min(1).max(MAX_FREEZE_SECONDS),
  }),
  response: z.object({ pid: z.number(), freezesAtMs: z.number() }),
});
