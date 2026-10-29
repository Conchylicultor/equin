import { z } from "zod";
import { blob, defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

// The two POST handlers accept a binary (image/png) request body via the
// blob() codec and return JSON; they are wrapped with implement() on the
// server. The stored image is read back through the `screenshot.image` live
// value (./image.ts), not an endpoint.
export const createScreenshot = defineEndpoint({
  route: "POST /api/screenshots/:id",
  unpredicted: {
    reason: "unobserved",
    why: "Uploads an image the editor already holds under its client-minted id; no live read shows it back.",
  },
  body: blob("image/png"),
  response: z.object({ id: z.string() }),
});

// Writes the screenshot to a file on the computer's disk, for an agent to read.
export const saveScreenshotFile = defineEndpoint({
  route: "POST /api/screenshots/:id/file",
  unpredicted: {
    reason: "response",
    why: "the caller hands the returned file path to the agent",
  },
  body: blob("image/png"),
  response: z.object({ path: z.string() }),
  needsMachine: { feature: "Attaching a screenshot to an agent" },
});
