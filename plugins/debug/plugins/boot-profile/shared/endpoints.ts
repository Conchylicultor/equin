import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { BootTraceSchema } from "../core";

// Persist the current in-memory boot trace under a generated id, returning the
// id the "Copy permalink" URL is built from. POST so it never runs from a
// cache/prefetch — a write happens only on an explicit button click.
export const saveBootTrace = defineEndpoint({
  route: "POST /api/boot-traces",
  body: z.object({ snapshot: BootTraceSchema }),
  response: z.object({ id: z.string() }),
});
