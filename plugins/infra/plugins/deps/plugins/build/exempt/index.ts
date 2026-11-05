import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "repo-walk-safety/no-adhoc-repo-listing",
    paths: ["deps/internal/build.ts"],
    kind: "sanctioned",
    reason:
      "A built dependency's identity: the files its declared input globs match, listed (pathspec-scoped) when the identity is derived \u2014 no pass holds a set there (an install, `./equin start`).",
  },
] satisfies Exemptions;
