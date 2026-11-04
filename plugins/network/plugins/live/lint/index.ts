import noClockInServed from "./no-clock-in-served";
import noEndpointRead from "./no-endpoint-read";
import noGrowInEffect from "./no-grow-in-effect";
import noLegacyResourceSpelling from "./no-legacy-resource-spelling";
import noRowAbsenceCollapse from "./no-row-absence-collapse";
import noSentinelParam from "./no-sentinel-param";
import visibleRangeMinter from "./visible-range-minter";
import whereDeclared from "./where-declared";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

export default {
  name: "live",
  rules: {
    "no-clock-in-served": noClockInServed,
    "no-endpoint-read": noEndpointRead,
    "no-grow-in-effect": noGrowInEffect,
    "no-legacy-resource-spelling": noLegacyResourceSpelling,
    "no-row-absence-collapse": noRowAbsenceCollapse,
    "no-sentinel-param": noSentinelParam,
    "visible-range-minter": visibleRangeMinter,
    "where-declared": whereDeclared,
  },
  noDebt: [
    "no-clock-in-served",
    "no-endpoint-read",
    "no-row-absence-collapse",
    "where-declared",
  ],
} satisfies LintContribution;
