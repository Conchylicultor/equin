import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ActionBar } from "@plugins/shell/plugins/action-bar/web";
import { defineShortcut } from "@plugins/primitives/plugins/shortcuts/web";
import {
  getEditMode,
  setEditMode,
} from "@plugins/primitives/plugins/edit-mode-signal/web";
import { ReorderSlots } from "@plugins/reorder/web";
import { ReorderItemChrome } from "@plugins/reorder/plugins/editor/web";
import { EditLayoutSwitch } from "./internal/edit-layout-switch";
import { AreaEditor } from "./internal/area-editor";

export default {
  description:
    "Slot-layout editing, opt-in: the Edit layout switch in the action bar's view-options popover (Esc exits), and the area editor every reorderable slot mounts beside its items while edit mode is on — the drag host, item chrome, hide/restore/insert and the narrow-row popover. Ships only where a composition selects it, carrying the DnD editor and dnd-kit with it.",
  contributions: [
    ActionBar.ViewOption({
      id: "reorder-pen",
      // In edit mode every reorderable item is a drag target that ignores
      // clicks, so the switch that turns edit mode off must stay out of it.
      excludeFromReorder: true,
      component: EditLayoutSwitch,
    }),
    defineShortcut({
      id: "reorder.exit-edit-mode",
      keys: "escape",
      label: "Exit edit mode",
      group: "Reorder",
      handler: () => setEditMode(false),
      when: () => getEditMode(),
      // Esc leaves the innermost mode first. Fullscreen's own Esc
      // (`surface.exit-solo`) is live whenever edit mode is, and an equal
      // priority went to whichever registered first — so Esc left fullscreen
      // and edit mode stayed on, with its switch in an unclickable gear.
      priority: 10,
    }),
    // The switch and the editor ship together: the switch is the only thing
    // that turns edit mode on, and reorder throws if edit mode is on with no
    // editor registered.
    ReorderSlots.AreaEditor({
      editor: { Area: AreaEditor, ItemChrome: ReorderItemChrome },
    }),
  ],
} satisfies PluginDefinition;
