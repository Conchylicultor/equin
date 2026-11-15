import { defineCliCommand } from "@plugins/framework/plugins/cli/core";

/**
 * The body of the daily `web-artifacts.blocker-scan` job (`../server`), which
 * runs it as its supervised child's argv. A command rather than a `run` body
 * so the web-artifact CLI barrel and the dependency engine stay in the CLI's
 * closure, never the serving backend's.
 *
 * `detachable`: a supervised child is spawned detached, and the orphan guard
 * would otherwise exit it the moment it found no invoking shell.
 */
export default defineCliCommand<[], { dryRun?: boolean }>({
  name: "web-artifacts-blocker-scan",
  description:
    "Check every URL main serves against the default content-blocker rules (uBlock Origin Lite's default lists) and file a report per hit (what the daily web-artifacts.blocker-scan job runs)",
  options: [
    {
      flags: "--dry-run",
      description: "print the hits without filing reports",
    },
  ],
  detachable: true,
  run: () => import("./run"),
});
