import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { liveCollection } from "@plugins/network/plugins/live/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import { tasksEntityRef } from "./entity-refs";

/**
 * Every task's EFFECTIVE mandate: the id of the named mandate it runs under —
 * its own `mandate_ref`, else its nearest ancestor's (nearest wins) — and the
 * task it comes from (`sourceTaskId`: itself when it states one, so a reader
 * tells "set here" from "inherited"). One row
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
  fields: {
    mandateId: textField({ label: "Mandate" }),
    // The task whose own `mandate_ref` is in effect: the task itself when it
    // states one, else the ancestor it inherits from.
    sourceTaskId: textField({ label: "Mandate source" }),
  },
  exposes: {
    parent: tasksEntityRef,
    name: "mandate",
    fields: { mandateId: { as: "mandate" } },
  },
});

/**
 * One task's effective mandate, read by id (`useLive(taskMandates, { id })`):
 * the task detail's Mandate row. Lookup-only — a list reads the exposed
 * `mandate` field instead.
 */
export const taskMandates = liveCollection("task-mandates", {
  from: taskMandateShape,
  id: "taskId",
});
