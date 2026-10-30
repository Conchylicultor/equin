import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { EmissionsPayloadSchema, TriggersPayloadSchema } from "./resources";

export const listEmissions = defineEndpoint({
  route: "GET /api/events/emissions",
  response: EmissionsPayloadSchema,
});

export const listTriggers = defineEndpoint({
  route: "GET /api/events/triggers",
  response: TriggersPayloadSchema,
});

export const deleteTriggerEndpoint = defineEndpoint({
  route: "DELETE /api/events/triggers/:id",
});

export const patchTriggerBodySchema = z.object({
  enabled: z.boolean(),
});
export type PatchTriggerBody = z.infer<typeof patchTriggerBodySchema>;

export const patchTriggerEndpoint = defineEndpoint({
  route: "PATCH /api/events/triggers/:id",
  body: patchTriggerBodySchema,
});
