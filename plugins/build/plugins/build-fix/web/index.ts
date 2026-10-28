import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { BuildDetailSlots } from "@plugins/build/web";
import {
  BuildFixAction,
  fixBuildAction,
  useBuildFailed,
} from "./components/build-fix-section";
import { Notifications } from "@plugins/shell/plugins/notifications/web";
import { symbol } from "@plugins/ui/plugins/icons/core";

export default {
  description:
    "Launch-agent button in the build detail pane for failed builds, and the same launch as a Build failed notification's Fix (the fix-build notification action).",
  contributions: [
    // One button is the whole section, so it is contributed as `actions` with no
    // `component`: the card is a single row carrying the action, not a chevron
    // that opens onto one button. `useAvailable` keeps a green build's detail
    // pane from growing a "Fix" bar with nothing behind it.
    BuildDetailSlots.Section({
      id: "fix",
      label: "Fix",
      icon: symbol("auto-fix-high"),
      actions: BuildFixAction,
      useAvailable: useBuildFailed,
    }),
    // A "Build failed" notification's Fix (`action.kind: "fix-build"`).
    Notifications.Action(fixBuildAction),
  ],
} satisfies PluginDefinition;
