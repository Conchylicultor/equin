import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "investigate:failures-registered",
    paths: ["shared/resources.ts"],
    kind: "sanctioned",
    reason:
      "A server's reachability verdict (`ok: false`) is host state the user repairs through the SSH-setup section's own guided flow (key, host key, verify), not a code failure to brief an agent on.",
  },
] satisfies Exemptions;
