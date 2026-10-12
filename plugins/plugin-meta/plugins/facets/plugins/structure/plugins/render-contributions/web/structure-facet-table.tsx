import {
  defineFacetTable,
  defineRowActivation,
  type FacetTableEntry,
  PluginChip,
} from "@plugins/plugin-meta/plugins/contributions-table/web";
import type { ColumnDef } from "@plugins/primitives/plugins/data-table/web";
import type { PluginNode } from "@plugins/plugin-meta/plugins/plugin-view/core";
import { pluginViewPane } from "@plugins/plugin-meta/plugins/plugin-view/web";
import type { StructureFacetData } from "@plugins/plugin-meta/plugins/facets/plugins/structure/core";

import { symbol } from "@plugins/ui/plugins/icons/core";

const ruleFolderIcon = symbol("rule-folder");

type StructureRow = {
  plugin: PluginNode;
  nonStandardFolders: string[];
  looseFiles: string[];
  compositionRoot: boolean;
};

const columns: ColumnDef<StructureRow>[] = [
  {
    id: "plugin",
    header: "Plugin",
    width: "minmax(12rem,1.2fr)",
    value: (row) => row.plugin.id,
    cell: (row) => <PluginChip pluginId={row.plugin.id} />,
  },
  {
    id: "folders",
    header: "Non-standard folders",
    width: "minmax(0,1fr)",
    value: (row) => row.nonStandardFolders.join(", "),
    cell: (row) =>
      row.nonStandardFolders.length ? (
        <span className="font-mono text-muted-foreground">
          {row.nonStandardFolders.map((f) => `${f}/`).join(" ")}
        </span>
      ) : (
        <span className="text-muted-foreground/50">—</span>
      ),
  },
  {
    id: "looseFiles",
    header: "Loose files",
    width: "minmax(0,1fr)",
    value: (row) => row.looseFiles.join(", "),
    cell: (row) =>
      row.looseFiles.length ? (
        <span className="font-mono text-muted-foreground">
          {row.looseFiles.join(" ")}
        </span>
      ) : (
        <span className="text-muted-foreground/50">—</span>
      ),
  },
  {
    id: "compositionRoot",
    header: "Composition root",
    width: "auto",
    align: "center",
    value: (row) => (row.compositionRoot ? "yes" : ""),
    cell: (row) =>
      row.compositionRoot ? (
        <span className="text-foreground">yes</span>
      ) : (
        <span className="text-muted-foreground/50">—</span>
      ),
  },
];

function rows(entries: FacetTableEntry[]): StructureRow[] {
  const result: StructureRow[] = [];
  for (const entry of entries) {
    const data = entry.data as StructureFacetData;
    const nonStandardFolders = data.folders
      .filter((f) => !f.standard)
      .map((f) => f.name);
    // Only plugins with at least one structural anomaly appear in the table —
    // conformant plugins are excluded, so the tab badge counts anomalies.
    if (
      nonStandardFolders.length === 0 &&
      data.looseFiles.length === 0 &&
      !data.compositionRoot
    ) {
      continue;
    }
    result.push({
      plugin: entry.node,
      nonStandardFolders,
      looseFiles: data.looseFiles,
      compositionRoot: data.compositionRoot,
    });
  }
  return result;
}

export const structureFacetTable = defineFacetTable<StructureRow>({
  facetId: "structure",
  label: "Structure",
  icon: ruleFolderIcon,
  columns,
  rows,
  rowKey: (r) => r.plugin.id,
});

// Clicking a row opens that plugin's detail pane, where the migrated Structure
// section shows the same anomalies in context. `pluginViewPane` is a meta pane
// (plugin-view/web), so this row activation stays co-located with the renderer.
export const structureRowActivation = defineRowActivation<StructureRow>({
  facetId: "structure",
  rowActivation: (r, { openPane }) =>
    openPane.to(pluginViewPane, { pluginId: r.plugin.id }, { mode: "push" }),
});
