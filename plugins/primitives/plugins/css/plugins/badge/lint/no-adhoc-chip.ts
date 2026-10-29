import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { LintToolkit } from "@plugins/framework/plugins/tooling/plugins/lint/core";

const createRule = lintRuleCreator(import.meta.url);

/**
 * Ad-hoc chip/badge markup — an intrinsic `<span>/<div>/<button>` styled with a
 * `rounded` corner plus small `px-`/`py-` padding — reintroduces exactly the
 * inconsistency the chip primitives (Badge, ToggleChip/SegmentedControl,
 * FilterChip, LinkChip) exist to close. This rule fingerprints that shape and
 * redirects to a sanctioned primitive. There is no auto-fix: choosing the right
 * primitive + variant, mapping a dynamic color class to `colorClass`, and adding
 * an import are all unsafe to mechanize.
 *
 * Unlike `no-arbitrary-font-size` (whose target is a single class token, so it
 * scans each `Literal`/`TemplateElement` independently), the chip fingerprint is
 * a *co-occurrence* of several classes that may live in different `cn()`
 * fragments. So we aggregate every class token of one `className` attribute into
 * a single Set, then test the fingerprint against that Set.
 */

// rounded corner: `rounded`, `rounded-md`, `rounded-full`, …
const ROUNDED = /^rounded(-|$)/;
// small horizontal pad — EXACT membership (must NOT match `px-2.5`).
const SMALL_PX = new Set(["px-0.5", "px-1", "px-1.5", "px-2"]);
// small vertical pad — EXACT membership.
const SMALL_PY = new Set(["py-px", "py-0.5", "py-1"]);
// interactive-row marker: any `hover:bg-*` (menus/list rows, not chips).
const HOVER_BG = /^hover:bg-/;
// named padding token (e.g. `p-chip`, `p-card`) — the sanctioned token
// escape. Defensive: such tokens preclude raw px/py anyway, but listing them
// documents the escape hatch. `p-[a-z]` avoids matching numeric `p-2`.
const NAMED_PAD = /^p-[a-z]/;

const HOST_TAGS = new Set(["span", "div", "button"]);

export default function buildRule({ collectTokens }: LintToolkit) {
  return createRule({
    name: "no-adhoc-chip",
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow ad-hoc chip/badge markup (rounded + small px/py on a span/div/button) — use a sanctioned chip primitive.",
      },
      schema: [],
      messages: {
        adhocChip:
          "Ad-hoc chip/badge markup (rounded + small px/py on a span/div/button) is banned — " +
          "use a sanctioned primitive: Badge (static colored label/status, " +
          "@plugins/primitives/plugins/css/plugins/badge/web), ToggleChip/SegmentedControl (interactive on/off), " +
          "FilterChip (filter rows), or LinkChip (inline navigation). For a color from a dynamic " +
          "class map, pass colorClass to Badge. If this is intentionally not a chip (positioned " +
          "overlay, container), render it through a component or use a named padding token " +
          "(p-chip/p-card) instead of raw px-/py-.",
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

          // Host-tag gate: a JSXAttribute's parent is always the JSXOpeningElement.
          // Require an intrinsic host tag in {span, div, button}. This skips
          // component elements (`<Badge>`, `<Foo>` — capitalized, render through a
          // primitive) and other intrinsics (`<code>`, `<a>`, `<input>`) for free.
          const tag = node.parent.name;
          if (tag.type !== "JSXIdentifier" || !HOST_TAGS.has(tag.name)) return;

          // Aggregate every class token of this attribute into one Set.
          const tokens = new Set<string>();
          collectTokens(context.sourceCode, node.value, tokens);

          // Fingerprint: flag only when ALL THREE hold.
          let hasRounded = false;
          let hasSmallPx = false;
          let hasSmallPy = false;
          // Row/overlay exclusions: skip if ANY structural marker is present —
          // these separate chips from interactive rows / positioned overlays, the
          // buckets that have no primitive home yet.
          let excluded = false;
          for (const t of tokens) {
            if (ROUNDED.test(t)) hasRounded = true;
            if (SMALL_PX.has(t)) hasSmallPx = true;
            if (SMALL_PY.has(t)) hasSmallPy = true;
            if (
              t === "w-full" ||
              t === "text-left" ||
              t === "absolute" ||
              t === "fixed" ||
              t === "sticky" ||
              HOVER_BG.test(t) ||
              NAMED_PAD.test(t)
            ) {
              excluded = true;
            }
          }

          if (excluded) return;
          if (!hasRounded || !hasSmallPx || !hasSmallPy) return;

          // No auto-fix — report once on the whole attribute.
          context.report({ node, messageId: "adhocChip" });
        },
      };
    },
  });
}
