import { useLive } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { tableIndexes } from "../../shared/resources";
import {
  DataTable,
  type ColumnDef,
} from "@plugins/primitives/plugins/data-table/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";

interface IndexRow {
  indexname: string;
  indexdef: string;
}

const columns: ColumnDef<IndexRow>[] = [
  {
    id: "name",
    header: "Name",
    width: "14rem",
    value: (row) => row.indexname,
    cell: (row) => <code className="font-mono">{row.indexname}</code>,
  },
  {
    id: "definition",
    header: "Definition",
    width: "minmax(0,1fr)",
    value: (row) => row.indexdef,
    cell: (row) => (
      <code className="break-all font-mono text-muted-foreground">
        {row.indexdef}
      </code>
    ),
  },
];

export function IndexesSection({
  tableName,
}: {
  tableName: string;
  pluginId: string;
}) {
  const result = useLive(tableIndexes, { tableName });

  if (result.status === "loading") {
    return <Loading variant="spinner" label="Loading indexes…" />;
  }

  if (result.status === "error") {
    return (
      <ResourceErrorInline
        variant="block"
        subject="indexes"
        error={result.error}
        refetch={result.refetch}
      />
    );
  }

  return (
    <DataTable
      data={result.data.indexes}
      columns={columns}
      rowKey={(row) => row.indexname}
      emptyLabel="No indexes found"
    />
  );
}
