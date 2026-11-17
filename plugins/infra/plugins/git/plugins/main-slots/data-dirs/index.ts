import { defineDataDir } from "@plugins/infra/plugins/paths/core";

/**
 * Main's slot pool: one linked worktree of the repo per slot (`<id>/`, each
 * with its own `node_modules`), and `current/`, one link per app main serves
 * (`current/<namespace>`) to the slot it is served from. See this plugin's
 * CLAUDE.md.
 *
 * `services`: what the main backend, central and their children run from —
 * like the sockets and the Postgres cluster, live while anything runs.
 */
export const mainSlotsDataDir = defineDataDir({
  kind: "services",
  name: "main-slots",
  owner: "infra/git/main-slots",
  description:
    "Main's per-commit slots: linked worktrees of the repo detached at one commit each, the code main's backend, its compositions', central and their children run from, and `current/<namespace>`, one link per served app to its slot",
  // Every slot is re-derivable (a checkout of a commit plus an install), but
  // the served one is what main's processes have open: deleting it while they
  // run pulls code out from under them. Once nothing runs, the next build
  // recreates what it needs.
  reclaim: { kind: "restart" },
  notLogs: [
    {
      pattern: "*",
      reason:
        "a slot is a checkout of the repo (sources, node_modules): any *.log / *.jsonl in it is a tracked fixture or a package's file, not a log this app grows",
    },
  ],
});

/**
 * The dir inside {@link mainSlotsDataDir} of `current` links, one per app,
 * named by its namespace — part of the dir's layout, so a reader that may not
 * load this plugin's core (the launcher, which passes main's link to the
 * gateway as `-main-slots-current`) names it from the declaration too.
 */
export const MAIN_SLOTS_CURRENT_DIR = "current";

export default [mainSlotsDataDir];
