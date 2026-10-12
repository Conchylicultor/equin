import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import {
  Contributions,
  defineRowActivation,
} from "@plugins/plugin-meta/plugins/contributions-table/web";
import type { DbSchemaTableRow } from "@plugins/plugin-meta/plugins/facets/plugins/db-schema/core";
import { tableDetailPane } from "./panes";
import { TableDetail } from "./slots";

export { TableDetail } from "./slots";
export { tableDetailPane } from "./panes";

export default {
  description:
    "Per-table detail pane (with an extensible section slot) opened from the Contributions Tables tab.",
  contributions: [
    Pane.Register({ pane: tableDetailPane }),
    // The db-schema Tables tab lists rows (meta); clicking one opens this app's
    // live-SQL detail pane. Keyed by facetId so the meta renderer stays pane-blind.
    Contributions.RowActivation(
      defineRowActivation<DbSchemaTableRow>({
        facetId: "db-schema",
        rowActivation: (row, { openPane }) =>
          openPane.to(
            tableDetailPane,
            { tableName: row.name, pluginId: row.pluginId },
            { mode: "push" },
          ),
      }),
    ),
  ],
  slots: { ...TableDetail, "table-detail": tableDetailPane },
} satisfies PluginDefinition;
