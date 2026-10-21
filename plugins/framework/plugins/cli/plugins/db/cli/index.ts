import { defineCliCommand } from "@plugins/framework/plugins/cli/core";

/**
 * `db` is a GROUP: it routes and never runs. The declaration union makes that
 * exclusive — a group has `subcommands` and cannot also carry `run` — so
 * `./singularity db` printing its own help rather than doing something is a
 * property of the shape, not of a runtime check.
 *
 * One subcommand today. It stays a group because the verb it reserves is
 * "worktree database operations", and the next one (drop, list, backup — the
 * operations `database/plugins/admin/server` already exports) is a file beside
 * `fork.ts` plus a line here. `fork --replace` is the supported way back for a
 * worktree database the migrations on disk can no longer apply to (the
 * runner names it when it refuses to boot).
 */
export default defineCliCommand({
  name: "db",
  description: "Worktree database operations",
  subcommands: [
    defineCliCommand<[string | undefined], { replace?: boolean }>({
      name: "fork",
      description:
        "Fork the main 'singularity' DB into [target]. For worktrees created " +
        "outside Singularity (git worktree add), which get no fork on creation. " +
        "Idempotent: a no-op if the DB already exists, unless --replace. " +
        "Requires a running backend (this worktree's, else main's) to read " +
        "which tables must not be copied.",
      arguments: [
        {
          name: "[target]",
          description: "database to create (defaults to the current worktree)",
        },
      ],
      options: [
        {
          flags: "--replace",
          description:
            "Drop [target] first and fork it afresh from main — for a worktree DB " +
            "whose migration state no longer matches the files on disk. Loses " +
            "every row only that DB has. Refused for main's DB.",
        },
      ],
      run: () => import("./fork"),
    }),
  ],
});
