import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "endpoints/no-void-fetch-endpoint",
    paths: ["web/internal/toast.ts"],
    kind: "sanctioned",
    reason:
      "Secondary DB persistence of a toast already shown via Shell.Toast.",
  },
] satisfies Exemptions;
