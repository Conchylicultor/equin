import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";
import type { ReorderAreaEditor } from "./internal/editor-contract";

export const ReorderSlots = {
  // The layout EDITOR, opt-in: applying a committed layout ships wherever slots
  // render, editing one only where a composition selects the edit-layout switch
  // (`reorder.edit-mode`, which contributes the one implementation). Not a
  // companion slot, deliberately — a companion would put the editor and dnd-kit
  // back into every bundle.
  AreaEditor: defineSlot<{ editor: ReorderAreaEditor }>({
    docLabel: () => "area editor",
  }),
};
