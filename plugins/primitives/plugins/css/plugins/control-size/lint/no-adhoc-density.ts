import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { LintToolkit } from "@plugins/framework/plugins/tooling/plugins/lint/core";

const createRule = lintRuleCreator(import.meta.url);

/**
 * Density-control guardrail.
 *
 * The density-participating control primitives (`Button`, `IconButton`,
 * `Badge`, `ToggleChip`, `Avatar`, `Input`, `SelectTrigger`, …) derive their size from the ambient
 * `ControlSize` context (`useControlSize()`), set ONCE on a region via
 * `<ControlSizeProvider size>` or a size-owning slot's `controlSize`. They have
 * NO per-instance density: there is no `size` prop, and there's no hand-written
 * height class either.
 *
 * This rule fingerprints the two ways that ambient density is escaped per
 * instance — both relocations of the same removed `size` prop:
 *
 *   - A `size=` prop on a density primitive. The type lock (`size?: never`)
 *     already removes it; this rule catches it at the lint layer (and on aliased
 *     re-imports the type lock can't see).
 *
 *   - A fixed height/size class on a density primitive: a `className` carrying a
 *     `h-N`/`size-N`/`control-*`/`control-icon-*` base-class. `className="size-6"`
 *     IS the `xs` control height written by hand — the same per-instance density
 *     escape, just moved to the class string. Height is ambient, so a per-instance
 *     override desyncs the control from its neighbors. Only digit-led `h-`/`size-`
 *     and the `control-*` scale match — `min-h-0`, `h-auto`, `h-full`, `size-full`,
 *     fixed *width* (`w-N`), margins, and colors stay legal; only height/density is
 *     owned by the scale.
 *
 * Primitives are matched by opening-element identifier name only — an aliased
 * import is an accepted false negative, mirroring the sibling no-adhoc-* rules.
 * No auto-fix: removing the override + setting region density is unsafe to
 * mechanize.
 */

// KEEP IN SYNC with the primitives that intersect `DensityControlled` (the
// density-participating control primitives that derive size from useControlSize).
const DENSITY_PRIMITIVES = new Set([
  "Button",
  "IconButton",
  "PaneIconAction",
  "Badge",
  "ToggleChip",
  "SegmentedControl",
  "LinkChip",
  "FilterChip",
  "Avatar",
  "StatusDot",
  "BouncingDots",
  // Fields: the same height/padding/gap bundle as `Button` (`fieldSizeClassFor`).
  "Input",
  "SelectTrigger",
  "SidebarInput",
  "SearchInput",
  "FilterValueInput",
]);

// Per-instance height/density markers (base-class-stripped). A per-instance
// height IS the relocated density escape. Numeric suffix required for h-/size-
// so `h-auto`, `h-full`, `size-full`, widths, margins, colors stay legal.
const FIXED_HEIGHT = /^h-\d/;
const FIXED_SIZE = /^size-\d/;
const CONTROL_SCALE = /^control-(xs|sm|md|lg)$/;
const CONTROL_ICON_SCALE = /^control-icon-(xs|sm|md|lg)$/;

export default function buildRule({
  collectTokens,
  ownClass,
  CLASS_ATTRS,
}: LintToolkit) {
  return createRule({
    name: "no-adhoc-density",
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow a per-instance density/size override (a size= prop or a fixed h-*/size-*/control-* class) on the density-participating control primitives (Button/IconButton/Badge/ToggleChip/Avatar/…). They derive size from ambient control density; set it once per region via <ControlSizeProvider size> or a slot's controlSize.",
      },
      schema: [],
      messages: {
        densitySizeProp:
          "Density control primitives derive size from ambient control density — they have no per-instance `size`. Remove the `size` prop and set density on the region via `<ControlSizeProvider size>` (or a slot's `controlSize`).",
        densitySizeClass:
          "Height/size comes from ambient control density, not a per-instance class. Drop the `h-*`/`size-*`/`control-*` and set density on the region via `<ControlSizeProvider size>` (or a slot's `controlSize`).",
      },
    },
    defaultOptions: [],
    create(context) {
      return {
        JSXAttribute(node) {
          if (node.name.type !== "JSXIdentifier") return;

          // The attribute's parent is always the JSXOpeningElement; match its
          // identifier name against the density-primitive allowlist. Aliased
          // imports are an accepted false negative.
          const tag = node.parent.name;
          if (tag.type !== "JSXIdentifier") return;
          if (!DENSITY_PRIMITIVES.has(tag.name)) return;

          // A `size=` prop is the per-instance density escape directly.
          if (node.name.name === "size") {
            context.report({ node, messageId: "densitySizeProp" });
            return;
          }

          // A fixed height/size/control-* class is the relocated density escape —
          // in `className`, or forwarded through a `*ClassName` pass-through prop.
          if (CLASS_ATTRS.test(node.name.name)) {
            const tokens = new Set<string>();
            collectTokens(context.sourceCode, node.value, tokens);
            const hasDensityClass = [...tokens].some((t) => {
              const c = ownClass(t);
              return (
                c !== undefined &&
                (FIXED_HEIGHT.test(c) ||
                FIXED_SIZE.test(c) ||
                CONTROL_SCALE.test(c) ||
                  CONTROL_ICON_SCALE.test(c))
              );
            });
            if (hasDensityClass)
              context.report({ node, messageId: "densitySizeClass" });
            return;
          }
        },
      };
    },
  });
}
