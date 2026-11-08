import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: ["core/internal/writer.ts"],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
  {
    rule: "blocking-fs/sync-named",
    paths: ["core/internal/writer.ts"],
    kind: "debt",
    task: "task-1793991095-ppkf09",
    reason:
      "A backend loads this module, and its blocking functions do not carry the *Sync name yet: a method bound by an interface others implement, an async function that does sync work inside, or a cascade (data-root resolution) left for the redesign.",
  },
] satisfies Exemptions;
