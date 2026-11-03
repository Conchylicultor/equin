import { HttpError, implement } from "@plugins/infra/plugins/endpoints/server";
import { setMandate } from "@plugins/tasks/plugins/tasks-core/server";
import { mandateDefinitionEntries } from "@plugins/tasks/plugins/orchestration/plugins/mandate/plugins/definitions/server";
import { putTaskMandate } from "../../core";

export const handlePutTaskMandate = implement(
  putTaskMandate,
  async ({ params, body }) => {
    const entry = mandateDefinitionEntries().get(body.mandateId);
    if (!entry) {
      throw new HttpError(400, `No mandate "${body.mandateId}" is defined.`);
    }
    await setMandate(params.taskId, entry.mandate);
  },
);
