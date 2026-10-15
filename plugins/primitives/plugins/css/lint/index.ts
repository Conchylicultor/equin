import noAdhocLayout from "./no-adhoc-layout";
import noUniversalHas from "./no-universal-has";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

/**
 * Lint barrel for the `no-adhoc-layout` rule. The root `eslint.config.ts`
 * auto-discovers this default export and registers `no-adhoc-layout` repo-wide
 * as `error`.
 *
 * Layout composition routes through the layout primitives —
 * `<Stack>`/`<Cluster>`/`<Row>` (rows), `<Grid>`/`<Center>`/`<Overlay>`
 * (@plugins/primitives/plugins/css/plugins/*), `<Stack>`/`<Inset>`
 * (@plugins/primitives/plugins/css/plugins/spacing/web), and `<Text>` inside a line
 * container (the only home for `min-w-0`) — never raw `flex`/`grid`/`items-*`/`absolute`/`overflow-*`.
 *
 * The layout primitives THEMSELVES own the raw mechanics the rule redirects to
 * (they ARE the implementation); each declares that in its own `exempt/index.ts`.
 * A genuinely-fixed one-off escapes per-site, travelling with the code:
 *
 *   // eslint-disable-next-line layout/no-adhoc-layout -- <reason>
 */
export default {
  name: "layout",
  rules: {},
  // Class rules are FACTORIES: they read class tokens, so they take the one
  // shared walk from `buildLintConfig` instead of hand-copying it. See
  // @plugins/framework/plugins/tooling/plugins/lint/core/class-token-walk.ts.
  classRules: {
    "no-adhoc-layout": noAdhocLayout,
    "no-universal-has": noUniversalHas,
  },
} satisfies LintContribution;
