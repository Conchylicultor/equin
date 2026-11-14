import { HttpError } from "@plugins/infra/plugins/endpoints/server";
import { implementMachine } from "@plugins/infra/plugins/endpoints/machine";
import { getSupervisorRole } from "@plugins/tasks/plugins/supervisor-roles/server";
import { flushRoleEvents as flushRoleEventsEndpoint } from "../../core";
import { flushRoleEvents } from "./deliver";

export const handleFlushRoleEvents = implementMachine(
  flushRoleEventsEndpoint,
  async ({ params }) => {
    if (!(await getSupervisorRole(params.id)))
      throw new HttpError(404, `No supervisor role "${params.id}".`);
    await flushRoleEvents(params.id, "now");
  },
);
