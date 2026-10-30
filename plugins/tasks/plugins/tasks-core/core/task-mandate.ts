import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import { tasksEntityRef } from "./entity-refs";

/**
 * Every task's EFFECTIVE mandate: the id of the named mandate it runs under —
 * its own `mandate_ref`, else its nearest ancestor's (nearest wins). One row
 * per task in `tasks_ext_mandate`, kept exact by tasks-core in the same
 * transaction as every write that can move it (a task created, re-filed, or a
 * mandate stated or cleared — `refreshEffectiveMandates`).
 *
 * EXPOSED to every list whose rows reach a task as `mandate`, so a list
 * filters and groups by it ("Mandate is Supervisor"). Its options are the
 * registered mandates, read live (the mandate plugin presents the field).
 */
export const taskMandateShape = defineExtensionShape({
  key: "taskId",
  fields: { mandateId: textField({ label: "Mandate" }) },
  exposes: {
    parent: tasksEntityRef,
    name: "mandate",
    fields: { mandateId: { as: "mandate" } },
  },
});
