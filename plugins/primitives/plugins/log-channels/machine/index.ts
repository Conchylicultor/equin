import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { LogPersistence } from "@plugins/primitives/plugins/log-channels/server";
import {
  declareDurableFileSinks,
  filePersistence,
} from "./internal/file-persistence";

export default {
  description:
    "The desktop's log persistence: every durable channel appends to its worktree's <channel>.jsonl through a bounded, rotating file sink (declared at boot, so getFileSinks lists it before its first line), the browser's clientLog channels share one rotation, and the emit ingress pauses while the host duress latch is set.",
  register: [declareDurableFileSinks],
  contributions: [LogPersistence.provide(filePersistence)],
} satisfies MachinePluginDefinition;
