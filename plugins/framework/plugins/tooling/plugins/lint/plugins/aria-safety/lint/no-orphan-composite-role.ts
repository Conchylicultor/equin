import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { type TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

/**
 * A composite ARIA role is a CONTRACT, not a label: `listbox` promises options,
 * `tablist` promises tabs, `grid` promises rows. Assistive tech honors the
 * promise — it presents the subtree as that widget and commonly DROPS whatever
 * is not one of the required children. So a composite role declared over a
 * subtree that has none of them is strictly worse than no role at all: it
 * announces an empty widget AND hides the real content behind it.
 *
 * That was the page editor's bug. The block-selection container carried
 * `role="listbox" aria-multiselectable`, nothing below it carried
 * `role="option"`, and the result was a screen reader reading an empty list of
 * options where a document of headings, lists and paragraphs actually lived.
 *
 * The pairing is knowable statically at the only altitude where it IS knowable
 * — the file that declares the container. This rule reads that altitude: a
 * container role must be joined, in the same file, by at least one element
 * carrying one of the child roles it requires.
 */

/** Composite container role → the child roles that make it honest. */
const REQUIRED_CHILD_ROLES = new Map<string, readonly string[]>([
  ["listbox", ["option"]],
  ["tablist", ["tab"]],
  ["tree", ["treeitem"]],
  ["treegrid", ["row"]],
  ["grid", ["row"]],
  ["menu", ["menuitem", "menuitemcheckbox", "menuitemradio"]],
  ["menubar", ["menuitem", "menuitemcheckbox", "menuitemradio"]],
  ["radiogroup", ["radio"]],
]);

/**
 * The literal role tokens of a `role=` attribute, or `[]` when the value is not
 * a plain string. ARIA allows a fallback list (`role="doc-toc list"`), so a
 * value contributes every whitespace-separated token.
 *
 * A computed `role={x}` is not analyzable, and guessing would fire on code the
 * rule cannot read — those are ignored on purpose.
 */
function literalRoles(node: TSESTree.JSXAttribute): string[] {
  const value = node.value;
  if (!value) return [];
  const literal =
    value.type === "Literal"
      ? value
      : value.type === "JSXExpressionContainer" &&
          value.expression.type === "Literal"
        ? value.expression
        : undefined;
  if (!literal || typeof literal.value !== "string") return [];
  return literal.value.split(/\s+/u).filter((token) => token.length > 0);
}

/** `role="menuitem" / "menuitemcheckbox" / "menuitemradio"` — for the message. */
function quoteRoles(roles: readonly string[]): string {
  return roles.map((role) => `role="${role}"`).join(" / ");
}

export default createRule({
  name: "no-orphan-composite-role",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow a composite ARIA role (listbox, tablist, tree, treegrid, grid, menu, menubar, radiogroup) declared in a file that carries none of the child roles that role requires — it announces an empty widget and hides the real content from screen readers.",
    },
    schema: [],
    messages: {
      orphanCompositeRole:
        'role="{{role}}" is a composite role, but nothing in this file carries {{children}}. Assistive tech presents the subtree as that widget and drops what is not a required child, so the container announces as empty AND the real content disappears — strictly worse than no role. Author the {{children}} children in this file, or drop the role for one that carries no child contract (e.g. role="group"). If the children genuinely live in another file or component, add `// eslint-disable-next-line aria-safety/no-orphan-composite-role -- <where the children are>` so that pairing is an explicit, reviewed decision.',
    },
  },
  defaultOptions: [],
  create(context) {
    /** Every literal role token seen anywhere in the file. */
    const rolesInFile = new Set<string>();
    /** Container declarations, held until the whole file has been read. */
    const containers: { node: TSESTree.JSXAttribute; role: string }[] = [];

    return {
      JSXAttribute(node: TSESTree.JSXAttribute) {
        if (node.name.type !== "JSXIdentifier" || node.name.name !== "role")
          return;

        for (const role of literalRoles(node)) {
          rolesInFile.add(role);
          if (REQUIRED_CHILD_ROLES.has(role)) containers.push({ node, role });
        }
      },

      // The children may be authored BELOW the container, so the verdict can
      // only be reached once the whole file has been walked.
      "Program:exit"() {
        for (const { node, role } of containers) {
          const required = REQUIRED_CHILD_ROLES.get(role);
          if (!required) continue;
          if (required.some((child) => rolesInFile.has(child))) continue;
          context.report({
            node,
            messageId: "orphanCompositeRole",
            data: { role, children: quoteRoles(required) },
          });
        }
      },
    };
  },
});
