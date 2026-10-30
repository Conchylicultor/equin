import { useMemo } from "react";
import {
  useLive,
  FieldPresentation,
  type LiveFieldOption,
  type LiveFieldOptionsRead,
} from "@plugins/network/plugins/live/web";
import { mapResource } from "@plugins/primitives/plugins/live-state/web";
import { taskMandateShape } from "../../core";
import {
  mandateDefinitions,
  type MandateDefinitions,
} from "@plugins/tasks/plugins/orchestration/plugins/mandate/plugins/definitions/core";

// Stable (module-level), so the mapped read changes only with the registry.
function toOptions(
  definitions: MandateDefinitions,
): readonly LiveFieldOption[] {
  return definitions.map((d) => ({ value: d.id, label: d.label }));
}

/**
 * The `mandate` field's options: every named mandate the code defines, read
 * live (boot-hydrated). Loading until known — never raw-id sections that
 * relabel when it lands.
 */
function useMandateOptions(): LiveFieldOptionsRead {
  const definitions = useLive(mandateDefinitions);
  return useMemo(() => mapResource(definitions, toOptions), [definitions]);
}

/**
 * The exposed `mandate` field (tasks-core's `tasks_ext_mandate`: every task's
 * effective mandate) in every list whose rows reach a task, labelled by the
 * mandate definitions.
 */
export const mandatePresentation = FieldPresentation.Register({
  owner: taskMandateShape.exposure,
  fields: { mandateId: { useOptions: useMandateOptions } },
});
