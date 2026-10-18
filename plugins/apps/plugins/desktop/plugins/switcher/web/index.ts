import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { isDesktopActive } from "@plugins/apps/plugins/desktop/plugins/shell/web";
import { Desktop } from "@plugins/apps/plugins/desktop/plugins/windows/web";
import { defineShortcut } from "@plugins/primitives/plugins/shortcuts/web";
import { SwitcherOverlay } from "./components/switcher-overlay";
import { stepSwitcher } from "./internal/switcher-controls";

export default {
  description:
    "The desktop's window switcher: ⌘` opens a panel of snapshots of the active desktop's windows, front-most first; each further press steps the selection, releasing the modifier brings the selected window forward (restoring it if minimised), Esc cancels and a click picks.",
  contributions: [
    Desktop.Overlay({ id: "switcher", component: SwitcherOverlay }),
    defineShortcut({
      id: "desktop.switcher-next",
      keys: "mod+`",
      label: "Switch windows",
      // Not "Window" / "Desktop": the launcher lists those groups as commands,
      // and this one only means something with the modifier held.
      group: "Switching",
      when: isDesktopActive,
      handler: () => stepSwitcher(1),
    }),
    defineShortcut({
      id: "desktop.switcher-prev",
      keys: "mod+shift+`",
      label: "Switch windows (reverse)",
      group: "Switching",
      when: isDesktopActive,
      handler: () => stepSwitcher(-1),
    }),
    // The registry matches on `KeyboardEvent.key`, which for Shift+Backquote is
    // the shifted "~" on a real US keyboard but the base "`" in some synthetic
    // input environments — register both so ⌘⇧` reverses on any keyboard.
    defineShortcut({
      id: "desktop.switcher-prev-tilde",
      keys: "mod+shift+~",
      label: "Switch windows (reverse)",
      group: "Switching",
      when: isDesktopActive,
      handler: () => stepSwitcher(-1),
    }),
  ],
} satisfies PluginDefinition;
