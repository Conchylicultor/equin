import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

/**
 * Naming a HORIZONTAL arrow command is the proxy for "this file moves a caret
 * sideways". It is a proxy, and the bound is stated rather than hidden: a mover
 * that relocates the caret from a `beforeinput`, paste or pointer handler slips
 * through. That is acceptable — those are not crossings, and landing on the
 * un-crossed state is correct for them.
 *
 * The check is at MODULE level ("names the command"), not at the
 * `registerCommand(...)` call site, because registration is routinely indirect:
 * the page editor registers all eight of its keys through a local `reg` helper,
 * which a call-site rule would silently miss — a rule that catches nothing is
 * the same failure as one that fires wrongly.
 */
const HORIZONTAL_ARROW_COMMANDS = new Set([
  "KEY_ARROW_LEFT_COMMAND",
  "KEY_ARROW_RIGHT_COMMAND",
]);

// Hardcoded, not imported: lint rule modules are loaded by jiti, which cannot
// resolve the `@plugins/*` alias, so a rule must not import cross-plugin.
const CARET_MOTION_BARREL =
  "@plugins/primitives/plugins/text-editor/plugins/caret-motion/web";

/** Either arm satisfies the rule: it moves carets, or it observes crossings. */
const CARET_MOTION_APIS = new Set([
  "crossCaret",
  "announceCaretCrossing",
  "CARET_CROSSED_COMMAND",
]);

function importedName(spec: TSESTree.ImportClause): string | null {
  if (spec.type !== "ImportSpecifier") return null;
  return spec.imported.type === "Identifier" ? spec.imported.name : null;
}

export default createRule({
  name: "no-unannounced-caret-move",
  meta: {
    type: "problem",
    docs: {
      description:
        "A file handling ArrowLeft/ArrowRight must speak the caret-crossing " +
        "channel — announce the crossings it makes, or observe the ones others make.",
    },
    schema: [],
    messages: {
      unannouncedCaretMove:
        "`{{command}}` is handled here, but this file does not use the " +
        "caret-crossing channel. A horizontal-arrow handler IS a caret mover: " +
        "import `crossCaret` / `announceCaretCrossing` from " +
        "`@plugins/primitives/plugins/text-editor/plugins/caret-motion/web` and " +
        "declare each crossing in the direction of travel (or import " +
        "`CARET_CROSSED_COMMAND` if this file observes crossings instead). A " +
        "crossing that is never announced is invisible to every consumer of a " +
        "synthesized caret position — the defect this channel exists to close.",
    },
  },
  defaultOptions: [],
  create(context) {
    const arrowImports: { node: TSESTree.Node; command: string }[] = [];
    let usesCaretMotion = false;

    return {
      ImportDeclaration(node) {
        if (node.source.value === CARET_MOTION_BARREL) {
          for (const spec of node.specifiers) {
            const name = importedName(spec);
            if (name !== null && CARET_MOTION_APIS.has(name)) {
              usesCaretMotion = true;
            }
          }
          return;
        }
        if (node.source.value !== "lexical") return;
        for (const spec of node.specifiers) {
          const name = importedName(spec);
          if (name !== null && HORIZONTAL_ARROW_COMMANDS.has(name)) {
            arrowImports.push({ node: spec, command: name });
          }
        }
      },
      "Program:exit"() {
        if (usesCaretMotion) return;
        for (const { node, command } of arrowImports) {
          context.report({
            node,
            messageId: "unannouncedCaretMove",
            data: { command },
          });
        }
      },
    };
  },
});
