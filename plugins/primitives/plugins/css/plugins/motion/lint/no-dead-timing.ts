import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";
import type { LintToolkit } from "@plugins/framework/plugins/tooling/plugins/lint/core";

const createRule = lintRuleCreator(import.meta.url);

/**
 * A timing class times something on its own element.
 *
 * `duration-*`, `ease-*` and `delay-*` only set the timing of a transition or
 * an animation: they move nothing by themselves. Since app.css's base layer
 * sets `transition-property: none` on every element (`df784f9291`), a timing
 * class with no `transition-*` / `animate-*` (or a custom `@utility` that
 * declares a transition or an animation, `overlay-enter`) beside it is DEAD —
 * and worse than dead, it reads as motion that is there. Before that line, the
 * same `duration-100` on the popover panel silently transitioned EVERY property
 * (CSS's initial `transition-property: all`), so the control panel's width
 * glided when a page needed a wider bucket; the base rule removed that glide
 * and nothing said so, because the class still read as if it timed something.
 *
 * Judged per element: the classes of one intrinsic element's `className`
 * (every branch of its `cn()` together, same-file aliases followed). A
 * component's `className` is not judged — the component may add the
 * transition itself (`SheetContent` carries `transition`, so a caller's
 * `duration-300` times it). Classes retargeted to a pseudo-element or the
 * children (`after:`, `*:`) are judged apart from the element's own.
 *
 * Fix: name what moves (`transition-opacity`, `transition-[width,height]`) —
 * or, for a surface whose size should follow its content, `useSizeMotion`
 * (`Surface` floating levels and `OverlayPanel` already have it) — or delete
 * the timing class.
 */
type MessageIds = "deadTiming";

const TIMING = /^(?:duration|ease|delay)-/;

export default function buildRule({
  collectTokens,
  ownClass,
  declaredUtilities,
}: LintToolkit) {
  /** Does this class start a transition or an animation on its element? */
  const moves = (cls: string): boolean => {
    if (cls === "transition-none" || cls === "animate-none") return false;
    if (cls === "transition" || cls.startsWith("transition-")) return true;
    if (cls.startsWith("animate-")) return true;
    return declaredUtilities.get(cls)?.animates === true;
  };

  return createRule<[], MessageIds>({
    name: "no-dead-timing",
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow `duration-*` / `ease-*` / `delay-*` on an element with no `transition-*` / `animate-*` (or animating @utility): it times nothing, since nothing transitions unless it names what.",
      },
      messages: {
        deadTiming:
          "`{{token}}` times nothing: this element has no `transition-*`, `animate-*` or animating @utility, and app.css's base layer sets `transition-property: none` — nothing transitions unless it names what. " +
          "Name what moves (`transition-opacity`, `transition-[width,height]`); for a surface whose size should follow its content use `useSizeMotion` (@plugins/primitives/plugins/css/plugins/motion/web); or delete the class.",
      },
      schema: [],
    },
    defaultOptions: [],
    create(context) {
      return {
        JSXAttribute(node: TSESTree.JSXAttribute) {
          if (
            node.name.type !== "JSXIdentifier" ||
            (node.name.name !== "className" && node.name.name !== "class")
          )
            return;
          // An intrinsic element only: a component may add its own transition.
          const opening = node.parent;
          if (
            opening.type !== "JSXOpeningElement" ||
            opening.name.type !== "JSXIdentifier" ||
            !/^[a-z]/.test(opening.name.name)
          )
            return;
          const tokens = new Set<string>();
          collectTokens(context.sourceCode, node.value, tokens);
          const own = [...tokens]
            .map((t) => ownClass(t)?.replace(/^!|!$/g, ""))
            .filter((c): c is string => c !== undefined);
          if (own.some(moves)) return;
          const reported = new Set<string>();
          for (const cls of own) {
            if (!TIMING.test(cls) || reported.has(cls)) continue;
            reported.add(cls);
            context.report({
              node,
              messageId: "deadTiming",
              data: { token: cls },
            });
          }
        },
      };
    },
  });
}
