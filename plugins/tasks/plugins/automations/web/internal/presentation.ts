import { useMemo } from "react";
import { NULL_OPTION_KEY } from "@plugins/fields/core";
import {
  FieldPresentation,
  type LiveFieldOption,
  type LiveFieldOptionsRead,
} from "@plugins/network/plugins/live/web";
import { mapResource } from "@plugins/primitives/plugins/live-state/web";
import { taskOriginShape, type AutomationEntry } from "../../core";
import { useAutomations } from "./use-automations";

/** A task no automation filed reads NULL: the option spelled "null". */
const BY_HAND: LiveFieldOption = {
  value: NULL_OPTION_KEY,
  label: "By hand",
  hint: "Filed by a person, not an automation",
  // The unremarkable default: a filter chip and a group section, but no chip
  // on every hand-filed row.
  quiet: true,
};

// Stable (module-level), so the mapped read changes only with the catalog.
function toOptions(
  automations: readonly AutomationEntry[],
): readonly LiveFieldOption[] {
  return [
    ...automations.map((a): LiveFieldOption => ({
      value: a.id,
      label: a.label,
      variant: "info",
      hint: "Filed by an automation",
    })),
    BY_HAND,
  ];
}

/**
 * The `origin` field's options: the LIVE automations catalog, each an info
 * chip, then "By hand" — a task no automation filed reads NULL: a quiet
 * option (no chip in the cell), its filter option and (last) group section. Loading until the catalog is
 * known: never a raw id.
 */
export function useOriginOptions(): LiveFieldOptionsRead {
  const automations = useAutomations();
  return useMemo(
    () =>
      // No catalog on this host (an in-browser server: it is the machine
      // half's). "By hand" is the NULL value's label whatever the catalog
      // holds, so it is still true; no automation option is offered, since
      // none can be named.
      automations.status === "unavailable"
        ? BY_HAND_ONLY
        : mapResource(automations, toOptions),
    [automations],
  );
}

const BY_HAND_ONLY: readonly LiveFieldOption[] = [BY_HAND];

/**
 * The exposed `origin` field (the automation that filed or launched a task)
 * of every list whose rows reach a task — the task list.
 */
export const originPresentation = FieldPresentation.Register({
  owner: taskOriginShape.exposure,
  fields: { automationId: { useOptions: useOriginOptions } },
});
