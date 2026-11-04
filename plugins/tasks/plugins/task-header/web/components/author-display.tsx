import { rowOrStale } from "@plugins/network/plugins/live/web";
import { useConversationById } from "@plugins/conversations/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { foldResource } from "@plugins/network/plugins/live/plugins/live-state/web";
import { useTask } from "@plugins/tasks/web";
import { taskDetailPane } from "@plugins/tasks/plugins/task-detail/web";

export function AuthorDisplay({ author }: { author: string | null }) {
  const isUser = !author || author === "user";
  const authorConversation = rowOrStale(
    useConversationById(isUser ? null : author),
  );
  const authorTask = useTask(authorConversation?.taskId);
  const openPane = useOpenPane();

  if (isUser) {
    return <Text variant="body">User</Text>;
  }

  // Until the author's task is known — or when it could not be read, or the
  // author conversation has no task — the raw author id stands in: it is the
  // true value, just not linked. A failed read also says so on hover.
  const row = foldResource(authorTask, {
    loading: () => null,
    error: () => null,
    ready: (t) => t,
  });
  if (row === null) {
    return (
      <Text
        variant="caption"
        tone="muted"
        className="font-mono"
        title={
          authorTask.status === "error"
            ? `Couldn't load the author's task: ${authorTask.error.message}`
            : undefined
        }
      >
        {author}
      </Text>
    );
  }

  return (
    <button
      type="button"
      {...openPane.link(taskDetailPane, { taskId: row.id }, { mode: "swap" })}
      className="text-body hover:text-foreground underline underline-offset-2"
    >
      {row.title}
    </button>
  );
}
