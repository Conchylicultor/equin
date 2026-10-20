import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { pluginChangesServed } from "./internal/plugin-changes-resource";

export default {
  description:
    "The review.plugin-changes live value, desktop-only half: served here because it recomputes on the edited-files value, which only the machine half of conversation-view/code serves (it reads the worktree on disk).",
  contributions: [...pluginChangesServed.declare],
} satisfies MachinePluginDefinition;
