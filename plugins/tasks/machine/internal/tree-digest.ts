import { Mcp } from "@plugins/infra/plugins/mcp/server";
import { CompactionContext } from "@plugins/conversations/plugins/compaction-context/server";
import {
  TaskStatusSchema,
  isBlockedStatus,
  tasksFile,
} from "@plugins/tasks/plugins/tasks-core/core";
import {
  granted,
  grantOf,
} from "@plugins/tasks/plugins/orchestration/plugins/mandate/server";
import {
  taskTree,
  treeDigest,
  TreeDigest,
} from "@plugins/tasks/plugins/orchestration/plugins/tree-digest/server";
import { listSidequestIds } from "@plugins/tasks/plugins/task-track/server";
import { listArmedTaskIds } from "@plugins/tasks/plugins/auto-start/server";

/**
 * What a digest line says beyond id, title and status — the words the generic
 * digest cannot know: the track, and whether a not-yet-started task will
 * launch on its own (`armed`) or waits for a person (`manual`).
 */
export const tasksDigestAnnotation = TreeDigest.Annotation({
  id: "tasks",
  annotate: async (tasks) => {
  const ids = tasks.map((t) => t.id);
  const [sidequests, armed] = await Promise.all([
    listSidequestIds(ids),
    listArmedTaskIds().then((all) => new Set(all)),
  ]);
  return new Map(
    tasks.map((t) => {
      const words = [sidequests.has(t.id) ? "sidequest" : "main"];
      const status = TaskStatusSchema.parse(t.status);
      if (armed.has(t.id)) words.push("armed");
      else if (status === "new" || isBlockedStatus(status))
        words.push("manual");
      return [t.id, words];
    }),
  );
  },
});

/** The digest `add_task` appends to its result. */
export async function digestFor(conversationId: string): Promise<string> {
  const digest = await treeDigest({ conversationId });
  return digest?.text ?? "";
}

/** The whole tree, read-only — the digest's overflow points here. */
export const taskTreeTool = Mcp.tool({
  name: "task_tree",
  when: granted(tasksFile),
  description:
    "Read the whole task tree your mandate covers: one line per task (id, title, status, track, armed / manual), indented by nesting, your own task marked. Read-only. `add_task` results already carry what changed since you last looked; call this when that digest was cut short, or to re-read the whole tree.",
  inputSchema: {},
  async handler(_input, { conversationId }) {
    const text = await taskTree({ conversationId });
    return {
      content: [
        { type: "text", text: text ?? "This conversation has no task." },
      ],
    };
  },
});

/** The tree, seen at connect — before the first filing. */
export const treeDigestInstructions = Mcp.instructions({
  id: "tree-digest",
  render: async ({ conversationId }) => {
    if ((await grantOf(tasksFile, conversationId)) === null) return null;
    const digest = await treeDigest({ conversationId });
    return digest === null ? null : `## Task tree\n\n${digest.text}`;
  },
});

/**
 * The tree, handed back after a compaction: the summary folds away every
 * digest the agent was given, and the tree is its memory of the work around it.
 */
export const treeAfterCompaction = CompactionContext({
  id: "task-tree",
  restore: async (conversationId) => {
    if ((await grantOf(tasksFile, conversationId)) === null) return "";
    const text = await taskTree({ conversationId });
    return text === null ? "" : `## Task tree\n\n${text}`;
  },
});
