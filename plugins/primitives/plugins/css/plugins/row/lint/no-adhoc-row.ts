import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { LintToolkit } from "@plugins/framework/plugins/tooling/plugins/lint/core";

const createRule = lintRuleCreator(import.meta.url);

/**
 * Ad-hoc interactive-row markup — an intrinsic `<span>/<div>/<button>/<a>` styled
 * with a `rounded` corner plus small `px-`/`py-` padding AND an interactive signal
 * (`w-full` / `text-left` / `hover:bg-`) — reinvents the row/menu/section-header
 * shape the Row primitives (Row, SectionHeaderRow) exist to close, or the ghost
 * button / tab shape Button/IconButton/SegmentedControl already own. This rule
 * fingerprints that shape and redirects to a sanctioned primitive. There is no
 * auto-fix: choosing Row vs Button vs SegmentedControl, mapping props, and adding
 * an import are all unsafe to mechanize.
 *
 * This is the exact *complement* of `badge/no-adhoc-chip`: the chip rule fires on
 * the same rounded+small-padding shape but EXCLUDES the interactive signals; this
 * rule claims exactly that excluded set. The predicates are complementary so no
 * element ever trips both rules.
 *
 * Like the chip rule, the row fingerprint is a *co-occurrence* of several classes
 * that may live in different `cn()` fragments. So we aggregate every class token
 * of one `className` attribute into a single Set, then test the fingerprint
 * against that Set.
 *
 * ## Fingerprint B — the `Row`-minus-`Row` copy
 *
 * Fingerprint A above cannot see the case where someone reproduces `Row`'s chrome
 * *using `Row`'s own padding token*, on a component host tag. It escapes twice:
 * `HOST_TAGS` skips capitalized tags (`<Line as="button">`), and `NAMED_PAD`
 * treats `p-row` as a sanctioned escape.
 *
 * `p-row` is `Row`'s padding. Paired with a hover tint (or `w-full` + `text-left`)
 * on anything that is not `Row` itself, it *is* the row shape — so B fires on any
 * tag, before A's exclusions run.
 *
 * This exists because the escape has been taken: `PanelActionRow` hand-copied
 * `Row`'s chrome for real, to route around an import cycle
 * (`Row → row-actions → IconButton → action-presentation`). A cycle error says
 * "break an edge"; it does not say "and you may not pay for it by retyping
 * `Row`". This rule says the second half. If you land here, break the edge —
 * don't copy the classes.
 *
 * `row/web/**` is the one path exemption (`lint/index.ts`): the primitive owns
 * its own mechanics, and no class-level test can tell the original from an exact
 * copy. Same precedent as `no-adhoc-layout`'s permanent primitive globs.
 */

// rounded corner: `rounded`, `rounded-md`, `rounded-full`, …
const ROUNDED = /^rounded(-|$)/;
// small horizontal pad — EXACT membership (wider than the chip rule: px→3 to
// catch tabs `px-3 py-1.5` and ghost buttons). Must NOT match `px-4`.
const SMALL_PX = new Set([
  "px-0.5",
  "px-1",
  "px-1.5",
  "px-2",
  "px-2.5",
  "px-3",
]);
// small vertical pad — EXACT membership (wider than the chip rule: py→2).
const SMALL_PY = new Set(["py-px", "py-0.5", "py-1", "py-1.5", "py-2"]);
// interactive-row marker: any `hover:bg-*` (menus/list rows, not chips).
const HOVER_BG = /^hover:bg-/;
// named padding token (e.g. `p-row`, `p-card`, `p-chip`) — the sanctioned
// token escape. Defensive: such tokens preclude raw px/py anyway, but listing
// them documents the escape hatch. `p-[a-z]` avoids matching numeric `p-2`.
const NAMED_PAD = /^p-[a-z]/;
// `Row`'s OWN padding token — a sanctioned escape for fingerprint A, and the
// positive signal for fingerprint B. `p-card` / `p-chip` stay pure escapes.
const P_ROW = "p-row";

const HOST_TAGS = new Set(["span", "div", "button", "a"]);

export default function buildRule({ collectTokens }: LintToolkit) {
  return createRule({
    name: "no-adhoc-row",
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow ad-hoc interactive-row markup (rounded + small px/py + w-full/text-left/hover:bg- on a span/div/button/a) — use a sanctioned primitive (Row/SectionHeaderRow, Button/IconButton, SegmentedControl).",
      },
      schema: [],
      messages: {
        adhocRow:
          "Ad-hoc interactive control (rounded + small px/py + `w-full`/`text-left`/`hover:bg-` on a " +
          "span/div/button/a) — route through a primitive: `Row`/`SectionHeaderRow` (list, menu, nav, " +
          "tree, and collapsible section-header rows), `Button`/`IconButton` (single actions), or " +
          "`SegmentedControl` (tab / segment groups). If intentionally bespoke (positioned overlay, " +
          "a primitive's own internals), render through a component, use a named padding token " +
          "(`p-chip`/`p-card`), or `// eslint-disable-next-line row/no-adhoc-row -- <reason>`.",
        rowCopy:
          "This rebuilds `Row` out of `Row`'s own padding token (`p-row` + a hover tint / " +
          "`w-full`+`text-left`) — compose `Row` (`primitives/css/row`) instead. If you are here " +
          "because `Row` is unreachable from this plugin, that is an import-cycle problem: break " +
          "the offending edge rather than retyping the chrome.",
      },
    },
    defaultOptions: [],
    create(context) {
      return {
        JSXAttribute(node) {
          // Only `className` attributes.
          if (
            node.name.type !== "JSXIdentifier" ||
            node.name.name !== "className"
          )
            return;

          // Aggregate every class token of this attribute into one Set.
          const tokens = new Set<string>();
          collectTokens(context.sourceCode, node.value, tokens);

          // Fingerprint B — the `Row`-minus-`Row` copy. Runs FIRST, on any host
          // tag, and before A's `p-row` exclusion: `p-row` is precisely the signal
          // here, not an escape.
          if (tokens.has(P_ROW)) {
            let bHover = false;
            let bWFull = false;
            let bTextLeft = false;
            for (const t of tokens) {
              if (HOVER_BG.test(t)) bHover = true;
              if (t === "w-full") bWFull = true;
              if (t === "text-left") bTextLeft = true;
            }
            if (bHover || (bWFull && bTextLeft)) {
              context.report({ node, messageId: "rowCopy" });
              return;
            }
          }

          // Host-tag gate: a JSXAttribute's parent is always the JSXOpeningElement.
          // Require an intrinsic host tag in {span, div, button, a}. This skips
          // component elements (`<Row>`, `<Foo>` — capitalized, render through a
          // primitive) and other intrinsics (`<code>`, `<input>`) for free.
          const tag = node.parent.name;
          if (tag.type !== "JSXIdentifier" || !HOST_TAGS.has(tag.name)) return;

          // Fingerprint: flag only when ALL of {rounded, small px, small py,
          // interactive signal} hold.
          let hasRounded = false;
          let hasSmallPx = false;
          let hasSmallPy = false;
          let hasSignal = false;
          // Exclusions: skip if ANY structural escape is present — positioned
          // overlays (cluster H) escape structurally, named-pad tokens are the
          // sanctioned primitive escape.
          let excluded = false;
          for (const t of tokens) {
            if (ROUNDED.test(t)) hasRounded = true;
            if (SMALL_PX.has(t)) hasSmallPx = true;
            if (SMALL_PY.has(t)) hasSmallPy = true;
            if (t === "w-full" || t === "text-left" || HOVER_BG.test(t)) {
              hasSignal = true;
            }
            if (
              t === "absolute" ||
              t === "fixed" ||
              t === "sticky" ||
              NAMED_PAD.test(t)
            ) {
              excluded = true;
            }
          }

          if (excluded) return;
          if (!hasRounded || !hasSmallPx || !hasSmallPy || !hasSignal) return;

          // No auto-fix — report once on the whole attribute.
          context.report({ node, messageId: "adhocRow" });
        },
      };
    },
  });
}
