import noAdhocNewTab from "./no-adhoc-new-tab";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

/**
 * Lint barrel for the new-tab primitive. The root `eslint.config.ts`
 * auto-discovers this default export and registers each rule repo-wide as
 * `error`.
 *
 * `no-adhoc-new-tab` is closed (no exemption manifest): the primitive's own
 * read carries a per-site disable, and so must any other — which is the point.
 */
export default {
  name: "new-tab",
  rules: {
    "no-adhoc-new-tab": noAdhocNewTab,
  },
  closed: ["no-adhoc-new-tab"],
} satisfies LintContribution;
