import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { allowFilesServed } from "./internal/allow-files-resource";

export default {
  description:
    "Serves the allow-files live value, desktop-only: which guard-bypass files exist at a conversation's worktree root, pushed by a worktree-root watch while someone looks at the conversation — a host without the computer answers it unavailable.",
  contributions: [...allowFilesServed.declare],
} satisfies MachinePluginDefinition;
