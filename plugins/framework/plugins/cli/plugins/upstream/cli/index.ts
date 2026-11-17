import { defineCliCommand } from "@plugins/framework/plugins/cli/core";

/**
 * `./equin upstream status|merge` — the repo this checkout was cloned
 * from, read and (on request) merged in.
 *
 * A GROUP, like `db` and `deploy`: it routes and never runs, and the
 * declaration union makes "also runs" unspellable, so bare `upstream` prints
 * its subcommand help by construction.
 *
 * The command exists so the mechanical half of taking an update is ONE tested
 * path instead of prose an agent re-derives each time it is handed the job —
 * the same reason `toolchain upgrade` is a command rather than a checklist.
 *
 * The declaration is data; both bodies sit behind their own lazy `import()`,
 * so every other `./equin` invocation pays for this file alone.
 */
export default defineCliCommand({
  name: "upstream",
  description:
    "The repo this checkout was cloned from: whether it has cut a release you do not hold, and merging that release in",
  subcommands: [
    defineCliCommand<[], object>({
      name: "status",
      description:
        "Fetch upstream's main and release tags and print whether local main holds upstream's newest release. " +
        "Says so and exits 0 when there is no upstream (this checkout publishes to its own remote, " +
        "or has no remote at all) or upstream has cut no release. Reads only — nothing is merged and no ref of yours moves.",
      run: () => import("./status"),
    }),
    defineCliCommand<[], { continue?: boolean }>({
      name: "merge",
      description:
        "Fetch upstream and merge its newest release tag (never its main) into the branch this worktree is on, leaving any conflicts " +
        "in the tree to resolve. Refuses in the main checkout, on a dirty tree, and on a detached HEAD. " +
        "This is the one sanctioned merge in this repo — rebasing your own trunk onto upstream would " +
        "replay your whole history and rewrite main under every open worktree.",
      options: [
        {
          flags: "--continue",
          description:
            "Conclude a merge that stopped on conflicts, once every path is resolved and added: refuses " +
            "while anything is still unresolved or still carries conflict markers, then commits. It exists " +
            "so finishing a merge never needs a raw `git commit` — the one thing an agent must not run.",
        },
      ],
      run: () => import("./merge"),
    }),
  ],
});
