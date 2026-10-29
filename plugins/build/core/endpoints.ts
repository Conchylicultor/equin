import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

// Both are desktop-only: a build spawns `./equin build` in this checkout,
// so they are served by `build/machine` and answered "not available" by a host
// without the computer (the in-browser demo).
export const triggerBuildEndpoint = defineEndpoint({
  route: "POST /api/build",
  unpredicted: {
    reason: "server-decided",
    why: "runs ./equin build on the machine; the popover shows the build's own progress and result",
  },
  needsMachine: { feature: "Building the app" },
});

export const serveCompositionEndpoint = defineEndpoint({
  route: "POST /api/build/serve",
  unpredicted: {
    reason: "server-decided",
    why: "builds and serves a composition on the machine, long-running, outcome unknown from the request",
  },
  body: z.object({ composition: z.string() }),
  needsMachine: { feature: "Serving a composition" },
});
