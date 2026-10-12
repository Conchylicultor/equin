import { useLive } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { tableForeignKeys } from "../../shared/resources";
import {
  DataTable,
  type ColumnDef,
} from "@plugins/primitives/plugins/data-table/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { SectionLabel } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";

interface OutgoingFk {
  constraint_name: string;
  column_name: string;
  foreign_table: string;
  foreign_column: string;
}

interface IncomingFk {
  constraint_name: string;
  source_table: string;
  source_column: string;
  target_column: string;
}

const outgoingColumns: ColumnDef<OutgoingFk>[] = [
  {
    id: "constraint_name",
    header: "Constraint",
    width: "minmax(0,1fr)",
    cell: (row) => (
      <code className="font-mono text-caption">{row.constraint_name}</code>
    ),
    value: (row) => row.constraint_name,
  },
  {
    id: "column_name",
    header: "Column",
    width: "9rem",
    cell: (row) => (
      <code className="font-mono text-caption">{row.column_name}</code>
    ),
    value: (row) => row.column_name,
  },
  {
    id: "foreign_table",
    header: "Foreign Table",
    width: "10rem",
    cell: (row) => (
      <code className="font-mono text-caption">{row.foreign_table}</code>
    ),
    value: (row) => row.foreign_table,
  },
  {
    id: "foreign_column",
    header: "Foreign Column",
    width: "9rem",
    cell: (row) => (
      <code className="font-mono text-caption">{row.foreign_column}</code>
    ),
    value: (row) => row.foreign_column,
  },
];

const incomingColumns: ColumnDef<IncomingFk>[] = [
  {
    id: "constraint_name",
    header: "Constraint",
    width: "minmax(0,1fr)",
    cell: (row) => (
      <code className="font-mono text-caption">{row.constraint_name}</code>
    ),
    value: (row) => row.constraint_name,
  },
  {
    id: "source_table",
    header: "Source Table",
    width: "10rem",
    cell: (row) => (
      <code className="font-mono text-caption">{row.source_table}</code>
    ),
    value: (row) => row.source_table,
  },
  {
    id: "source_column",
    header: "Source Column",
    width: "9rem",
    cell: (row) => (
      <code className="font-mono text-caption">{row.source_column}</code>
    ),
    value: (row) => row.source_column,
  },
  {
    id: "target_column",
    header: "Target Column",
    width: "9rem",
    cell: (row) => (
      <code className="font-mono text-caption">{row.target_column}</code>
    ),
    value: (row) => row.target_column,
  },
];

export function ForeignKeysSection({
  tableName,
  pluginId: _pluginId,
}: {
  tableName: string;
  pluginId: string;
}) {
  const result = useLive(tableForeignKeys, { tableName });

  if (result.status === "loading") {
    return <Loading variant="spinner" label="Loading foreign keys…" />;
  }

  if (result.status === "error") {
    return (
      <ResourceErrorInline
        variant="block"
        subject="foreign keys"
        error={result.error}
        refetch={result.refetch}
      />
    );
  }

  const data = result.data;

  if (data.outgoing.length === 0 && data.incoming.length === 0) {
    return <Placeholder>No foreign keys</Placeholder>;
  }

  return (
    <Stack gap="lg">
      <Stack gap="sm">
        <SectionLabel>References</SectionLabel>
        <DataTable
          data={data.outgoing}
          columns={outgoingColumns}
          rowKey={(row) => row.constraint_name + row.column_name}
          emptyLabel="No outgoing foreign keys"
        />
      </Stack>
      <Stack gap="sm">
        <SectionLabel>Referenced by</SectionLabel>
        <DataTable
          data={data.incoming}
          columns={incomingColumns}
          rowKey={(row) => row.constraint_name + row.source_column}
          emptyLabel="No incoming foreign keys"
        />
      </Stack>
    </Stack>
  );
}
