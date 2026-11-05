import noAdhocRepoListing from "./no-adhoc-repo-listing";
import noAdhocRepoWalk from "./no-adhoc-repo-walk";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

export default {
  name: "repo-walk-safety",
  rules: {
    "no-adhoc-repo-listing": noAdhocRepoListing,
    "no-adhoc-repo-walk": noAdhocRepoWalk,
  },
  // A pass root lists the repo once and hands the set down: a `cli/` command,
  // a `bin/` entry point, a script.
  outOfScope: {
    "no-adhoc-repo-listing": ["cli", "bin", "script"],
  },
} satisfies LintContribution;
