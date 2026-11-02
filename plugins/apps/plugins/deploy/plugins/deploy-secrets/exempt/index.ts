import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "user-path/no-unproven-claim",
    paths: ["machine/internal/read-credential.ts"],
    kind: "sanctioned",
    reason:
      "systemd's per-unit credentials directory (CREDENTIALS_DIRECTORY), set by systemd for the unit.",
  },
] satisfies Exemptions;
