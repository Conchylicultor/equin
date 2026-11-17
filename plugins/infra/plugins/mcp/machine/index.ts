import {
  getBootMode,
  type MachinePluginDefinition,
} from "@plugins/framework/plugins/server-core/core";
import { isMain } from "@plugins/infra/plugins/runtime-identity/core";
import { machineHandler } from "@plugins/infra/plugins/endpoints/machine";
import { mcpCatalogServed } from "./internal/catalog";
import { handleMcpRequest } from "./internal/handle-mcp";
import { mcpHealthServed } from "./internal/health";
import { mcpSdk } from "./internal/sdk";
import { mcpRequest } from "../core";

export default {
  description:
    "The MCP server, desktop half: the POST /api/mcp/:conversationId route (a fresh stateless @modelcontextprotocol/sdk server per request, mounting every Mcp.tool in the conversation's scope, each per-connection contribution isolated — or, for the reserved id `unattached` (a session equin did not launch), only the tools declared unattached), the mcp.catalog live value (every tool with its input schema as tools/list sends it, and the scope resolver, with the plugin that declared each) and the mcp.health push value (the latest request's outcome and every contribution whose latest run threw). Desktop-only: agents run on the computer, and the SDK stays out of a browser host.",
  loadBearing: true,
  httpRoutes: {
    [mcpRequest.route]: machineHandler(mcpRequest, handleMcpRequest),
  },
  contributions: [...mcpCatalogServed.declare, ...mcpHealthServed.declare],
  // Main's serving backend evaluates the SDK before readiness: every running
  // agent calls it within seconds of a restart, and the first call's
  // synchronous module evaluation (ajv) blocked the thread 1–3 s in the very
  // window where every tab replays its subs (2026-11-17 23:13: a 2.97 s block,
  // ~2.75 s of it sampled in ajv + the SDK). Here the old backend still serves
  // the tabs. An exec child and a worktree backend (agents never call one)
  // keep the lazy load — see ./internal/sdk.ts.
  onReadyBlocking: async ({ step }) => {
    if (getBootMode() !== "serve" || !isMain()) return;
    await step("load-sdk", () => mcpSdk());
  },
} satisfies MachinePluginDefinition;
