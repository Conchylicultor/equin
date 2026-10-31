import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "namespace:no-hand-built-url",
    paths: ["core/namespace.ts", "check/index.ts"],
    kind: "sanctioned",
    reason:
      "The owner of the host grammar, its tests, and this check, which names the pattern it bans.",
  },
  {
    rule: "namespace:legacy-host",
    paths: ["core/namespace.test.ts"],
    kind: "sanctioned",
    reason:
      "Pins that main's old address is not a host: a labelled namespace's own name reaches nothing.",
  },
  {
    rule: "product-name:legacy-id",
    paths: ["core/namespace.test.ts"],
    kind: "sanctioned",
    reason:
      "Pins that main's old address is not a host: a labelled namespace's own name reaches nothing.",
  },
] satisfies Exemptions;
