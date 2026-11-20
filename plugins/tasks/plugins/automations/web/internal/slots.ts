import type { ComponentType } from "react";
import type { ConfigDescriptor } from "@plugins/config_v2/core";
import { ConfigV2 } from "@plugins/config_v2/web";
import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";
import { defineRenderSlot } from "@plugins/primitives/plugins/slot-render/web";
import {
  AUTOMATIONS_CONFIG_PLUGIN_ID,
  type AutomationConfigFields,
} from "../../core";

export const Automations = {
  /**
   * An automation's config document, so the detail pane can read and write
   * it by automation id. Contributed through `automationConfigContributions`,
   * never by hand.
   */
  Config: defineSlot<{ descriptor: ConfigDescriptor<AutomationConfigFields> }>({
    docLabel: (c) => c.descriptor.name,
    // Each entry is a config descriptor: settings have their own declared
    // form and build readers, so not list entries of the catalog.
    catalog: {
      omitted: "each entry is an automation's config descriptor (settings)",
    },
  }),
  /**
   * A section of one automation's detail pane, for the settings only it has
   * (which reports an investigation covers, …). Rendered after the Trigger
   * section of the automation named by `automationId`.
   */
  Section: defineRenderSlot<{
    automationId: string;
    component: ComponentType;
  }>({ docLabel: (c) => c.automationId }),
  /**
   * More about one task an automation filed or started, shown when its row in
   * the automation's History is expanded (e.g. the report its agent left).
   * Every contribution renders for every expanded row, in slot order; one with
   * nothing to say about that task renders nothing. The registry names none of
   * them.
   */
  TaskDetail: defineRenderSlot<{
    component: ComponentType<{ taskId: string; automationId: string }>;
  }>(),
};

/**
 * The web contributions of an automation's config document: its config
 * registration (stored under `tasks/automations`, paired with the server's
 * `automationConfigRegistration`) and the entry the Automations pane finds it
 * by. Spread into the declaring plugin's web `contributions`.
 */
export function automationConfigContributions<F extends AutomationConfigFields>(
  descriptor: ConfigDescriptor<F>,
) {
  return [
    ConfigV2.WebRegister({
      descriptor,
      pluginId: AUTOMATIONS_CONFIG_PLUGIN_ID,
    }),
    Automations.Config({ descriptor }),
  ];
}
