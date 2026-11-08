import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "check-thread-safety/no-blocking-check-work",
    paths: ["check/config-registrations.ts", "check/overrides-authored.ts"],
    kind: "debt",
    task: "task-1793375830-dv7cez",
    reason:
      "Per-file synchronous work on the shared check thread (a blocking fs/process call made per item, or a direct maskSource / createSourceFile) that predates the rule; move it onto ctx.repo() / fs/promises and checks/core's maskedSource / parsedTsSource.",
  },
  {
    rule: "blocking-fs/sync-named",
    paths: ["core/internal/git-layer.ts"],
    kind: "debt",
    task: "task-1793991095-ppkf09",
    reason:
      "A backend loads this module, and its blocking functions do not carry the *Sync name yet: a method bound by an interface others implement, an async function that does sync work inside, or a cascade (data-root resolution) left for the redesign.",
  },
] satisfies Exemptions;
