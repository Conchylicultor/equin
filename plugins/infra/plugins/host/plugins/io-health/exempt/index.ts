import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "no-db-backed-notify",
    paths: ["machine/internal/served.ts"],
    kind: "sanctioned",
    reason:
      "host.io-health's truth is the I/O monitor's log file, which no change feed sees. The one Postgres access its loader reaches is filing a host-io-degraded report (reports/engine recordReport, which reads the reports table to dedupe) as a side effect of reading a degraded tick — never what the value answers.",
  },
] satisfies Exemptions;
