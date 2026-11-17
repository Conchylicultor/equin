import { z } from "zod";
import { blob, defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

// Writes the screenshot to a file on the computer's disk, for an agent to read.
export const saveScreenshotFile = defineEndpoint({
  route: "POST /api/screenshots/:id/file",
  body: blob("image/png"),
  response: z.object({ path: z.string() }),
  needsMachine: { feature: "Attaching a screenshot to an agent" },
});
