import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { DataViewSlots } from "@plugins/primitives/plugins/data-view/web";
import { IdentifierCell } from "./components/identifier-cell";

export default {
  description:
    "Identifier field type: data-view table cell (monospace, truncated, the full value in a tooltip, a hover-revealed copy button).",
  contributions: [
    DataViewSlots.Cell({
      match: "identifier",
      companion: true,
      component: IdentifierCell,
    }),
  ],
} satisfies PluginDefinition;
