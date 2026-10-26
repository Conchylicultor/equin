import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { WishSlots } from "@plugins/wish/web";
import { TaskDraftFormSlots } from "@plugins/tasks/plugins/task-draft-form/web";
import { ElementPickerButton } from "./components/element-picker-button";
import { TaskDraftPickerButton } from "./components/task-draft-picker-button";

export default {
  description:
    "The element picker wired into equin's Improve flow: a 'Pick UI element' segment of the Improve pill that opens the Improve popover with the picked element as a <ui-context/> chip, and an 'Attach UI element' button in the task-draft form. The picker, its overlay and the chip are primitives/ui-context/element-picker.",
  contributions: [
    WishSlots.Segment({
      id: "element-picker",
      component: ElementPickerButton,
    }),
    TaskDraftFormSlots.Action({
      id: "element-picker",
      component: TaskDraftPickerButton,
    }),
  ],
} satisfies PluginDefinition;
