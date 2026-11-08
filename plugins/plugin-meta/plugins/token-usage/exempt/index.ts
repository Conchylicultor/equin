import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: ["core/token-usage.ts"],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
  {
    rule: "marker-scan-safety/no-adhoc-marker-scan",
    paths: ["core/token-usage.ts"],
    kind: "sanctioned",
    reason:
      "Token-in-string: the token scanner reads the Tailwind classes a plugin spells, which live inside string literals (a className, a cn() argument) with no enclosing marker call — a full mask would erase them. Only comments (and regex literals) are blanked, so a class named in prose is no use.",
  },
  {
    rule: "blocking-fs/sync-named",
    paths: ["core/token-usage.ts"],
    kind: "sanctioned",
    reason:
      "Host tooling only: no backend loads this module (blocking-fs:sync-named-reach measures the backends' import graph), so its blocking helpers hold only the CLI's, a check's or a script's own thread.",
  },
] satisfies Exemptions;
