import { useLive } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { tableColumns } from "../../shared/resources";
import {
  DataTable,
  type ColumnDef,
} from "@plugins/primitives/plugins/data-table/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";

interface ColumnRow {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
  ordinal_position: number;
}

const columns: ColumnDef<ColumnRow>[] = [
  {
    id: "ordinal_position",
    header: "#",
    width: "2rem",
    value: (row) => row.ordinal_position,
  },
  {
    id: "column_name",
    header: "Column",
    width: "12rem",
    cell: (row) => <code className="font-mono">{row.column_name}</code>,
  },
  {
    id: "data_type",
    header: "Type",
    width: "minmax(0,1fr)",
    value: (row) => row.data_type,
  },
  {
    id: "is_nullable",
    header: "Nullable",
    width: "5rem",
    value: (row) => row.is_nullable,
  },
  {
    id: "column_default",
    header: "Default",
    width: "12rem",
    cell: (row) =>
      row.column_default != null ? (
        <code className="font-mono text-muted-foreground">
          {row.column_default}
        </code>
      ) : null,
  },
];

export function ColumnsSection({
  tableName,
}: {
  tableName: string;
  pluginId: string;
}) {
  const result = useLive(tableColumns, { tableName });

  if (result.status === "loading") {
    return <Loading variant="spinner" label="Loading columns…" />;
  }

  if (result.status === "error") {
    return (
      <ResourceErrorInline
        variant="block"
        subject="columns"
        error={result.error}
        refetch={result.refetch}
      />
    );
  }

  return (
    <DataTable
      data={result.data.columns}
      columns={columns}
      rowKey={(row) => String(row.ordinal_position)}
    />
  );
}
