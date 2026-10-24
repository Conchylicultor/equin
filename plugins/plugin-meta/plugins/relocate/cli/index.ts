import { defineCliCommand } from "@plugins/framework/plugins/cli/core";

/**
 * `./equin plugin move <from> <to>` — relocating or renaming a plugin as
 * ONE tested step instead of a bespoke sed session per move.
 *
 * `plugin` is a GROUP: it routes and never runs, so bare `./equin plugin`
 * prints its subcommand help by construction. The declaration is data; the
 * body sits behind its own lazy `import()`, so every other `./equin`
 * invocation pays for this file alone (`cli:command-declarations-light`).
 */
export default defineCliCommand({
  name: "plugin",
  description: "Operations on the plugin tree itself",
  subcommands: [
    defineCliCommand<[string, string], { dryRun?: boolean }>({
      name: "move",
      description:
        "Move or rename a plugin and every descendant. Each of <from> and <to> is a path " +
        "(plugins/a/plugins/b) or a dot id (a.b); a rename is a move to a new basename. " +
        "Finds every reference first (path literals, @plugins specifiers, dot ids, relative " +
        "markdown/CSS links — the plugin-refs locator the checks validate), then `git mv`s the " +
        "plugin dir and its config/ dir, rewrites each reference by its exact range, and " +
        "re-derives the moved package.json names. Refuses in the main checkout, on a dirty tree, " +
        "when <to> exists, sits inside <from>, or has a parent that is not a plugin. Records the " +
        "move in the plugin-move ledger, from which each namespace's next build moves its saved " +
        "settings. Registries and docs are left to " +
        "`./equin build`; run `./equin check` after it.",
      arguments: [
        { name: "<from>", description: "the plugin to move: path or dot id" },
        { name: "<to>", description: "where it goes: path or dot id" },
      ],
      options: [
        {
          flags: "--dry-run",
          description:
            "Print the plan — renames, per-kind edit counts, per-file edits, package names, " +
            "warnings — and change nothing. Allowed on a dirty tree.",
        },
      ],
      run: () => import("./move"),
    }),
  ],
});
