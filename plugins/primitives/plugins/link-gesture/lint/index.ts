import noClickNavigate from "./no-click-navigate";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

/**
 * Lint barrel for the link-gesture rules. The root `eslint.config.ts`
 * auto-discovers this default export and registers each rule repo-wide as
 * `error`.
 *
 * `no-click-navigate` is closed (no exemption is accepted): it fires only on a
 * callback whose WHOLE job is one navigating call, so a genuine non-link
 * escapes per site via
 * `// eslint-disable-next-line link-gesture/no-click-navigate -- reason`.
 */
export default {
  name: "link-gesture",
  rules: {
    "no-click-navigate": noClickNavigate,
  },
  closed: ["no-click-navigate"],
} satisfies LintContribution;
