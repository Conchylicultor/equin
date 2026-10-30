import { serveValue } from "@plugins/network/plugins/live/server";
import { mandateDefinitions } from "../../core";
import { mandateDefinitionEntries } from "./contribution";

/** The defined mandates, served. Contributions (and the sources' families)
 * register at boot, so it is fixed for the process. */
export const mandateDefinitionsServed = serveValue(mandateDefinitions, {
  source: "external",
  changes: {
    fixed: {
      reason:
        "MandateDefinitions contributions and sources register only at boot",
    },
  },
  loader: async () =>
    [...mandateDefinitionEntries().values()]
      .map((d) => ({ id: d.mandate.id, label: d.mandate.label }))
      .sort((a, b) => a.label.localeCompare(b.label)),
});
