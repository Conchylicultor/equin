import { MandateDefinitions } from "@plugins/tasks/plugins/orchestration/plugins/mandate/plugins/definitions/server";
import { registeredAutomations } from "./registry";
import { automationSettings } from "./settings";

/**
 * Every registered automation's named mandate (`automation:<id>`): it grants
 * the automation's `spec.mandate` of its CURRENT settings, so a change in its
 * config (its Push setting) reaches every tree it filed or launched.
 */
export const automationMandates = MandateDefinitions.Source({
  id: "automations",
  definitions: () =>
    registeredAutomations().map((a) => ({
      mandate: a.mandate,
      policy: () => a.spec.mandate(automationSettings(a.spec)),
    })),
});
