import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

/**
 * A transition names the properties it animates — never `transition-all`.
 *
 * `transition-all` animates EVERY property a class change touches, layout ones
 * included (`width`, `min-width`, `padding`, `gap`). A control whose form
 * changes (a narrow / wide label floor, an icon shown or hidden) then resizes
 * over frames instead of in one, and every host that measures it reads the
 * in-between sizes: the adaptive bar fitting a prototype frame's header
 * measured the version stepper mid-way from `min-w-14` to `min-w-25` each
 * frame, re-decided its form each frame, and flipped it back and forth at
 * ~55 commits/s for as long as the frame stayed at that width. It also
 * animates `visibility`, so a hidden control lingers for the transition.
 *
 * Name what moves: `transition-colors`, `transition-opacity`,
 * `transition-transform`, or `transition-[color,opacity,…]`. A size that is
 * meant to glide names its property too (`transition-[width,height]`).
 *
 * WHAT IS FLAGGED — a `transition-all` class token (with or without variant
 * prefixes, `hover:transition-all`) in any string or template literal.
 */
type MessageIds = "transitionAll";

// A class token: whitespace-delimited, optionally after variant prefixes. A
// quoted or backticked mention (prose about the class) is not one.
const TOKEN = /(?:^|[\s:])transition-all(?=$|\s)/;

export default createRule<[], MessageIds>({
  name: "no-transition-all",
  meta: {
    type: "problem",
    docs: {
      description:
        "Forbid `transition-all`: it animates layout properties, so a box measured by its host (an adaptive bar, a column fit) is read mid-transition and re-decided every frame.",
    },
    messages: {
      transitionAll:
        "`transition-all` animates every property a class change touches — layout ones (width, min-width, padding) included — so the box resizes over frames and any host measuring it reads in-between sizes and re-decides each frame (the prototype frame header's adaptive bar flipped the version stepper's form ~55×/s). It also animates `visibility`. Name the properties: `transition-colors`, `transition-opacity`, `transition-[color,opacity,…]`.",
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    const check = (node: TSESTree.Node, text: string): void => {
      if (TOKEN.test(text))
        context.report({ node, messageId: "transitionAll" });
    };
    return {
      Literal(node) {
        if (typeof node.value === "string") check(node, node.value);
      },
      TemplateElement(node) {
        check(node, node.value.raw);
      },
    };
  },
});
