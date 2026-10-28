import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";

/**
 * Every capability a plugin contributed (`Mandate.Capability`), with the
 * plugin that declared it — what Debug → Mandates lists. Fixed for the
 * process: contributions only register at boot.
 */
export const CapabilityCatalogSchema = z.object({
  capabilities: wholeList(
    z.object({
      id: z.string(),
      label: z.string(),
    }),
    {
      reason:
        "every capability the code contributes — fixed for the process, a handful",
    },
  ),
});
export type CapabilityCatalog = z.infer<typeof CapabilityCatalogSchema>;

export const capabilityCatalog = liveValue("mandate.capabilities", {
  schema: CapabilityCatalogSchema,
});
