import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { fileBytesServed } from "./internal/bytes";

export default {
  description:
    "file-viewer's desktop half: the file-viewer.bytes live value — a FileRef's raw bytes on demand (a host file through host-fs, invalidated from a watch of its folder while read), refused missing / denied / too-large / unsupported.",
  contributions: [...fileBytesServed.declare],
} satisfies MachinePluginDefinition;
