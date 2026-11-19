import { defineCliCommand } from "@plugins/framework/plugins/cli/core";

/**
 * Deliberately takes paths and NOTHING else — no `--watch`, no `-t`, no runner
 * selection. Every flag this command could forward is a flag that reaches one
 * runner, and reaching one runner is exactly the green-but-partial result the
 * command exists to prevent.
 */
export default defineCliCommand<[string[]], object>({
  name: "test",
  // Its process tree can take gigabytes: on Linux it runs in an op scope of
  // its own, apart from the gateway's unit (`heavy`, cli/core command.ts).
  heavy: true,
  description:
    "Run the tests under the given paths with BOTH runners: `bun test` for the " +
    "co-located pure-logic suites and `vitest run` for the jsdom suites under " +
    "`web/__tests__/`. The two are scoped apart (bunfig.toml's " +
    "`pathIgnorePatterns` is the exact complement of vitest.config.ts's " +
    "`include`), so either runner alone is correct but PARTIAL — it reports " +
    "green while the other half never ran. This is the one command that runs " +
    "both and says which of them had anything to do.",
  arguments: [
    {
      name: "[paths...]",
      description:
        "Files or directories to test (default: the whole `plugins` tree)",
    },
  ],
  run: () => import("./run"),
});
