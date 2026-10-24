import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import {
  editedFileServed,
  editedFilesServed,
} from "./internal/edited-files-resource";

export default {
  description:
    "The edited-files live values, desktop-only half: a conversation's edited files measured from git in its worktree (paged by path, with the whole set's totals as its meta, and one file by path), watched while on screen, so a host without the computer answers them unavailable.",
  contributions: [...editedFilesServed.declare, ...editedFileServed.declare],
} satisfies MachinePluginDefinition;
