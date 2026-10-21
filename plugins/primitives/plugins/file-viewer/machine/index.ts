import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { fileBytesServed } from "./internal/bytes";

export default {
  description:
    "file-viewer's desktop half: the file-viewer.bytes live value — a FileRef's raw bytes on demand (a host file through host-fs, a workspace file through code-explorer — on disk or as of a ref — each invalidated from a watch while read), refused missing / denied / too-large / unsupported / invalid-path.",
  contributions: [...fileBytesServed.declare],
} satisfies MachinePluginDefinition;
