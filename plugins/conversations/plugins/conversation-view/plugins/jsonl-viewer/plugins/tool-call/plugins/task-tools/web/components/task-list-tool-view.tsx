import { useMemo } from "react";
import type { ToolRendererProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import { ToolCallCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import {
  Badge,
  formatStatusLabel,
} from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";

type TaskListResult = Array<{
  id?: string;
  description?: string;
  status?: string;
}>;

function parseResult(event: ToolRendererProps["event"]): TaskListResult | null {
  if (!event.result?.content) return null;
  try {
    const parsed = JSON.parse(event.result.content);
    return Array.isArray(parsed) ? parsed : null;
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return null;
  }
}

export function TaskListToolView({ event }: ToolRendererProps) {
  const tasks = useMemo(() => parseResult(event), [event]);
  const count = tasks?.length ?? 0;

  const summary = (
    <span className="tabular-nums">
      {count} task{count !== 1 ? "s" : ""}
    </span>
  );

  return (
    <ToolCallCard event={event} summary={summary} defaultOpen={false}>
      {tasks && tasks.length > 0 && (
        <Scroll className="max-h-[200px]">
          <Stack gap="xs">
            {tasks.map((t, i) => (
              <Line
                key={t.id ?? i}
                className="gap-sm text-2xs text-muted-foreground"
              >
                {t.id && (
                  <span className={cn(rigidClass(), "font-mono")}>{t.id}</span>
                )}
                {t.status && (
                  <Badge variant="muted" className={rigidClass()}>
                    {formatStatusLabel(t.status)}
                  </Badge>
                )}
                {t.description && (
                  <Fill as="span" className="truncate">
                    {t.description}
                  </Fill>
                )}
              </Line>
            ))}
          </Stack>
        </Scroll>
      )}
      {event.result?.isError && (
        <Text as="p" variant="caption" className="text-destructive">
          {event.result.content}
        </Text>
      )}
    </ToolCallCard>
  );
}
