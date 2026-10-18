import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { DataViewSlots } from "@plugins/primitives/plugins/data-view/web";
import { TagsCell } from "./components/tags-cell";

export default {
  description:
    "Tags (multi-value) field type: data-view table cell (read-only tag chips).",
  contributions: [
    DataViewSlots.Cell({
      match: "tags",
      companion: true,
      component: TagsCell,
      // This type presents as a chip, so the list's subtitle run separates it by
      // spacing rather than stringing it on a middot.
      chip: true,
    }),
  ],
} satisfies PluginDefinition;
