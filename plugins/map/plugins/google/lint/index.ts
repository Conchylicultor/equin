import mapsJsLibraries from "./maps-js-libraries";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

export default {
  name: "map-google",
  rules: {
    "maps-js-libraries": mapsJsLibraries,
  },
} satisfies LintContribution;
