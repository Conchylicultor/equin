import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "endpoints/no-raw-web-fetch",
    paths: ["web/internal/load-probe.ts"],
    kind: "sanctioned",
    reason:
      "The load probe asks the gateway for the HTTP status of this tab's own static module files (`/artifacts/<name>/<file>`, HEAD) after a module load failed — that status IS the fact it reports (a 404 vs a network error vs a 5xx). No endpoint or live read can stand in: those answer from the backend, not from the file server the failed import hit.",
  },
] satisfies Exemptions;
