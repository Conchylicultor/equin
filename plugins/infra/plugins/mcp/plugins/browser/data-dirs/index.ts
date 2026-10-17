import { defineDataDir } from "@plugins/infra/plugins/paths/core";

/**
 * The agent-browser host's runtime files: its Unix socket (`host.sock`), pid
 * file, singleton lock and published `status.json`. One host per machine, so
 * one directory — never per namespace.
 */
export const agentBrowserDir = defineDataDir({
  kind: "services",
  name: "agent-browser",
  owner: "infra/mcp/browser",
  description:
    "The agent-browser host's socket, pid file, singleton lock and published status — the headless Chromium every agent conversation drives",
  // A socket and a pid mean nothing once their process is gone, and the next
  // browser_* call relaunches the host.
  reclaim: { kind: "restart" },
});

export default [agentBrowserDir];
