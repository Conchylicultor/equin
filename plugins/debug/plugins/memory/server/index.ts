import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { memoryFilesServed } from "./internal/files-served";
import { memoryFileServed } from "./internal/file-served";

export default {
  description:
    "The memory.files listing and memory.file content live values, each watched through the dir hub.",
  contributions: [...memoryFilesServed.declare, ...memoryFileServed.declare],
} satisfies ServerPluginDefinition;
