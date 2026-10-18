import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "namespace:no-hand-built-url",
    paths: ["server/internal/ssrf.ts"],
    kind: "sanctioned",
    reason:
      "The SSRF guard refuses the .localhost suffix because it RESOLVES TO LOOPBACK — a question about where a URL points, not which namespace it names. It must keep refusing these hosts however the namespace scheme changes.",
  },
  {
    rule: "boundaries/no-platform-api",
    paths: ["server/internal/ssrf.ts"],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
] satisfies Exemptions;
