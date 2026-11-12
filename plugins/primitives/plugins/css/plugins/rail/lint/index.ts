import noAdhocBand from "./no-adhoc-band";
import noPadUnderOwner from "./no-pad-under-owner";
import noPanelBleed from "./no-panel-bleed";
import noUnownedOverlay from "./no-unowned-overlay";

/**
 * Lint barrel for the rail contract. The root `eslint.config.ts` auto-discovers
 * this default export and registers the rule repo-wide as `error`.
 *
 * `no-panel-bleed` closes the one hole the contract itself opened: removing
 * `DialogContent.padded` made `className="rail-bleed"` the attractive
 * substitute, and it half-works (see the rule). Bleeding a panel is never
 * correct — the panel IS the region — so this needs no allowlist, and should
 * never grow one. A band inside the panel bleeds; the panel does not.
 *
 * The three region-owner rules (research/2026-11-09-global-surface-owned-inset.md)
 * are narrow on purpose — each names its replacement: `no-unowned-overlay`
 * (a `padding="none"` overlay → a step + header/footer/Band), `no-adhoc-band`
 * (a `border-b px-* py-*` strip → header/footer/Band), `no-pad-under-owner`
 * (padding on content a region owner already insets → delete it).
 */
export default {
  name: "rail",
  rules: {
    "no-unowned-overlay": noUnownedOverlay,
  },
  // Class rules are FACTORIES: they read class tokens, so they take the one
  // shared walk from `buildLintConfig` instead of hand-copying it. See
  // @plugins/framework/plugins/tooling/plugins/lint/core/class-token-walk.ts.
  classRules: {
    "no-panel-bleed": noPanelBleed,
    "no-adhoc-band": noAdhocBand,
    "no-pad-under-owner": noPadUnderOwner,
  },
};
