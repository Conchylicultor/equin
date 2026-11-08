import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "blocking-fs/sync-named",
    paths: ["shared/stale-holder.ts"],
    kind: "debt",
    task: "task-1793991095-ppkf09",
    reason:
      "A backend loads this module, and its blocking functions do not carry the *Sync name yet: a method bound by an interface others implement, an async function that does sync work inside, or a cascade (data-root resolution) left for the redesign.",
  },
  {
    rule: "sql-writes:fit:hand-written",
    paths: ["shared/recorder.ts", "shared/stale-holder.ts"],
    kind: "sanctioned",
    reason:
      "The ./equin build CLI writes build_runs before its own migration is applied, and cannot load the table definition (defineEntity's codegen manifest is not loadable in the regenerating build). drizzle's insert names every column of the definition, so the CLI names only its own columns by hand — see this plugin's CLAUDE.md, 'The CLI's INSERT names its own columns'.",
  },
] satisfies Exemptions;
