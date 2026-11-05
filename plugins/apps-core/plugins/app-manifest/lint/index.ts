import noResvgSystemFonts from "./no-resvg-system-fonts";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

export default {
  name: "app-manifest",
  rules: {
    "no-resvg-system-fonts": noResvgSystemFonts,
  },
} satisfies LintContribution;
