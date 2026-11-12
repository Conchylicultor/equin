import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export {
  holdBackendDown,
  startBackend,
  BackendHoldError,
} from "./internal/hold";

export default {
  description:
    "Backend down before its data: holdBackendDown stops a namespace's backend through the gateway and holds it down (POST /gateway/worktrees/<ns>/stop?hold=1), answering the HeldBackend proof database/admin's dropDatabase / recreateDatabase require for a namespace's database; startBackend cold-starts it again (a deploy start, which releases the hold).",
} satisfies ServerPluginDefinition;
