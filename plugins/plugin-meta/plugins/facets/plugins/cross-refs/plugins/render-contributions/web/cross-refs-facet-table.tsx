import {
  defineFacetTable,
  type FacetTableEntry,
  PluginChip,
} from "@plugins/plugin-meta/plugins/contributions-table/web";
import type { ColumnDef } from "@plugins/primitives/plugins/data-table/web";
import type { PluginNode } from "@plugins/plugin-meta/plugins/plugin-view/core";
import {
  apiUseLabel,
  type CrossRefsData,
} from "@plugins/plugin-meta/plugins/facets/plugins/cross-refs/core";
import { RUNTIME_FOLDERS } from "@plugins/framework/plugins/plugin-id/core";

import { symbol } from "@plugins/ui/plugins/icons/core";

const callSplitIcon = symbol("call-split");

type CrossRefRow = {
  plugin: PluginNode;
  used: string;
  runtime: string;
};

const columns: ColumnDef<CrossRefRow>[] = [
  {
    id: "used",
    header: "Uses",
    width: "minmax(0,1fr)",
    value: (row) => row.used,
    cell: (row) => (
      <code className="truncate font-mono text-foreground">{row.used}</code>
    ),
  },
  {
    id: "runtime",
    header: "Runtime",
    value: (row) => row.runtime,
    cell: (row) => (
      <span className="font-mono text-muted-foreground">{row.runtime}</span>
    ),
  },
  {
    id: "plugin",
    header: "Plugin",
    value: (row) => row.plugin.id,
    cell: (row) => <PluginChip pluginId={row.plugin.id} />,
  },
];

function rows(entries: FacetTableEntry[]): CrossRefRow[] {
  const result: CrossRefRow[] = [];
  for (const entry of entries) {
    const data = entry.data as CrossRefsData;
    for (const runtime of RUNTIME_FOLDERS) {
      for (const u of data.apiUses[runtime]) {
        result.push({
          plugin: entry.node,
          used: apiUseLabel(u, runtime),
          runtime,
        });
      }
    }
  }
  return result;
}

export const crossRefsFacetTable = defineFacetTable<CrossRefRow>({
  facetId: "cross-refs",
  label: "Cross-refs",
  icon: callSplitIcon,
  columns,
  rows,
  rowKey: (r) => `${r.plugin.id}:${r.runtime}:${r.used}`,
});
