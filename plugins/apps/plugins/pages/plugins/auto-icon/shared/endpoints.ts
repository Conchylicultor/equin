import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

// Re-pick a page's emoji icon now, overwriting whatever it has (the picker's
// Regenerate). The pick runs INSIDE the request (one Haiku call, a few seconds),
// so the caller's pending state is exactly its lifetime: it ends on success, on
// failure, and on an answer that happens to equal the current icon alike. The new
// icon also arrives through the page's live row. Served by the machine half.
export const regeneratePageIcon = defineEndpoint({
  route: "POST /api/pages/:pageId/auto-icon/regenerate",
  response: z.object({ emoji: z.string() }),
  // One Haiku call: seconds by design, not a slow operation.
  slowThresholdMs: 45_000,
  // The pick is a Haiku call through the computer's Claude CLI: on a host
  // without the computer (the demo) the Regenerate row renders disabled.
  needsMachine: { feature: "Picking a page icon" },
  unpredicted: {
    reason: "server-decided",
    why: "a Haiku call picks the emoji; the Regenerate row spins until it answers",
  },
});
