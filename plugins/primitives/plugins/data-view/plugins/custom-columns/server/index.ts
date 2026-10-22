import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import {
  customColumnDefsServed,
  customColumnsScoped,
  watchScopedDefinitions,
} from "./internal/scoped-columns";
import { IdKinds } from "@plugins/ids/server";
import { customColumnIdKind } from "../core";

export default {
  portable: true,
  description:
    "Custom-column DEFINITIONS on the server: the per-surface definitions read from config (data-view-custom-column-defs) and the `custom` scoped column set a live collection sorts and filters by, joining the values child's table. The values themselves (table, live value, endpoints) are the portable custom-columns/values child's.",
  contributions: [
    IdKinds.Kind({ kind: customColumnIdKind }),
    ...customColumnDefsServed.declare,
    customColumnsScoped,
  ],
  // The surfaces a live collection is scoped to were collected at bind; the
  // config registry is up by now.
  onReady() {
    watchScopedDefinitions();
  },
} satisfies ServerPluginDefinition;
