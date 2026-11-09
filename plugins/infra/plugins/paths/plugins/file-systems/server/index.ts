import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { fileSystemsServedServed } from "./internal/provided";

export { FileSystemProvided } from "./internal/provided";

export default {
  description:
    "Which file systems this host serves: FileSystemProvided(fs), contributed by the half serving a system's reads, and the files.systems value listing them (fixed per build) — what a browser reads to leave out a system nobody answers here.",
  contributions: [...fileSystemsServedServed.declare],
} satisfies ServerPluginDefinition;
