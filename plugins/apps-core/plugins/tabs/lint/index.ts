import noFreeAppNavInReact from "./no-free-app-nav-in-react";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

/**
 * Lint barrel for the tabs rules. The root `eslint.config.ts` auto-discovers
 * this default export and registers each rule repo-wide as `error`.
 *
 * `no-free-app-nav-in-react` is closed (no exemption is accepted): the hook
 * forms behave exactly as the free ones outside an embed, so there is no
 * component the free form is right for.
 */
export default {
  name: "tabs",
  rules: {
    "no-free-app-nav-in-react": noFreeAppNavInReact,
  },
  closed: ["no-free-app-nav-in-react"],
} satisfies LintContribution;
