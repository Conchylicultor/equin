import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "no-raw-event-source",
    paths: ["web/__tests__/request-guard.test.ts"],
    kind: "sanctioned",
    reason:
      "The guard's own test: it constructs a raw EventSource to prove the guard refuses one.",
  },
  {
    rule: "no-raw-websocket",
    paths: ["web/__tests__/request-guard.test.ts"],
    kind: "sanctioned",
    reason:
      "The guard's own test: it constructs raw WebSockets to prove the guard refuses a same-origin one and passes any other.",
  },
] satisfies Exemptions;
