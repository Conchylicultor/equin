import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { TaskDetailSlots } from "@plugins/tasks/plugins/task-detail/web";
import { TaskHeader } from "./components/task-header";

export default {
  description:
    "Top section of the task detail pane: editable title, status chip, hold/drop buttons, track (main | sidequest, click to switch), author, the page it was filed from, and timestamps. Launch configuration (auto-start, preprompt, thinking mode) lives in the Prompt card, not here.",
  contributions: [
    TaskDetailSlots.Section({
      // The id keys the persisted order and open state — never rename it.
      id: "header",
      // The pane's identity block, carded like every other section. Collapsing
      // it loses nothing: the pane header already shows the task's title.
      label: "Task",
      component: TaskHeader,
      useDefaultOpen: () => true,
      // Deliberately NOT `excludeFromReorder` — that flag means "pinned LAST"
      // (reorder/web/internal/sorting.ts, "Excluded items pinned last"), which
      // would sink the identity block to the foot of the pane. First position
      // comes from registration order instead. Pinning it there needs a
      // pin-first notion reorder does not have yet.
    }),
  ],
} satisfies PluginDefinition;
