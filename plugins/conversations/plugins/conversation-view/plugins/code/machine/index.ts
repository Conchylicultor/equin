import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { editedFilesServed } from "./internal/edited-files-resource";

export { editedFilesServed } from "./internal/edited-files-resource";

export default {
  description:
    "The edited-files live value, desktop-only half: a conversation's edited files measured from git in its worktree (watched while on screen), so a host without the computer answers it unavailable.",
  contributions: [...editedFilesServed.declare],
} satisfies MachinePluginDefinition;
