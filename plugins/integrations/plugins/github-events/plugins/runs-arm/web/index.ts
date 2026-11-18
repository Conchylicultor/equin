import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { investigateRuns, runLinks } from "@plugins/runs/web";
import { RELEASE_CATEGORY_ID } from "@plugins/release/core";
import { githubRunArm } from "../core";
import { githubRunLink } from "./internal/link";
import { githubRunPresentation } from "./internal/presentation";

export default {
  description:
    "The GitHub arm's presence on the merged run surface: a row opens its run on GitHub, a failed one offers Investigate, and the workflow / ref / repository / commit / status columns only a GitHub run has (off by default — the label says the workflow and ref).",
  contributions: [
    runLinks(githubRunArm, githubRunLink),
    githubRunPresentation,
    // A failed publish's Investigate action, in every list of runs — filed
    // under Release: every watched workflow publishes something a release
    // ships (the installer, the embedded packages).
    investigateRuns(githubRunArm, {
      noun: "GitHub run",
      categoryId: RELEASE_CATEGORY_ID,
      whereToDig: (run) => {
        const own = githubRunArm.read(run);
        return [
          own === null
            ? "the run on GitHub (Actions tab of its repository);"
            : `the run on GitHub: ${own.url} — \`gh run view ${own.url.split("/").pop() ?? ""} -R ${own.repo} --log-failed\` prints the failed steps' logs;`,
          `the ledger row: \`select * from github_runs where id = '${run.id}'\` via \`query_db\` (failed_jobs lists each failed job and step);`,
          "the workflow file under `.github/workflows/`, and the watch that follows it (`GitHubEvents.Watch` contributions — its remedy line says how to re-run a release publish).",
        ];
      },
    }),
  ],
} satisfies PluginDefinition;
