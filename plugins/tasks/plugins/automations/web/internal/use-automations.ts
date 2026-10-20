import { useMemo } from "react";
import type { ConfigDescriptor } from "@plugins/config_v2/core";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  mapResource,
  type GateUnavailable,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import {
  automationsCatalog,
  type AutomationConfigFields,
  type AutomationEntry,
} from "../../core";
import { Automations } from "./slots";

/**
 * Every registered automation, as the server resolves it now — or
 * `unavailable` under an in-browser server (the catalog is the machine
 * half's), which every reader renders as the message it carries.
 */
export function useAutomations():
  ResourceResult<AutomationEntry[]> | GateUnavailable {
  return useLive(automationsCatalog);
}

/** One automation by id — `null` once the catalog is known and lacks it. */
export function useAutomation(
  automationId: string,
): ResourceResult<AutomationEntry | null> | GateUnavailable {
  const all = useAutomations();
  return useMemo(
    () =>
      mapResource(
        all,
        (list) => list.find((a) => a.id === automationId) ?? null,
      ),
    [all, automationId],
  );
}

/**
 * An automation's config document, as its plugin contributed it on the web
 * (`automationConfigContributions`) — `null` when no web plugin did, which the
 * pane shows as the wiring fault it is.
 */
export function useAutomationConfigDescriptor(
  automationId: string,
): ConfigDescriptor<AutomationConfigFields> | null {
  const configs = Automations.Config.useContributions();
  return (
    configs.find((c) => c.descriptor.name === automationId)?.descriptor ?? null
  );
}
