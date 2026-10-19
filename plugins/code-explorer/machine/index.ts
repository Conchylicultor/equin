import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { codeFileVersionServed } from "./internal/file-version";

export default {
  description:
    "code-explorer's desktop half: the code.file-version live value — a workspace file's on-disk revision, stamped and watched through host-fs's machine half.",
  contributions: [...codeFileVersionServed.declare],
} satisfies MachinePluginDefinition;
