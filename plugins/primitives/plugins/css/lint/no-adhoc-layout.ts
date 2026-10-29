import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";
import type { LintToolkit } from "@plugins/framework/plugins/tooling/plugins/lint/core";

const createRule = lintRuleCreator(import.meta.url);

/**
 * Layout-composition guardrail — the last unguarded design dimension.
 *
 * Layout is the one axis with no semantic primitive and no enforcement, so the
 * overlap/clip bug class keeps reopening: every call site re-derives a global
 * space-sharing negotiation by hand with raw `flex … min-w-0 shrink-0 flex-1`
 * soup. The cure is the same one the sibling `no-adhoc-*` rules already prove:
 * redirect raw utilities to a closed set of semantic primitives.
 *
 * This rule bans the raw layout utilities — composition mechanics that belong
 * to a primitive, not to a per-element `className`:
 *
 *   - flow / display:  `flex`, `inline-flex`, `flex-1`, `flex-col`, `flex-wrap`,
 *                      `flex-none`, `basis-*`, `grid`, `inline-grid`,
 *                      `grid-cols-*`, `grid-flow-*`, `col-span-*`, `row-span-*`
 *   - space-sharing:   `shrink-*`, `grow-*`, `min-w-0` (the truncation-leaf footgun)
 *   - alignment:       `items-*`, `justify-*`, `place-*` (container-wide:
 *                      `<Stack align justify>`) · `self-*` (ONE child's override:
 *                      `selfClass(align)`, css/plugins/spacing)
 *   - positioning:     `absolute`, `fixed`, `sticky`, `inset-*`
 *   - clipping:        `overflow-*`
 *
 * Compose these through the layout primitives instead — one primitive per
 * mechanic, all under `@plugins/primitives/plugins/css/plugins/<name>/web`:
 *   - rows / flow:      `<Line>` (bare single-line strip) · `<Row>` (interactive
 *                       row) · `<Stack direction="row">` · `<Cluster>` (wrapping
 *                       chips) · `<Inline>` (chips mid-sentence)
 *   - columns / panes:  `<Column header body footer>` — rigid | flexible | rigid
 *   - space-sharing:    two independent questions — does the cell TAKE slack, and
 *                       does it GIVE below its own content. `<Fill>` answers yes
 *                       to both (`min-w-0 flex-1`) · `<Rigid>` no to both
 *                       (`shrink-0`) · `yieldClass(axis)` gives only (`min-w-0`)
 *                       · `growClass()` takes only (`flex-1`) · `<Text>` inside a
 *                       line container — THE truncation leaf
 *   - grids / centring: `<Grid minCellWidth>` · `<Center axis>`
 *   - overflow:         `<Scroll>` (scrolls) · `<Clip>` (clips, no scroll)
 *   - positioning:      `<Overlay>` (in-flow full-bleed layers) · `<Layer>` (ONE
 *                       standalone `absolute inset-0` child) · `<Pin to>`
 *                       (point-anchored child, semantic-ramp offsets) ·
 *                       `<Sticky edge>` · `ViewportOverlay` (true `fixed inset-0`)
 *   - coordinates:      `<Placed x y>` — a box placed by RUNTIME numbers
 *                       (css/plugins/coords). Pin's data-driven sibling.
 *   - padding / gap:    `<Inset pad>` / `<Stack gap>` (css/plugins/spacing/web)
 *
 * When the element cannot be WRAPPED (a third-party `className`-only prop, a
 * Lexical `<ContentEditable>`, a raw `<img>`/`<svg>`/`<button>` leaf that must
 * ITSELF be the box), take the class string instead of the component:
 * `fillClasses(axis)`, `rigidClass()`, `yieldClass(axis)`, `growClass()`,
 * `layerClasses(opts)`, `insetClass(step)`. Own the element ⇒ the component;
 * don't own it ⇒ the class helper. Neither supersedes the other. `yield`/`grow`
 * are helper-ONLY: they annotate how a box you already have shares space with
 * its siblings, so there is never anything to wrap.
 *
 * NOT banned (deliberately): `relative` / `static` (positioning *context* is
 * benign — Overlay establishes it), sizing (`w-*`, `h-*`, `size-*`, `min-w-*`
 * other than `min-w-0`), display values that aren't flow containers (`block`,
 * `hidden`, `inline`). Spacing (`gap-*`/`p-*`/`m-*`) and `z-*` have their own
 * rules — this one stays out of their lane to avoid double-reporting.
 *
 * No auto-fix: picking the right primitive (and the right slot) is a per-site
 * judgement, exactly like `no-adhoc-spacing`.
 *
 * Class strings are inspected only in a class-name context — a `className`/
 * `class`/`*ClassName` attribute value or a `cn(...)`/`clsx(...)`/`twMerge(...)`
 * argument — so a doc-string that merely mentions `flex` is never flagged. From
 * such a context the walk follows same-file aliases, so a class string parked in
 * a `const` or a style map is reached too; it is the ONE walk every class rule
 * is handed (`tooling/plugins/lint/core/class-token-walk.ts`), not a copy that
 * can drift behind its siblings — which is what this rule's own copy had done.
 */

// Position keywords. `relative`/`static` are NOT banned — they merely establish
// a positioning context (which Overlay owns) and are harmless on their own.
const POSITION = /^(?:absolute|fixed|sticky)$/;
// Inset offsets: `inset-0`, `inset-x-2`, `inset-y-full`, `inset-[3px]`. Guard the
// value so `inset-ring-*` (a box-shadow utility, not positioning) is NOT matched.
const INSET = /^inset(?:-x|-y)?-(?:\d|px|auto|full|\[)/;
// Flex family: `flex`, `inline-flex`, and every `flex-*` (flex-1/col/row/wrap/
// none/auto/initial/grow/shrink), plus `basis-*`.
const FLEX = /^(?:flex|inline-flex)$|^flex-|^basis-/;
// Grid family: `grid`, `inline-grid`, every `grid-*`, and grid placement
// (`col-span-*`, `col-start-*`, `row-end-*`, `col-auto`, …).
const GRID =
  /^(?:grid|inline-grid)$|^grid-|^(?:col|row)-(?:span|start|end|auto)/;
// Flex-child sizing. `flex-grow`/`flex-shrink` are already caught by FLEX.
const SHRINK_GROW = /^(?:shrink|grow)(?:-|$)/;
// The truncation-leaf footgun — min-width:0 at the wrong altitude is the churn.
// Only `min-w-0` (other `min-w-*` sizing is allowed).
const MIN_W_0 = /^min-w-0$/;
// Alignment / distribution.
const ALIGN = /^items-/;
const JUSTIFY = /^justify-/;
const SELF = /^self-/;
// `place-items|content|self-*` — the `(items|content|self)` guard keeps the
// regex off `placeholder-*` (a color utility), which also starts with `place`.
const PLACE = /^place-(?:items|content|self)-/;
// Overflow / clip — scroll-container concerns. A genuine scroll container is
// `<Scroll>` (the css/scroll primitive owns overflow + the flex-child fill
// policy); a clipped, non-scrolling box is `<Clip>`.
const OVERFLOW = /^overflow-/;

const LAYOUT_PATTERNS = [
  POSITION,
  INSET,
  FLEX,
  GRID,
  SHRINK_GROW,
  MIN_W_0,
  ALIGN,
  JUSTIFY,
  SELF,
  PLACE,
  OVERFLOW,
];

/**
 * Read a static string from a `style` ObjectExpression property's KEY, so both
 * `position` (Identifier) and `"position"` (string Literal) keys are matched.
 * Returns null for computed/dynamic keys (which we can't statically resolve).
 */
function staticPropKey(prop: TSESTree.Property): string | null {
  if (prop.computed) return null;
  if (prop.key.type === "Identifier") return prop.key.name;
  if (prop.key.type === "Literal" && typeof prop.key.value === "string")
    return prop.key.value;
  return null;
}

export default function buildRule({
  collectTokens,
  baseClass,
  CLASS_ATTRS,
  CLASS_BUILDERS,
}: LintToolkit) {
  return createRule({
    name: "no-adhoc-layout",
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow raw Tailwind layout utilities (flex/grid/positioning/alignment/overflow). Compose layout through the css layout primitives — <Line>/<Row>/<Stack>/<Cluster>/<Inline>, <Column>, <Fill>/<Rigid>/<Text>, <Grid>/<Center>, <Scroll>/<Clip>, <Overlay>/<Layer>/<Pin>/<Sticky>, <Inset> — or, when the element cannot be wrapped, their class-string helpers.",
      },
      schema: [],
      messages: {
        // The indexed list is HARDCODED, not derived from a registry: lint rules
        // dual-load under jiti, which cannot resolve `@plugins/*`. The
        // `css:message-names-primitives` check (plugins/primitives/plugins/css/check)
        // reads the css/plugins/* DIRECTORY LISTING and fails if a layout-mechanic
        // primitive is missing from this text, so the list cannot silently rot.
        adhocLayout:
          "Raw layout class `{{token}}` is banned — write the role, not the mechanics.\n" +
          "Pick the primitive that owns the mechanic (all under @plugins/primitives/plugins/css/plugins/<name>/web):\n" +
          '  rows / flow       <Line> single-line strip · <Row> interactive row · <Stack direction="row"> · <Cluster> wrapping chips · <Inline> chips mid-sentence\n' +
          "  columns / panes   <Column header body footer> — rigid | flexible | rigid, scrolling body\n" +
          "  space-sharing     two questions — does it TAKE slack, does it GIVE below its own content:\n" +
          "                    <Fill> both (min-w-0 flex-1) · <Rigid> neither (shrink-0) · yieldClass(axis) gives only (min-w-0) · growClass() takes only (flex-1) · <Text> in a line container — THE truncation leaf\n" +
          "  grids / centring  <Grid minCellWidth> · <Center axis>\n" +
          "  overflow          <Scroll axis fill> scrolls · <Clip axis> clips, no scroll\n" +
          "  positioning       <Overlay> in-flow full-bleed layers · <Layer> ONE standalone absolute inset-0 child · <Pin to> point-anchored child, offsets on the semantic ramp · <Sticky edge> · ViewportOverlay for true fixed inset-0\n" +
          "  coordinates       <Placed x y> — a box placed by RUNTIME numbers (%, px, a measured DOMRect): Gantt bars, windowed-row offsets, crop rects, editor decorations (css/plugins/coords). pct(fraction) writes the %. Its host is <Layer>, <Clip>, or any `relative` box — there is no separate plane primitive.\n" +
          "  padding / gap     <Inset pad> · <Stack gap>  (css/plugins/spacing/web)\n" +
          "When you cannot wrap the element (a third-party `className` prop, a Lexical `ContentEditable`, a raw <img>/<svg>/<button> leaf that must ITSELF be the box), " +
          "take the class string instead: fillClasses(axis), rigidClass(), yieldClass(axis) [css/plugins/yield], growClass() [css/plugins/grow], layerClasses({layer,decorative}), placedStyle(x, y) [css/plugins/coords], insetClass(step), selfClass(align) [css/plugins/spacing].\n" +
          "yield/grow/self ship NO component on purpose — yield/grow annotate a box you already have (a Stack/Line/Text), so there is nothing to wrap; selfClass is the opposite, a wrapper would BECOME the flex item and take the alignment itself.\n" +
          "A genuine one-off escapes per-site with `// eslint-disable-next-line layout/no-adhoc-layout -- <reason>`.",
        adhocStylePosition:
          'Inline `position: "{{value}}"` is banned — anchor a cursor menu via CursorAnchoredMenu ' +
          "(@plugins/primitives/plugins/overlay/plugins/cursor-menu/web), collapse an overflowing bar via AdaptiveBar " +
          "(@plugins/primitives/plugins/adaptive-bar/web), or compose fixed/absolute through " +
          "<Overlay>/<Pin>/ViewportOverlay. Genuine one-off: " +
          "`// eslint-disable-next-line layout/no-adhoc-layout -- <reason>`.",
      },
    },
    defaultOptions: [],
    create(context) {
      function checkTokens(node: TSESTree.Node, tokens: Set<string>) {
        for (const token of tokens) {
          const c = baseClass(token);
          if (LAYOUT_PATTERNS.some((re) => re.test(c))) {
            context.report({
              node,
              messageId: "adhocLayout",
              data: { token: c },
            });
          }
        }
      }

      /**
       * Scan an inline `style={{ … }}` object for a banned `position` literal.
       *
       * Why inline style is scanned at all: the class-token ban above only reads
       * `className`/`cn()` strings, so the inline-`style` form
       * (`style={{ position: "fixed" }}`) slipped through entirely. That is the
       * exact unguarded path the desktop/window context-menu shift bug shipped on
       * (a zero-size `position: fixed` anchor that resolved against a transformed
       * ancestor instead of the viewport). We scope strictly to the `position`
       * property's string value — `relative`/`static` stay benign via POSITION,
       * and we deliberately ignore `top`/`left`/`inset`/etc. (legit offsets on a
       * sanctioned fixed/absolute child), since `position` is the discriminating
       * token. Dynamic values, spreads, and imperative `el.style.position` are not
       * caught — the same literal-only limit as the class path.
       */
      function checkStyle(node: TSESTree.JSXAttribute) {
        if (node.value?.type !== "JSXExpressionContainer") return;
        const expr = node.value.expression;
        if (expr.type !== "ObjectExpression") return;
        for (const prop of expr.properties) {
          if (prop.type !== "Property") continue;
          if (staticPropKey(prop) !== "position") continue;
          if (
            prop.value.type !== "Literal" ||
            typeof prop.value.value !== "string"
          )
            continue;
          const value = prop.value.value;
          if (POSITION.test(value)) {
            context.report({
              node: prop,
              messageId: "adhocStylePosition",
              data: { value },
            });
          }
        }
      }

      return {
        JSXAttribute(node) {
          if (node.name.type !== "JSXIdentifier") return;
          if (CLASS_ATTRS.test(node.name.name)) {
            const tokens = new Set<string>();
            collectTokens(context.sourceCode, node.value, tokens);
            checkTokens(node, tokens);
          } else if (node.name.name === "style") {
            checkStyle(node);
          }
        },
        CallExpression(node) {
          if (
            node.callee.type !== "Identifier" ||
            !CLASS_BUILDERS.has(node.callee.name)
          ) {
            return;
          }
          const tokens = new Set<string>();
          for (const arg of node.arguments)
            collectTokens(context.sourceCode, arg, tokens);
          checkTokens(node, tokens);
        },
      };
    },
  });
}
