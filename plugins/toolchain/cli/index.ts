import { defineCliCommand } from "@plugins/framework/plugins/cli/core";

export default defineCliCommand({
  name: "toolchain",
  description: "The mise toolchain (bun, go, rust, uv) this checkout runs",
  subcommands: [
    defineCliCommand<[], { tool?: string }>({
      name: "upgrade",
      description:
        "Alias of `./singularity deps upgrade mise`: move this worktree's mise.lock to the newest release of " +
        "each tool (skipping holds), proving it first: the full check and test suites plus each moved tool's " +
        "smoke tests run on the current versions, then on the new ones, and a failure only the new versions " +
        "have — and that happens again on a retry — is a regression. On a regression mise.lock is put back. " +
        "Writes deps-upgrade-mise.json in the worktree data dir. Refuses to run in the main checkout. " +
        "Takes about as long as two full check + test runs.",
      options: [
        {
          flags: "--tool <names>",
          description:
            "Comma-separated tools to consider (default: every tool). Use it to find which tool a regression comes from.",
        },
      ],
      run: () => import("./internal/upgrade"),
    }),
  ],
});
