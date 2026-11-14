import { defineCliCommand } from "@plugins/framework/plugins/cli/core";

/**
 * `guard` is a GROUP: it routes and never runs. `bypass` lets ONE call a guard
 * refused through that guard — the hook records it (it alone knows the session
 * and agent); this verb checks the spelling and says what happens next.
 */
export default defineCliCommand({
  name: "guard",
  description: "Act on the Claude Code guards (core/guards)",
  subcommands: [
    defineCliCommand<[string], { reason?: string }>({
      name: "bypass",
      description:
        "Let the one call a guard just refused through that guard, once. Only when you are SURE the " +
        "call is safe and the block a false positive — never by default. Run it as its own tool call " +
        "with the id the denial printed, then retry the call unchanged.",
      arguments: [
        {
          name: "<id>",
          description: "The bypass id the denial printed (<guard>#<hash>)",
        },
      ],
      options: [
        {
          flags: "--reason <text>",
          description:
            "Why this exact call is safe — kept in the transcript for review",
        },
      ],
      run: () => import("./bypass"),
    }),
  ],
});
