import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { LintToolkit } from "@plugins/framework/plugins/tooling/plugins/lint/core";

const createRule = lintRuleCreator(import.meta.url);

/**
 * Control-size standardization guardrail.
 *
 * Every interactive control's height must come from ONE source of truth: the
 * shared `control-*` height scale, applied through the sanctioned primitives.
 * `<Button>`/`<IconButton>` (single actions) and `<ButtonGroup>` (split /
 * segmented controls) are the ONLY way to size a control — they read the
 * `control-*` scale internally, so a control's chrome (height, padding, radius)
 * stays consistent across the whole app and moves in lockstep when the scale
 * changes.
 *
 * Two divergence escape hatches reintroduce the inconsistency the primitives
 * exist to close, and this rule fingerprints both:
 *
 *   A. Importing `buttonVariants` to paint a non-button element to look like a
 *      button — the "style anything like a button" hatch. The class string it
 *      emits is opaque to lint, so the only durable guard is banning the import.
 *      `button.tsx` DEFINES `buttonVariants` locally (via `cva`) rather than
 *      importing it, so it never trips this check; nothing else legitimately
 *      imports it.
 *
 *   B. Hand-rolling a button: a raw `<button>`/`<a>` styled with a fixed height
 *      + horizontal padding + rounded corners — the geometric signature of a
 *      control whose size was authored by hand instead of inherited from the
 *      `control-*` scale. An icon-only `p-0.5 rounded` close button has no fixed
 *      height and no horizontal padding, so it is NOT flagged here — that shape
 *      stays the domain of `badge/no-adhoc-chip` / `row`.
 *
 * The per-instance density escape on the sized PRIMITIVES themselves (a `h-N`/
 * `size-N`/`control-*` class on `<Button>`/`<IconButton>`/… , the relocated
 * `size` prop) is the domain of the sibling `no-adhoc-density` rule.
 *
 * Neither of these checks has an auto-fix: choosing the right primitive + region
 * density and adding the import are unsafe to mechanize.
 */

// Fixed-height marker: `h-7`, `h-6`, … or the `size-*` shorthand `size-8`, ….
const FIXED_HEIGHT = /^h-\d/;
const FIXED_SIZE = /^size-\d/;
// Horizontal padding: `px-*`, `pl-*`, or `pr-*`.
const PX = /^px-/;
const PL = /^pl-/;
const PR = /^pr-/;
// Rounded corner: `rounded`, `rounded-md`, `rounded-full`, ….
const ROUNDED = /^rounded(-|$)/;

const HOST_TAGS = new Set(["button", "a"]);

export default function buildRule({
  collectTokens,
  ownClass,
  CLASS_ATTRS,
}: LintToolkit) {
  return createRule({
    name: "no-adhoc-control",
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow divergent/hand-rolled controls: importing buttonVariants, or a raw button/a styled with fixed height + horizontal padding + rounded. Size controls through <Button>/<IconButton>/<ButtonGroup> and the shared control-* scale, set once per region.",
      },
      schema: [],
      messages: {
        noButtonVariants:
          "Do not import `buttonVariants`. Style through the <Button> primitive (or <ButtonGroup> for split/segmented controls); applying buttonVariants to a non-button element is the divergence escape hatch this rule prevents.",
        adhocControl:
          "Hand-rolled button detected (fixed height + horizontal padding + rounded). Use <Button>/<IconButton> for actions, or <ButtonGroup> for split/segmented controls, so size comes from the shared control-size scale.",
      },
    },
    defaultOptions: [],
    create(context) {
      return {
        // Check A — ban `buttonVariants` imports from the button primitive.
        ImportDeclaration(node) {
          const source = node.source.value;
          if (typeof source !== "string") return;
          // Match the canonical `@/components/ui/button` and any specifier that
          // resolves to the same module (e.g. a relative `../components/ui/button`).
          if (
            source !== "@/components/ui/button" &&
            !source.endsWith("/components/ui/button")
          ) {
            return;
          }
          for (const spec of node.specifiers) {
            if (
              spec.type === "ImportSpecifier" &&
              spec.imported.type === "Identifier" &&
              spec.imported.name === "buttonVariants"
            ) {
              context.report({ node: spec, messageId: "noButtonVariants" });
            }
          }
        },

        // Check B — inspect a class-name attribute on a raw <button>/<a>.
        JSXAttribute(node) {
          // Only class-name attributes (`className`/`class`, or a `*ClassName`
          // pass-through prop).
          if (
            node.name.type !== "JSXIdentifier" ||
            !CLASS_ATTRS.test(node.name.name)
          )
            return;

          // A JSXAttribute's parent is always the JSXOpeningElement.
          const tag = node.parent.name;
          if (tag.type !== "JSXIdentifier") return;

          // Check B — ban hand-rolled buttons (raw <button>/<a> styled like a
          // control). Require an intrinsic host tag in {button, a}.
          if (!HOST_TAGS.has(tag.name)) return;

          // Aggregate every class token of this attribute, keeping only the
          // utilities on the element's own box: `hover:rounded-full` counts as
          // `rounded-full`, but `after:h-0.5 after:rounded-full` (an underline
          // drawn on ::after) is the pseudo-element's shape, not the button's.
          const raw = new Set<string>();
          collectTokens(context.sourceCode, node.value, raw);
          const own = [...raw].flatMap((t) => ownClass(t) ?? []);

          const hasHeight = own.some(
            (c) => FIXED_HEIGHT.test(c) || FIXED_SIZE.test(c),
          );
          const hasPadX = own.some(
            (c) => PX.test(c) || PL.test(c) || PR.test(c),
          );
          const hasRounded = own.some((c) => ROUNDED.test(c));

          // Fingerprint: flag only when ALL THREE co-occur.
          if (!hasHeight || !hasPadX || !hasRounded) return;

          context.report({ node, messageId: "adhocControl" });
        },
      };
    },
  });
}
