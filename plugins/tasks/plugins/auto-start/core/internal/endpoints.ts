import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { ModelChoiceSchema } from "@plugins/conversations/plugins/model-provider/core";

export const SetAutoStartBodySchema = z.object({
  model: ModelChoiceSchema,
});
export type SetAutoStartBody = z.infer<typeof SetAutoStartBodySchema>;

export const setTaskAutoStart = defineEndpoint({
  route: "POST /api/tasks/:id/auto-start",
  body: SetAutoStartBodySchema,
});

export const clearTaskAutoStart = defineEndpoint({
  route: "DELETE /api/tasks/:id/auto-start",
});
