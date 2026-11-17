import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "gateway-port:no-port-literal",
    paths: ["rust/src/gateway.rs"],
    kind: "sanctioned",
    reason:
      "LEGACY_PORT: the port of an install that has not moved off 9000 yet (no port file), the helper's one spelling of it — Rust cannot import the TypeScript owner.",
  },
] satisfies Exemptions;
