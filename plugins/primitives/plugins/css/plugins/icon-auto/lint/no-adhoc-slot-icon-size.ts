import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { type TSESTree } from "@typescript-eslint/utils";
import type { LintToolkit } from "@plugins/framework/plugins/tooling/plugins/lint/core";

const createRule = lintRuleCreator(import.meta.url);

/**
 * Icons passed into an `icon=`/`leading=` slot of an auto-sizing primitive are
 * sized by that primitive via the `icon-auto` `@utility` (1.15em, tracks the slot
 * font-size). Hardcoding a `size-*`/`h-*`/`w-*` class on the glyph overrides that,
 * breaking the density-aware sizing the slot is meant to own.
 *
 * SCOPE — deliberately conservative; ZERO false positives is the priority. Fires
 * ONLY when ALL of these hold:
 *
 *   1. The attribute name is `icon` or `leading`.
 *   2. Its value is a `JSXExpressionContainer` wrapping an INLINE `JSXElement`
 *      literal (e.g. `icon={<MdFoo className="size-3" />}`). Identifiers, calls,
 *      conditionals, fragments are skipped — we never trace a variable.
 *   3. The element that OWNS the attribute is one of the auto-sizing primitives in
 *      `AUTO_SIZING_PARENTS` (matched by opening-element identifier name). Aliased
 *      imports (e.g. `RowPrimitive`) are intentionally NOT matched — accepted
 *      false negative.
 *   4. The slotted element is a BARE GLYPH: no children (self-closing/empty) AND
 *      its tag is either `svg` or a Capitalized component (`MdX`/`Icon`/…), never
 *      a lowercase intrinsic host (`span`/`div`/…). This rejects layout-box and
 *      spacer wrappers without needing an icon name list.
 *   5. Its `className` carries a hardcoded size token (`size-\d`/`h-\d`/`w-\d`
 *      after variant-prefix strip), as harvested by the shared class-token walk
 *      below — which also resolves a same-file object/array MAP alias indexed in
 *      a class context (e.g. `cn(MAP[key])`), but NOT a bare string `const`.
 *
 * Report-only, no autofix. This is a convention aid, not a guarantee — see the
 * plugin CLAUDE.md.
 */

const SLOT_NAMES = new Set(["icon", "leading"]);

// Primitives whose slot containers apply the `icon-auto` utility. KEEP IN SYNC
// with the primitives whose slot containers apply the icon-auto utility (Badge,
// Row, LinkChip, ToggleChip, Breadcrumb). Matched by the owning opening-element
// identifier name string only — aliased re-imports are an accepted false negative.
const AUTO_SIZING_PARENTS = new Set([
  "Badge",
  "Row",
  "LinkChip",
  "ToggleChip",
  "Breadcrumb",
]);

// Hardcoded icon-size markers: `size-3`, `size-3.5`, `h-4`, `w-4`, …. Numeric
// suffix required so `size-full`/`h-auto`/`w-fit` etc. are NOT matched.
const SIZE = /^size-\d/;
const H = /^h-\d/;
const W = /^w-\d/;

export default function buildRule({
  collectTokens,
  baseClass,
  CLASS_ATTRS,
}: LintToolkit) {
  return createRule({
    name: "no-adhoc-slot-icon-size",
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow hardcoded size-*/h-*/w-* on a bare inline glyph passed to the icon=/leading= slot of an auto-sizing primitive (Badge/Row/LinkChip/ToggleChip/Breadcrumb) — the slot auto-sizes it via the icon-auto utility.",
      },
      schema: [],
      messages: {
        adhocSlotIconSize:
          "Icon in an `icon=`/`leading=` slot is auto-sized by the primitive (icon-auto). " +
          "Remove the hardcoded size-*/h-*/w-* class; pass an explicit size only as a deliberate override.",
      },
    },
    defaultOptions: [],
    create(context) {
      return {
        JSXAttribute(node) {
          // 1. Slot gate: `icon=` or `leading=`.
          if (
            node.name.type !== "JSXIdentifier" ||
            !SLOT_NAMES.has(node.name.name)
          )
            return;

          // 3. Parent allow-list: the element that owns this attribute must be one
          // of the auto-sizing primitives. The attribute's parent is always the
          // JSXOpeningElement; match its identifier name.
          const ownerTag = node.parent.name;
          if (
            ownerTag.type !== "JSXIdentifier" ||
            !AUTO_SIZING_PARENTS.has(ownerTag.name)
          )
            return;

          // 2. Only an inline JSX element literal: `icon={<MdFoo .../>}`. Skip
          // identifiers, calls, conditionals, fragments — no variable tracing.
          if (node.value?.type !== "JSXExpressionContainer") return;
          const expr = node.value.expression;
          if (expr.type !== "JSXElement") return;

          // 4. The slotted element must be a BARE GLYPH:
          //   - no children (self-closing or empty body) — rejects layout-box
          //     wrappers like `<span className="size-3"><MdCheck/></span>`, and
          //   - tag is `svg` or a Capitalized component — rejects lowercase
          //     intrinsic host spacers/boxes (`<span/>`, `<div/>`).
          if (expr.children.length > 0) return;
          const slotTag = expr.openingElement.name;
          if (slotTag.type !== "JSXIdentifier") return;
          const isGlyph = slotTag.name === "svg" || /^[A-Z]/.test(slotTag.name);
          if (!isGlyph) return;

          // 5. Find the class-name attributes with an analyzable literal value in
          // the inline element's opening tag. Every one of them is aggregated, not
          // just the first: a glyph can carry both `className` and a `*ClassName`
          // pass-through, and a size hardcoded in either one is the same override.
          const classAttrs = expr.openingElement.attributes.filter(
            (a): a is TSESTree.JSXAttribute =>
              a.type === "JSXAttribute" &&
              a.name.type === "JSXIdentifier" &&
              CLASS_ATTRS.test(a.name.name),
          );
          if (classAttrs.length === 0) return;

          const tokens = new Set<string>();
          for (const attr of classAttrs)
            collectTokens(context.sourceCode, attr.value, tokens);
          if (tokens.size === 0) return; // not a simple analyzable className — skip.

          const hasHardcodedSize = [...tokens].some((t) => {
            const c = baseClass(t);
            return SIZE.test(c) || H.test(c) || W.test(c);
          });
          if (!hasHardcodedSize) return;

          context.report({ node, messageId: "adhocSlotIconSize" });
        },
      };
    },
  });
}
