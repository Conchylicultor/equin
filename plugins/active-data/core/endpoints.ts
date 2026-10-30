import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

export const putBindingBodySchema = z.object({
  payload: z.unknown(),
});
export type PutBindingBody = z.infer<typeof putBindingBodySchema>;

export const putBinding = defineEndpoint({
  route: "PUT /api/active-data/bindings/:conversationId/:messageId/:tag/:occurrenceIndex",
  body: putBindingBodySchema,
});

export const deleteBinding = defineEndpoint({
  route:
    "DELETE /api/active-data/bindings/:conversationId/:messageId/:tag/:occurrenceIndex",
});
