import { readFile } from "@plugins/packages/plugins/timed-fs/core";
import { join } from "node:path";
import type { Check } from "@plugins/framework/plugins/tooling/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import { envName } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import {
  MAIN_WORKTREE_NAME,
  namespaceUrl,
} from "@plugins/infra/plugins/namespace/core";
// Own plugin, so relative.
import { MCP_SERVER_NAME, MCP_UNATTACHED_ID } from "../core";

const MCP_JSON = ".mcp.json";

/**
 * The URL `.mcp.json` must give the equin server. A session equin launched
 * carries both variables (conversations/agent-launch); one it did not — a
 * `claude` started in a terminal to recover a broken main — falls back to
 * main's gateway origin and the unattached route.
 */
function expectedMcpUrl(): string {
  return (
    `\${${envName("PARENT_URL")}:-${namespaceUrl(MAIN_WORKTREE_NAME)}}` +
    `/api/mcp/\${${envName("CONVERSATION_ID")}:-${MCP_UNATTACHED_ID}}`
  );
}

/**
 * `.mcp.json` is JSON: it cannot import `MCP_UNATTACHED_ID` or main's origin,
 * so this check pins it to them. A drift is silent — the route answers any id,
 * so a stale fallback would be served as an unknown conversation (every
 * conversation tool failing) instead of as an unattached session.
 */
const mcpJsonInSync: Check = {
  id: "mcp:mcp-json-in-sync",
  description: `${MCP_JSON}'s ${MCP_SERVER_NAME} server must dial the launching backend's conversation route, falling back to main and the unattached route (${MCP_UNATTACHED_ID}) for a session equin did not launch`,
  async run() {
    const root = await getWorktreeRoot();
    const parsed: unknown = JSON.parse(
      await readFile(join(root, MCP_JSON), "utf8"),
    );
    const url = serverUrl(parsed);
    const expected = expectedMcpUrl();
    if (url === expected) return { ok: true };
    return {
      ok: false,
      message: `${MCP_JSON}'s "${MCP_SERVER_NAME}" server url is ${url === null ? "missing" : `"${url}"`}, expected "${expected}"`,
      hint: `Set mcpServers.${MCP_SERVER_NAME}.url in ${MCP_JSON} to the expected string. Its defaults are main's origin (namespaceUrl(MAIN_WORKTREE_NAME)) and MCP_UNATTACHED_ID (plugins/infra/plugins/mcp/core), so a claude equin did not launch still reaches the unattached tools.`,
    };
  },
};

function serverUrl(parsed: unknown): string | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const servers = (parsed as { mcpServers?: unknown }).mcpServers;
  if (typeof servers !== "object" || servers === null) return null;
  const server = (servers as Record<string, unknown>)[MCP_SERVER_NAME];
  if (typeof server !== "object" || server === null) return null;
  const url = (server as { url?: unknown }).url;
  return typeof url === "string" ? url : null;
}

export default [mcpJsonInSync];
