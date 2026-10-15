import noUnanimatedDisclosure from "./no-unanimated-disclosure";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

/**
 * Lint barrel for the collapsible primitive. The root `eslint.config.ts`
 * auto-discovers this default export and registers each rule repo-wide as
 * `error`.
 *
 * `no-unanimated-disclosure` rejects disclosure content gated by a bare
 * conditional on an open/expanded boolean (`{open && <Body/>}`), which mounts
 * and unmounts with no fold motion — the content belongs in `FoldMotion` /
 * `CollapsibleContent`. A genuine exception is declared by the owning plugin in
 * its `exempt/index.ts`.
 */
export default {
  name: "collapsible",
  rules: {
    "no-unanimated-disclosure": noUnanimatedDisclosure,
  },
} satisfies LintContribution;
