import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { isDesktopActive } from "@plugins/apps/plugins/desktop/plugins/shell/web";
import { Desktop } from "@plugins/apps/plugins/desktop/plugins/windows/web";
import { defineShortcut } from "@plugins/primitives/plugins/shortcuts/web";
import { LauncherOverlay } from "./components/launcher-overlay";
import { toggleLauncher } from "./internal/launcher-controls";

export {
  openLauncher,
  closeLauncher,
  toggleLauncher,
} from "./internal/launcher-controls";

export default {
  description:
    "The desktop's ⌘K launcher: a centred dialog over the windows listing every app as a grid (an empty query) or the matching apps and window commands (a query), with arrow-key selection, Shift+Enter for a new window and a right-click menu to keep an app in the dock. Exposes open / close / toggle for the shelf's launcher button.",
  contributions: [
    Desktop.Overlay({ id: "launcher", component: LauncherOverlay }),
    defineShortcut({
      id: "desktop.launcher",
      keys: "mod+k",
      label: "Open the launcher",
      // Not "Window" / "Desktop": those groups are what the launcher lists as
      // commands, and the launcher is not a command of itself.
      group: "Launcher",
      when: isDesktopActive,
      handler: toggleLauncher,
    }),
  ],
} satisfies PluginDefinition;
