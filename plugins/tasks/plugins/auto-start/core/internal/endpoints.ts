import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { removeRow, upsertRow } from "@plugins/network/plugins/live/core";
import { ModelChoiceSchema } from "@plugins/conversations/plugins/model-provider/core";
import { taskAutoStart } from "./resources";

export const SetAutoStartBodySchema = z.object({
  model: ModelChoiceSchema,
});
export type SetAutoStartBody = z.infer<typeof SetAutoStartBodySchema>;

export const setTaskAutoStart = defineEndpoint({
  route: "POST /api/tasks/:id/auto-start",
  body: SetAutoStartBodySchema,
  // The marker row may be absent (not armed): an upsert. The picker is
  // disabled while an open attempt exists (the server's 409) and offers only
  // launchable models, so a refusal is the exception: never-revert toasts it.
  // The arming's side effects (dependency triggers, the launch job) are the
  // server's.
  effect: (on) =>
    upsertRow(
      on,
      taskAutoStart,
      ({ params }) => params.id,
      (row, { params, body }) => ({
        taskId: params.id,
        ...row,
        autoStartAt: row?.autoStartAt ?? new Date(),
        autoStartModel: body.model,
      }),
      { set: ({ body }) => ({ autoStartModel: body.model }) },
    ),
});

export const clearTaskAutoStart = defineEndpoint({
  route: "DELETE /api/tasks/:id/auto-start",
  effect: (on) => removeRow(on, taskAutoStart, ({ params }) => params.id),
});
