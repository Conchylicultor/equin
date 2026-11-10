import noAdhocPaneTitle from "./no-adhoc-pane-title";
import noAdhocPaneToolbar from "./no-adhoc-pane-toolbar";
import noCoreDefineRouteInWeb from "./no-core-define-route-in-web";
import noPaneHeaderBar from "./no-pane-header-bar";
import noHintFabrication from "./no-hint-fabrication";
import noRawLocationPath from "./no-raw-location-path";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

/**
 * Lint barrel for the pane rules. The root `eslint.config.ts` auto-discovers this
 * default export and registers each rule repo-wide as `error`.
 *
 * `no-adhoc-pane-title` and `no-hint-fabrication` are closed (no exemption is
 * accepted); a deliberate per-site override escapes via
 * `// eslint-disable-next-line <rule> -- reason`:
 *
 * - `no-adhoc-pane-title` is precise — it fires only on a `<Text variant>` in the
 *   JSX a same-file `Pane.define({ title: { component } })` component returns.
 * - `no-hint-fabrication` is precise — it fires only on a `Hint` receiver's
 *   `pick()` (a `useHint()`-sourced or `Hint<…>`-typed binding).
 * - `no-core-define-route-in-web` is precise — it fires only on the
 *   `defineRoute` VALUE, only on the pane core barrel's cross-plugin specifier,
 *   only in a `web/` runtime folder. The one tree that legitimately addresses
 *   the core barrel from `web/` is the pane plugin's own (`exempt/index.ts`).
 *
 * - `no-pane-header-bar` is precise — it fires only on a `<Bar tier="pane">`
 *   element; the pane plugin's own tree is exempt (`exempt/index.ts`), and a
 *   sanctioned pane-tier strip elsewhere exempts itself. It admits no debt.
 *
 * `no-adhoc-pane-toolbar` and `no-raw-location-path` have exemptions of their
 * own in the declaring plugins' `exempt/index.ts`.
 */
export default {
  name: "pane",
  rules: {
    "no-adhoc-pane-title": noAdhocPaneTitle,
    "no-hint-fabrication": noHintFabrication,
    "no-core-define-route-in-web": noCoreDefineRouteInWeb,
    "no-raw-location-path": noRawLocationPath,
    "no-pane-header-bar": noPaneHeaderBar,
  },
  // Class rules are FACTORIES: they read class tokens, so they take the one
  // shared walk from `buildLintConfig` instead of hand-copying it. See
  // @plugins/framework/plugins/tooling/plugins/lint/core/class-token-walk.ts.
  classRules: {
    "no-adhoc-pane-toolbar": noAdhocPaneToolbar,
  },
  noDebt: ["no-pane-header-bar"],
  closed: ["no-adhoc-pane-title", "no-hint-fabrication"],
} satisfies LintContribution;
