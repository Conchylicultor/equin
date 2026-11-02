import partialBarrelMock from "./partial-barrel-mock";
import noHoistedImportRead from "./no-hoisted-import-read";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

export default {
  name: "vitest-mock-safety",
  rules: {
    "partial-barrel-mock": partialBarrelMock,
    "no-hoisted-import-read": noHoistedImportRead,
  },
} satisfies LintContribution;
