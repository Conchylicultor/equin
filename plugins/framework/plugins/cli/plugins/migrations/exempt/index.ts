import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "spawn-safety/no-raw-bun-spawn",
    paths: ["cli/migrations-interactive.ts"],
    kind: "sanctioned",
    reason:
      "drizzle-kit's interactive create-vs-rename prompts must be parsed from live stdout while keystrokes are written back to stdin, which is impossible over after-exit temp files.",
  },
  {
    rule: "imperative-create-table-allowlisted",
    paths: ["cli/branch-answers.ts", "cli/branch-answers.test.ts"],
    kind: "sanctioned",
    reason:
      "Reads the CREATE statements a branch's drizzle migrations already contain, to answer a regen's create-vs-rename prompts; it creates no table — the pattern and the test fixtures only spell the token.",
  },
] satisfies Exemptions;
