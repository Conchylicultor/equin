import {
  defineFacetTable,
  type FacetTableEntry,
  PluginChip,
} from "@plugins/plugin-meta/plugins/contributions-table/web";
import type { ColumnDef } from "@plugins/primitives/plugins/data-table/web";
import type { PluginNode } from "@plugins/plugin-meta/plugins/plugin-view/core";
import type { DeploySecretsData } from "@plugins/plugin-meta/plugins/facets/plugins/deploy-secrets/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

const keyIcon = symbol("key");

type DeploySecretRow = {
  plugin: PluginNode;
  key: string;
  description: string;
};

const columns: ColumnDef<DeploySecretRow>[] = [
  {
    id: "key",
    header: "Key",
    value: (row) => row.key,
    cell: (row) => (
      <code className="truncate font-mono text-foreground">{row.key}</code>
    ),
  },
  {
    id: "description",
    header: "Description",
    width: "minmax(0,1fr)",
    value: (row) => row.description,
    cell: (row) => (
      <span className="truncate text-muted-foreground">{row.description}</span>
    ),
  },
  {
    id: "plugin",
    header: "Plugin",
    value: (row) => row.plugin.id,
    cell: (row) => <PluginChip pluginId={row.plugin.id} />,
  },
];

function rows(entries: FacetTableEntry[]): DeploySecretRow[] {
  return entries.flatMap((entry) =>
    (entry.data as DeploySecretsData).declared.map((d) => ({
      plugin: entry.node,
      key: d.key,
      description: d.description,
    })),
  );
}

export const deploySecretsFacetTable = defineFacetTable<DeploySecretRow>({
  facetId: "deploy-secrets",
  label: "Deploy secrets",
  icon: keyIcon,
  columns,
  rows,
  rowKey: (r) => `${r.plugin.id}:${r.key}`,
});
