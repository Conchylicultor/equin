import { z } from "zod";
import { blob, defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

// The two POST handlers accept a binary (image/png) request body via the
// blob() codec and return JSON; they are wrapped with implement() on the
// server. The GET handler stays raw — it emits custom binary-response headers
// (content-type + cache-control) that a bare blob() encodeResponse would not
// reproduce — so its response: blob() codec is consumed only by the client.
export const createScreenshot = defineEndpoint({
  route: "POST /api/screenshots/:id",
  body: blob("image/png"),
  response: z.object({ id: z.string() }),
});

export const getScreenshot = defineEndpoint({
  route: "GET /api/screenshots/:id",
  response: blob(),
});

// Writes the screenshot to a file on the computer's disk, for an agent to read.
export const saveScreenshotFile = defineEndpoint({
  route: "POST /api/screenshots/:id/file",
  body: blob("image/png"),
  response: z.object({ path: z.string() }),
  needsMachine: { feature: "Attaching a screenshot to an agent" },
});
