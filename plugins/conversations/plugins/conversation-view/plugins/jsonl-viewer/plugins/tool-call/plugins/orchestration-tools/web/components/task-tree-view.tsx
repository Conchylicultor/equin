import { useMemo } from "react";
import type { ToolRendererProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import { ToolCallCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { activationProps } from "@plugins/primitives/plugins/link-gesture/web";
import type { Activation } from "@plugins/primitives/plugins/link-gesture/core";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { taskDetailPane } from "@plugins/tasks/plugins/task-detail/web";
import { StatusIcon } from "@plugins/tasks/plugins/task-status/web";
import {
  readTree,
  type ReadTreeLine,
} from "@plugins/tasks/plugins/orchestration/plugins/tree-digest/core";
import { TaskStatusSchema } from "@plugins/tasks/plugins/tasks-core/core";

/** px of indentation per tree level. */
const INDENT = 16;

/** A tree line's words as the row shows them: the default track (`main`) is
 *  every task's, so only the exception is drawn; `report: <its first words>`
 *  says the task's agent reported, which is all a row needs. */
function shownWords(words: readonly string[]): string[] {
  return words
    .filter((w) => w !== "main")
    .map((w) => (w.startsWith("report: ") ? "reported" : w));
}

export function TaskTreeView({ event }: ToolRendererProps) {
  const tree = useMemo(
    () => (event.result ? readTree(event.result.content) : null),
    [event.result],
  );
  const openPane = useOpenPane();
  const tasks = tree?.lines.filter((l) => l.kind === "task") ?? [];
  const root = tasks.find((l) => l.taskId === tree?.rootTaskId);

  return (
    <ToolCallCard
      event={event}
      summary={root?.title}
      note={
        tasks.length > 0
          ? `· ${tasks.length} task${tasks.length === 1 ? "" : "s"}`
          : undefined
      }
    >
      {tree && (
        <Scroll className="max-h-[320px]">
          <Stack gap="none">
            {tree.lines.map((line, i) => (
              <TreeRow
                key={line.kind === "task" ? line.taskId : `text-${i}`}
                line={line}
                open={(taskId) =>
                  openPane.to(taskDetailPane, { taskId }, { mode: "push" })
                }
              />
            ))}
          </Stack>
        </Scroll>
      )}
    </ToolCallCard>
  );
}

function TreeRow({
  line,
  open,
}: {
  line: ReadTreeLine;
  open: (taskId: string) => Activation;
}) {
  if (line.kind === "text")
    return (
      <Text as="p" variant="caption" tone="muted" className="px-row">
        {line.text}
      </Text>
    );
  // A line's first word is its task's status; one this build does not know
  // stays a word.
  const [first = "", ...rest] = line.words;
  const status = TaskStatusSchema.safeParse(first);
  const words = status.success ? rest : line.words;
  return (
    <Row
      size="sm"
      indent={line.depth * INDENT}
      icon={status.success ? <StatusIcon status={status.data} /> : undefined}
      title={line.taskId}
      {...activationProps(open(line.taskId))}
    >
      <Fill as="span" className="truncate">
        {line.title}
      </Fill>
      {shownWords(words).map((w) => (
        <Badge key={w} variant="muted" className={rigidClass()}>
          {w}
        </Badge>
      ))}
      {line.self && (
        <Badge variant="info" className={rigidClass()}>
          you
        </Badge>
      )}
    </Row>
  );
}
