import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ConfigV2 } from "@plugins/config_v2/web";
import { taskDraftConfig } from "../shared/config";
import { TaskDraftFormSlots as TaskDraftFormSlotGroup } from "./slots";

export { TaskDraftPopover } from "./components/task-draft-popover";
export type {
  TaskDraftPopoverProps,
  TaskDraftRelate,
} from "./components/task-draft-popover";
export type {
  CardDraft,
  TaskDraftHintAnchors,
} from "./components/task-draft-form";

export {
  setActiveRelateContext,
  useActiveRelateContext,
} from "./active-relate-context";
export type { ActiveRelateContext } from "./active-relate-context";

export { TaskDraftFormSlots } from "./slots";
export type { TaskDraftActionProps } from "./slots";

export { draftInsert, draftSeed } from "./insert-request";
export type { TaskDraftInsert } from "./insert-request";

export default {
  description:
    "Reusable popover + chain form for drafting one or more tasks. Powers the Improve toolbar button and the conversation new-child-task button.",
  contributions: [ConfigV2.WebRegister({ descriptor: taskDraftConfig })],
  slots: TaskDraftFormSlotGroup,
} satisfies PluginDefinition;
