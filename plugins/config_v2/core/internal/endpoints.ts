import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

export const setConfigField = defineEndpoint({
  route: "POST /api/config-v2/set-field",
  agentReverted: true,
  body: z.object({
    storePath: z.string(),
    key: z.string(),
    value: z.unknown(),
    scopeId: z.string().optional(),
  }),
});

export const forkScope = defineEndpoint({
  route: "POST /api/config-v2/fork-scope",
  agentReverted: true,
  body: z.object({ scopeId: z.string() }),
});

export const deleteScope = defineEndpoint({
  route: "POST /api/config-v2/delete-scope",
  agentReverted: true,
  body: z.object({ scopeId: z.string() }),
});

// Per-descriptor scope primitives (single descriptor × scope), distinct from
// fork-scope/delete-scope which act over the whole `scope: "app"` set. Used by
// the settings detail pane to add / stop a per-app customization for one
// descriptor.
export const forkDescriptorScope = defineEndpoint({
  route: "POST /api/config-v2/fork-descriptor-scope",
  agentReverted: true,
  body: z.object({ storePath: z.string(), scopeId: z.string() }),
});

export const removeDescriptorScope = defineEndpoint({
  route: "POST /api/config-v2/remove-descriptor-scope",
  agentReverted: true,
  body: z.object({ storePath: z.string(), scopeId: z.string() }),
});
