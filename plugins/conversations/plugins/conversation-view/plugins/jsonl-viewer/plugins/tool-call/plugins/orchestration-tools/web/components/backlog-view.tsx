import { useMemo } from "react";
import { z } from "zod";
import type { ToolViewProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import { ToolCallCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { activationProps } from "@plugins/primitives/plugins/link-gesture/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { taskDetailPane } from "@plugins/tasks/plugins/task-detail/web";
import { StatusIcon } from "@plugins/tasks/plugins/task-status/web";
import { TaskStatusSchema } from "@plugins/tasks/plugins/tasks-core/core";
import { readBacklog } from "@plugins/tasks/plugins/supervisor-roles/plugins/sessions/core";

/** `backlog`'s input: it takes none, and its card draws from the result. */
export const BacklogInputSchema = z.looseObject({});

/** "2 waiting · 1 held" — what the backlog holds, by standing. */
function summaryOf(statuses: readonly (string | null)[]): string {
  const counts = new Map<string, number>();
  for (const s of statuses) {
    const word = s ?? "waiting";
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts].map(([s, n]) => `${n} ${s}`).join(" · ");
}

export function BacklogView({
  event,
}: ToolViewProps<z.infer<typeof BacklogInputSchema>>) {
  const backlog = useMemo(
    () => (event.result ? readBacklog(event.result.content) : null),
    [event.result],
  );
  const openPane = useOpenPane();
  const tasks = backlog?.lines.filter((l) => l.kind === "task") ?? [];
  const empty = backlog?.count === 0;

  return (
    <ToolCallCard
      event={event}
      summary={
        empty
          ? "empty"
          : tasks.length > 0
            ? summaryOf(tasks.map((t) => t.status))
            : undefined
      }
      note={backlog?.truncated ? "· oldest only, more waiting" : undefined}
    >
      {backlog && backlog.lines.length > 0 && (
        <Scroll className="max-h-[320px]">
          <Stack gap="none">
            {/* eslint-disable-next-line data-view/no-adhoc-row-list -- a snapshot of the backlog as the agent read it (tool-result text), not a live record set */}
            {backlog.lines.map((line, i) => {
              if (line.kind === "text")
                return (
                  <Text
                    key={`text-${i}`}
                    as="p"
                    variant="caption"
                    tone="muted"
                    className="px-row"
                  >
                    {line.text}
                  </Text>
                );
              const status = TaskStatusSchema.safeParse(line.status ?? "new");
              return (
                <Row
                  key={line.taskId}
                  size="sm"
                  icon={
                    status.success ? (
                      <StatusIcon status={status.data} />
                    ) : undefined
                  }
                  title={
                    line.filedFrom
                      ? `${line.taskId} · filed from ${line.filedFrom}`
                      : line.taskId
                  }
                  {...activationProps(
                    openPane.to(
                      taskDetailPane,
                      { taskId: line.taskId },
                      { mode: "push" },
                    ),
                  )}
                >
                  <Fill as="span" className="truncate">
                    {line.title}
                  </Fill>
                  {line.status !== null && (
                    <Badge variant="warning" className={rigidClass()}>
                      {line.status}
                    </Badge>
                  )}
                  {line.track !== "main" && (
                    <Badge variant="muted" className={rigidClass()}>
                      {line.track}
                    </Badge>
                  )}
                </Row>
              );
            })}
          </Stack>
        </Scroll>
      )}
    </ToolCallCard>
  );
}
