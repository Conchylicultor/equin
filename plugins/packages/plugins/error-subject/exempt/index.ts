import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "error-subject/crash-fields-of",
    paths: ["core/internal/error-subject.ts"],
    kind: "sanctioned",
    reason:
      "crashFieldsOf itself: the one place an error's type and stack are read into crash fields, beside the subject it derives.",
  },
] satisfies Exemptions;
