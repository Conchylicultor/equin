import { useMemo } from "react";
import { z } from "zod";
import type { ToolViewProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import { ToolCallCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import {
  readQueryDbResult,
  type QueryDbResult,
} from "@plugins/database/plugins/query/core";
import {
  DataTable,
  type ColumnDef,
} from "@plugins/primitives/plugins/data-table/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { HighlightedCode } from "@plugins/primitives/plugins/syntax-highlight/web";
import { cellText, compactSql, queryNote } from "../internal/describe";

/** `query_db`'s input, as its card draws it. */
export const QueryDbInputSchema = z.object({
  sql: z.string(),
  database: z.string().optional(),
});
type QueryDbInput = z.infer<typeof QueryDbInputSchema>;
type Row = QueryDbResult["rows"][number];

function columnsOf(result: QueryDbResult): ColumnDef<Row>[] {
  return result.columns.map((name) => ({
    id: name,
    header: name,
    cell: (row) => {
      const value = row[name];
      return (
        <Text
          as="span"
          variant="caption"
          tone={value === null || value === undefined ? "faint" : "default"}
          className="font-mono"
        >
          {cellText(value)}
        </Text>
      );
    },
  }));
}

export function QueryDbToolView({ event, input }: ToolViewProps<QueryDbInput>) {
  const content = event.result?.content;
  const failed = event.result?.isError === true;
  const read = useMemo(
    () => (content === undefined ? undefined : readQueryDbResult(content)),
    [content],
  );
  const result = read?.kind === "result" ? read.result : undefined;
  const columns = useMemo(() => (result ? columnsOf(result) : []), [result]);

  const note = queryNote(
    result && { shown: result.rows.length, total: result.rowCount },
    input.database,
  );

  return (
    <ToolCallCard
      event={event}
      summary={compactSql(input.sql)}
      note={note}
      defaultOpen={failed}
    >
      <Stack gap="sm">
        <HighlightedCode code={input.sql} lang="sql" />
        {failed && (
          <Text
            as="p"
            variant="caption"
            className="text-destructive whitespace-pre-wrap"
          >
            {content}
          </Text>
        )}
        {result && result.rows.length > 0 && (
          <Scroll className="max-h-72">
            <DataTable
              data={result.rows}
              columns={columns}
              rowKey={(_, i) => String(i)}
              density="compact"
            />
          </Scroll>
        )}
        {read?.kind === "unreadable" && !failed && (
          <Text
            as="p"
            variant="caption"
            tone="muted"
            className="whitespace-pre-wrap"
          >
            {content}
          </Text>
        )}
        {result?.note && (
          <Text
            as="p"
            variant="caption"
            tone="muted"
            className="whitespace-pre-wrap"
          >
            {result.note}
          </Text>
        )}
      </Stack>
    </ToolCallCard>
  );
}
