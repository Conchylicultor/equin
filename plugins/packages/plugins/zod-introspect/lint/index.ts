import noZodInternals from "./no-zod-internals";
import noZodSubpath from "./no-zod-subpath";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

/**
 * Lint barrel for zod-introspect. Both rules stay on in test files too: a test
 * building its schemas through `zod/v4` tests a version the app does not run,
 * and a test reading `_def` breaks at the next zod major like any other reader.
 */
export default {
  name: "zod-introspect",
  rules: {
    "no-zod-internals": noZodInternals,
    "no-zod-subpath": noZodSubpath,
  },
  enforceEverywhere: ["no-zod-internals", "no-zod-subpath"],
} satisfies LintContribution;
