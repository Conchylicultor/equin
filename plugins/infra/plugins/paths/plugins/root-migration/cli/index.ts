import { defineCliCommand } from "@plugins/framework/plugins/cli/core";

/**
 * `data-dir` is a GROUP: it routes and never runs. `migrate` moves an install
 * still on the legacy data root onto `~/.equin` — a one-shot the user runs from
 * a terminal while nothing else of the app is running. Design:
 * research/2026-10-26-global-equin-data-dir-migration-v2.md
 */
export default defineCliCommand({
  name: "data-dir",
  description: "Inspect or move this install's data root",
  subcommands: [
    defineCliCommand<[], { apply?: boolean; stopAgents?: boolean }>({
      name: "migrate",
      description:
        "Move the data root from the legacy home dir to its current one and relabel the gateway's service. " +
        "Prints the plan and changes nothing unless --apply. Refuses while any build, push, check, test " +
        "or e2e runs, while agents are open (unless --stop-agents), and when run by an agent: run it yourself, from a terminal.",
      options: [
        {
          flags: "--apply",
          description:
            "Execute the plan: stop the app (gateway, Postgres, PgBouncer, login services), move the root, rewrite every stored copy of the old path, then start the app again",
        },
        {
          flags: "--stop-agents",
          description:
            "Stop every open conversation's agent process with the app instead of refusing (an agent mid-turn loses that turn)",
        },
      ],
      // Its terminal may close while the app is stopped; the run must still
      // finish and start it again.
      detachable: true,
      run: () => import("./migrate"),
    }),
  ],
});
