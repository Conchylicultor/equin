import type {
  LaunchFragment,
  LaunchPermissions,
} from "@plugins/conversations/plugins/workspace/server";

/**
 * Claude Code's sandbox for a profile that asked for one (`sandbox: true`):
 * Bash runs sandboxed with no way out (`allowUnsandboxedCommands: false`
 * makes the `dangerouslyDisableSandbox` parameter ignored — in bypass mode it
 * would otherwise be granted), and the session fails at startup when the
 * sandbox cannot start rather than running commands unsandboxed. Writes stay
 * the sandbox default — the cwd, i.e. the scratch dir — and so does the
 * network (no domain allowed).
 */
const SANDBOX = {
  enabled: true,
  failIfUnavailable: true,
  autoAllowBashIfSandboxed: true,
  allowUnsandboxedCommands: false,
} as const;

/**
 * A scratch session's launch, beyond the runtime's own options. Pure.
 *
 * - setting sources `user` + `project`: the user's own `~/.claude` settings,
 *   memory and plugins apply (decided 2026-10-13); `project` is the scratch
 *   dir itself — it is what loads the profile's `CLAUDE.md` (with `user` alone
 *   Claude Code reads no `CLAUDE.md` from the cwd, measured). The dir sits
 *   outside this repo, so no repo CLAUDE.md, `.claude/settings.json` or
 *   `.mcp.json` is reachable from it; `local` is dropped.
 * - one MCP server, strictly: the app's MCP server for this conversation and
 *   no other — its tools are scoped to the profile's allowlist server-side
 *   (`Mcp.scope`).
 * - the profile's `permissions`, unioned by the runtime with the agent
 *   policy's deny rules, and its `sandbox` ({@link SANDBOX}) in the settings.
 * - `guardsRoot`: the launching backend's checkout. No project settings are
 *   reachable from the dir, so the launch's policy hooks (guards/agent-policy)
 *   are the agent's only guards — every one of them, `macos-automation`
 *   included — run from the code that launched it.
 */
export function scratchLaunchFragment(opts: {
  mcpUrl: string;
  guardsRoot: string;
  permissions?: LaunchPermissions;
  sandbox?: boolean;
}): LaunchFragment {
  return {
    settingSources: ["user", "project"],
    mcpServers: { equin: { type: "http", url: opts.mcpUrl } },
    strictMcpConfig: true,
    ...(opts.permissions ? { permissions: opts.permissions } : {}),
    guardsRoot: opts.guardsRoot,
    settings: opts.sandbox ? { sandbox: SANDBOX } : {},
  };
}
