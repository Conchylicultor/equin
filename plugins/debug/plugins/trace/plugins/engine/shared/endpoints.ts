import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

// Verification endpoint: runs a REAL entry span (so the flight window has
// content), then captures a trace from a synthetic trigger — exercising
// admission → coherent-instant capture → enrich → persist end-to-end from one
// POST. Returns the minted trace id (null when admission rejected it).
export const testTrigger = defineEndpoint({
  route: "POST /api/debug/trace/test-trigger",
  body: z.object({ ms: z.number(), label: z.string().optional() }),
  response: z.object({ ok: z.boolean(), id: z.string().nullable() }),
});
