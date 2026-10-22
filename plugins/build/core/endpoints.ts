import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

// Both are desktop-only: a build spawns `./singularity build` in this checkout,
// so they are served by `build/machine` and answered "not available" by a host
// without the computer (the in-browser demo).
export const triggerBuildEndpoint = defineEndpoint({
  route: "POST /api/build",
  needsMachine: { feature: "Building the app" },
});

export const serveCompositionEndpoint = defineEndpoint({
  route: "POST /api/build/serve",
  body: z.object({ composition: z.string() }),
  needsMachine: { feature: "Serving a composition" },
});
