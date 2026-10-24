import type { Guard } from "@plugins/framework/plugins/tooling/plugins/guards/core";

/**
 * Claude-in-Chrome is enabled for every app-launched agent (the sdk runtime
 * passes `--chrome`), but it is the user's one real Chrome, on their screen,
 * signed into their accounts. So the first time an agent reaches for it, it is
 * told once to use the agent browser instead unless it truly needs that Chrome.
 * An inform, not a denial: the valid uses are real, and the agent decides.
 */
const guard: Guard = {
  name: "prefer-agent-browser",
  matcher: "mcp__claude-in-chrome__*",
  once: true,
  check: (_input, ctx) =>
    ctx.inform(
      [
        "You are using Claude-in-Chrome: the user's own Chrome, on their screen, with their real accounts. Default to the equin agent browser instead — the `mcp__equin__browser_*` tools (load them with ToolSearch): a headless tab of your own that stays open across calls; a route (`/agents/…`) opens your own build, an absolute URL any site.",
        "",
        "Use Claude-in-Chrome only when the task needs THAT browser: the user's sign-ins, a state they have open, a demo they are watching, or the user asked for it. Otherwise switch to `browser_*` now. (Told once per session.)",
      ].join("\n"),
    ),
};

export default guard;
