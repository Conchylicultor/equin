import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

/**
 * Restore ONE field to what the repo commits — the propagated git layer (the
 * generated origin ⊕ any committed authored override), not `descriptor.defaults`.
 * Deletes the whole override document when the reset leaves it saying nothing the
 * origin doesn't already say. The whole-config twin is `deleteOverride`.
 */
export const resetConfigField = defineEndpoint({
  route: "POST /api/config-v2/reset-field",
  body: z.object({
    storePath: z.string(),
    key: z.string(),
    scopeId: z.string().optional(),
  }),
});

export const acknowledgeConflict = defineEndpoint({
  route: "POST /api/config-v2/acknowledge-conflict",
  body: z.object({ storePath: z.string(), scopeId: z.string().optional() }),
});

export const deleteOverride = defineEndpoint({
  route: "POST /api/config-v2/delete-override",
  body: z.object({ storePath: z.string(), scopeId: z.string().optional() }),
});

// Three-way merge resolution for a hash conflict. Auto-merges fields only one
// side changed; returns the fields both sides changed differently (true
// conflicts) in `conflictKeys`. `resolved` is true when nothing truly conflicted
// and the conflict is fully cleared.
export const mergeConflict = defineEndpoint({
  route: "POST /api/config-v2/merge-conflict",
  body: z.object({ storePath: z.string(), scopeId: z.string().optional() }),
  response: z.object({
    resolved: z.boolean(),
    conflictKeys: z.array(z.string()),
  }),
});
