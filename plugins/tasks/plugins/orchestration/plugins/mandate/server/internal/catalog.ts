import { serveValue } from "@plugins/network/plugins/live/server";
import { capabilityCatalog } from "../../core";
import { capabilityEntries } from "./contribution";

/** The capability catalog, served. Contributions only register at boot, so it
 * is fixed for the process. */
export const capabilityCatalogServed = serveValue(capabilityCatalog, {
  source: "external",
  changes: {
    fixed: { reason: "Mandate.Capability contributions register only at boot" },
  },
  loader: async () => ({
    capabilities: [...capabilityEntries().values()]
      .map((e) => ({ id: e.cap.id, label: e.cap.label }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  }),
});
