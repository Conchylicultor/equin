import noEndpointRead from "./no-endpoint-read";
import noGrowInEffect from "./no-grow-in-effect";
import noLegacyResourceSpelling from "./no-legacy-resource-spelling";
import noSentinelParam from "./no-sentinel-param";
import visibleRangeMinter from "./visible-range-minter";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

export default {
  name: "live",
  rules: {
    "no-endpoint-read": noEndpointRead,
    "no-grow-in-effect": noGrowInEffect,
    "no-legacy-resource-spelling": noLegacyResourceSpelling,
    "no-sentinel-param": noSentinelParam,
    "visible-range-minter": visibleRangeMinter,
  },
} satisfies LintContribution;
