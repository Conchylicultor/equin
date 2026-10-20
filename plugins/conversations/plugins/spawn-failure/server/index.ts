import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { spawnFailureRowsServed } from "./internal/resource";

export { spawnFailures } from "./internal/tables";
export { clearSpawnFailure, recordSpawnFailure } from "./internal/record";

export default {
  portable: true,
  description:
    "Per-conversation spawn failure: the latest error of a conversation's spawn job (the failed step and its message), stored in conversations_ext_spawn_failure by the job on every failed attempt and deleted once a session starts, served as a lookup-only collection.",
  contributions: [...spawnFailureRowsServed.declare],
} satisfies ServerPluginDefinition;
