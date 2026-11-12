import { useMemo } from "react";
import type { ToolViewProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import { ToolCallCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  DataTable,
  type ColumnDef,
} from "@plugins/primitives/plugins/data-table/web";
import {
  describeProfileInput,
  readProfile,
  type Aggregate,
  type ProfileInput,
} from "../internal/profile";

function num(
  label: string,
  pick: (a: Aggregate) => number | undefined,
): ColumnDef<Aggregate> {
  return {
    id: label,
    header: label,
    cell: (a) => (
      <Text as="span" variant="caption" className="font-mono">
        {pick(a) ?? "–"}
      </Text>
    ),
  };
}

const COLUMNS: ColumnDef<Aggregate>[] = [
  {
    id: "label",
    header: "Label",
    width: "minmax(0,1fr)",
    cell: (a) => (
      <Text as="span" variant="caption" className="break-words">
        {a.label}
      </Text>
    ),
  },
  num("count", (a) => a.count),
  num("avg ms", (a) => a.avgMs),
  num("wait ms", (a) => a.waitMs),
  num("self ms", (a) => a.selfMs),
  num("recent max", (a) => a.recentMaxMs),
  num("max", (a) => a.maxMs),
];

export function RuntimeProfileToolView({
  event,
  input,
}: ToolViewProps<ProfileInput>) {
  const content = event.result?.content;
  const failed = event.result?.isError === true;
  const read = useMemo(
    () => (content === undefined ? undefined : readProfile(content)),
    [content],
  );
  const kinds =
    read?.kind === "profile"
      ? Object.entries(read.profile.kinds).filter(
          ([, k]) => k.aggregates.length > 0,
        )
      : [];

  return (
    <ToolCallCard
      event={event}
      summary={describeProfileInput(input)}
      note={read?.kind === "profile" ? `· ${kinds.length} kinds` : undefined}
      defaultOpen={failed}
    >
      <Stack gap="sm">
        {kinds.map(([kind, k]) => (
          <Stack key={kind} gap="2xs">
            <Text as="p" variant="caption" tone="muted">
              {kind}
            </Text>
            <Scroll className="max-h-80">
              <DataTable
                data={k.aggregates}
                columns={COLUMNS}
                rowKey={(_, i) => String(i)}
                density="compact"
              />
            </Scroll>
          </Stack>
        ))}
        {read?.kind === "text" && (
          <Text
            as="pre"
            variant="caption"
            tone={failed ? "destructive" : "muted"}
            className="font-mono whitespace-pre-wrap break-words"
          >
            {read.text}
          </Text>
        )}
      </Stack>
    </ToolCallCard>
  );
}
