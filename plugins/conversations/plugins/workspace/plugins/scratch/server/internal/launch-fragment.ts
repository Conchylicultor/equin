import type { LaunchFragment } from "@plugins/conversations/plugins/workspace/server";

/**
 * A scratch session's launch, beyond the runtime's own flags. Pure.
 *
 * - `--setting-sources user,project`: the user's own `~/.claude` settings,
 *   memory and plugins apply (decided 2026-10-13); `project` is the scratch
 *   dir itself — it is what loads the profile's `CLAUDE.md` (with `user` alone
 *   Claude Code reads no `CLAUDE.md` from the cwd, measured). The dir sits
 *   outside this repo, so no repo CLAUDE.md, `.claude/settings.json` or
 *   `.mcp.json` is reachable from it; `local` is dropped.
 * - `--mcp-config` + `--strict-mcp-config`: the app's MCP server for this
 *   conversation and no other — its tools are scoped to the profile's
 *   allowlist server-side (`Mcp.scope`). `--mcp-config` is variadic, so it is
 *   never the last flag before a positional argument.
 * - the profile's `permissions`, merged into the runtime's `--settings`.
 */
export function scratchLaunchFragment(opts: {
  mcpUrl: string;
  permissions?: { allow?: readonly string[]; deny?: readonly string[] };
}): LaunchFragment {
  const mcpConfig = {
    mcpServers: { equin: { type: "http", url: opts.mcpUrl } },
  };
  return {
    argv: [
      "--setting-sources",
      "user,project",
      "--mcp-config",
      JSON.stringify(mcpConfig),
      "--strict-mcp-config",
    ],
    settings: opts.permissions ? { permissions: opts.permissions } : {},
  };
}
