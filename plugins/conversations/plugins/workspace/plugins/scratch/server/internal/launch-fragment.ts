import type { LaunchFragment } from "@plugins/conversations/plugins/workspace/server";
import { MACOS_TCC_COMMANDS } from "@plugins/framework/plugins/tooling/plugins/guards/core";

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
 * - the profile's `permissions`, and its `sandbox` ({@link SANDBOX}), merged
 *   into the runtime's settings — with every macOS automation command
 *   (`MACOS_TCC_COMMANDS`) always denied on top of the profile's own deny
 *   list. Repo agents get that from the `macos-automation` guard, which a
 *   scratch session never runs: it loads no repo `.claude/settings.json`.
 */
export function scratchLaunchFragment(opts: {
  mcpUrl: string;
  permissions?: { allow?: readonly string[]; deny?: readonly string[] };
  sandbox?: boolean;
}): LaunchFragment {
  const deny = [
    ...new Set([
      ...(opts.permissions?.deny ?? []),
      ...MACOS_TCC_COMMANDS.map((cmd) => `Bash(${cmd}:*)`),
    ]),
  ];
  return {
    settingSources: ["user", "project"],
    mcpServers: { equin: { type: "http", url: opts.mcpUrl } },
    strictMcpConfig: true,
    settings: {
      permissions: { ...opts.permissions, deny },
      ...(opts.sandbox ? { sandbox: SANDBOX } : {}),
    },
  };
}
