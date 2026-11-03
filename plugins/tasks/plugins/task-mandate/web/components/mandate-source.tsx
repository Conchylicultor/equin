import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { useTask } from "@plugins/tasks/web";
import { taskDetailPane } from "@plugins/tasks/plugins/task-detail/web";

/**
 * "from <task>": the ancestor an inherited mandate comes from, linked to its
 * detail. Its raw id stands in until (or unless) the task reads.
 */
export function MandateSource({ sourceTaskId }: { sourceTaskId: string }) {
  const source = useTask(sourceTaskId);
  const openPane = useOpenPane();
  const title =
    source.status === "ready" && source.data ? source.data.title : null;
  return (
    <Text as="span" variant="caption" tone="muted">
      from{" "}
      <button
        type="button"
        {...openPane.link(
          taskDetailPane,
          { taskId: sourceTaskId },
          { mode: "swap" },
        )}
        className="hover:text-foreground underline underline-offset-2"
      >
        {title ?? sourceTaskId}
      </button>
    </Text>
  );
}
