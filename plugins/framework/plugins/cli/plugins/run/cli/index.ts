import { defineCliCommand } from "@plugins/framework/plugins/cli/core";

/**
 * The correct spelling of "run a repo script", and the reason it is a command
 * rather than a convention.
 *
 * Module resolution walks UP the directory tree, and worktrees live under the
 * main checkout — so `bun plugins/…/e2e/foo.ts` from a worktree with no
 * `node_modules` of its own silently resolves every dependency out of the MAIN
 * checkout's installed tree, or, if that tree is absent or mid-replacement, out
 * of bun's auto-install, which ignores `bun.lock` and every pin and fetches
 * registry `latest`. A branch that bumps a dependency does not get its bump.
 *
 * `bin/index.ts` runs `ensureDeps()` before dispatch on every invocation, so
 * routing a script through a CLI verb is what buys it this worktree's own
 * `node_modules`, installed from this branch's lock, plus the postinstall
 * provisioning that goes with it (~140 ms on the fresh-stamp path).
 *
 * Deliberately ONE general verb, not `./equin e2e`. The defect is not
 * e2e-specific — the `scripts/` directories under `plugins/` hold a dozen more
 * runnable scripts, one of which writes to the database through `drizzle-orm`
 * — and an e2e script is just a script.
 */
export default defineCliCommand<[string, string[]], object>({
  name: "run",
  description:
    "Run a repo script (.ts/.tsx/.js/.jsx, and the .mts/.cts/.mjs/.cjs forms) " +
    "with THIS worktree's own dependencies. " +
    "Never `bun <file>`: module resolution walks up the tree, so a worktree " +
    "without its own `node_modules` runs against the main checkout's installed " +
    "tree — or, if that is missing, against bun's auto-install, which ignores " +
    "`bun.lock` and fetches registry `latest`. This command installs first " +
    "(`ensureDeps`, ~140 ms when already fresh), then runs the script with " +
    "every following argument passed through untouched.",
  arguments: [
    {
      name: "<script>",
      description:
        "Path to a script module inside this checkout (repo-root-relative or absolute)",
    },
    {
      name: "[args...]",
      description: "Arguments forwarded to the script verbatim, flags included",
    },
  ],
  // Everything after <script> belongs to the script, `--headed` and `--help`
  // alike. Without this commander claims them and rejects the invocation.
  passthroughArgs: true,
  run: () => import("./run"),
});
