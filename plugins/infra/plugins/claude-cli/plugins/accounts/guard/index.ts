import type { Guard } from "@plugins/framework/plugins/tooling/plugins/guards/core";
import { CLAUDE_CREDENTIAL_ENVS } from "../core";

/**
 * An added account's credential — a token from `claude setup-token` or an API
 * key — can call the model but carries no claude.ai sign-in, so Claude Code silently leaves out what needs
 * one — Claude-in-Chrome and the claude.ai connectors — even with `--chrome`.
 * A missing tool is nothing an agent can call and fail on: it searches for it,
 * finds nothing, and guesses (the extension, the account, the browser). So the
 * moment it searches for Chrome in an added account's session, it is told why the
 * tools are absent and that only the user can fix it. Only then, never at
 * session start: most sessions never reach for Chrome.
 */
const guard: Guard<{ query?: string }> = {
  name: "chrome-needs-system-account",
  matcher: "ToolSearch",
  once: true,
  check: (input, ctx) =>
    CLAUDE_CREDENTIAL_ENVS.some((name) => process.env[name]) &&
    /chrome/i.test(input.query ?? "")
      ? ctx.inform(
          "This session runs on an added Claude account (a token or an API key), not the computer's own Claude Code login, so Claude-in-Chrome (mcp__claude-in-chrome__*) and the claude.ai connectors are not available in it — whatever the Chrome extension's state; reconnecting the extension does not help. If the task needs the user's own Chrome, tell them: switch to the system account (the Claude account picker in the health report's Claude Code row), then start a new conversation or restart this one. (Told once per session.)",
        )
      : ctx.allow(),
};

export default guard;
