import noAdhocImportScan from "./no-adhoc-import-scan";
import noHandImportResolution from "./no-hand-import-resolution";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

export default {
  name: "import-scan-safety",
  rules: {
    "no-adhoc-import-scan": noAdhocImportScan,
    "no-hand-import-resolution": noHandImportResolution,
  },
} satisfies LintContribution;
