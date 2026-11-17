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

/**
 * The agent-browser host's code: self-contained bundles of `bin/host.ts`
 * (`infra/spawn/daemon/bundle`), one `<hash>.bundle` per distinct content,
 * which the host runs from instead of a checkout. The launching backend makes
 * one when none matches and deletes the ones no host holds.
 */
export const agentBrowserBundlesDir = defineDataDir({
  kind: "cache",
  name: "agent-browser-bundles",
  owner: "infra/mcp/browser",
  description:
    "Self-contained bundles of the agent-browser host's code (one per distinct content), which the host runs from instead of a checkout",
  // A running host runs from one (its in-use lock held); the next launch
  // makes it again, and reclaims every bundle no host holds.
  reclaim: { kind: "restart" },
});

export default [agentBrowserDir, agentBrowserBundlesDir];
